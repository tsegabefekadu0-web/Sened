import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/supabaseServer";
import { createProductionReconciliationCoordinator } from "./server";
import { drainReconciliationQueue, type ReconciliationCoordinator } from "./reconciliation";

/**
 * `POST /api/reconciliation/drain`: the scheduler's entry point to the queue.
 *
 * AUTH. This is not a user route. It is called by a cron with a dedicated
 * shared secret (`RECONCILIATION_CRON_SECRET`, `Authorization: Bearer ...`).
 * The secret is read per request, compared in constant time, and the route
 * fails closed: no (or a too-short) secret configured is 503 and nothing runs;
 * a missing or wrong one is 401. A user's Supabase JWT is not accepted here.
 *
 * DATABASE ROLE. The queue RPCs (`claim`/`reschedule`/`finalize`) are granted
 * to `service_role` only, so the drain needs the service-role key
 * (`SUPABASE_SERVICE_ROLE_KEY`, server-only). That client is created inside
 * this module's default factory and passed nowhere else.
 *
 * BOUNDS. One call claims at most `RECONCILIATION_DRAIN_MAX_JOBS` jobs and
 * stops starting new ones after `RECONCILIATION_DRAIN_BUDGET_MS`. A job already
 * claimed is finished, so worst case is budget + one provider call.
 *
 * CONCURRENCY. Overlapping invocations are safe: the claim RPC selects with
 * `for update skip locked` and stamps a lease token, and reschedule/finalize
 * refuse unless worker id and token match. Two drains cannot hold one job; a
 * crashed drain's job becomes claimable again when its lease expires.
 */

const MIN_SECRET_LENGTH = 32;
const DEFAULT_MAX_JOBS = 25;
const MAX_MAX_JOBS = 100;
const DEFAULT_BUDGET_MS = 20_000;
const MIN_BUDGET_MS = 1_000;
const MAX_BUDGET_MS = 50_000;
/**
 * Long enough for one provider call (LINKS_ET_TIMEOUT_MS defaults to 5s) plus
 * the ledger post, short enough that a crashed drain's job is retried soon.
 */
const LEASE_MS = 120_000;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface ReconciliationDrainSummary {
  /** Jobs this call took a lease on. */
  readonly claimed: number;
  /** Became VERIFIED (and were posted to the ledger when the group is provisioned). */
  readonly verified: number;
  /** The bank answered and the receipt did not match. */
  readonly rejected: number;
  /** Still pending; will be retried after their backoff. */
  readonly stillPending: number;
  /** Attempts exhausted; need a person. */
  readonly failed: number;
  /** Stuck final-attempt jobs (worker died holding the last lease) moved to manual review. */
  readonly reaped: number;
  /** Earliest next retry among jobs rescheduled by THIS call, or null. */
  readonly nextDueAt: string | null;
  /** True when the batch or time bound ended the run before the queue emptied. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface DrainHandlerDependencies {
  /** Null means the worker is not configured (no service-role credentials). */
  readonly coordinatorFactory?: () => ReconciliationCoordinator | null;
  /** Monotonic-ish milliseconds, injectable for tests. */
  readonly nowMs?: () => number;
}

function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Hash both sides so the buffers are equal length and length leaks nothing. */
function secretsMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function boundedEnvInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d{1,9}$/.test(raw)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Number(raw)));
}

function productionCoordinator(): ReconciliationCoordinator | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    return null;
  }
  try {
    const client = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
    });
    return createProductionReconciliationCoordinator(client);
  } catch {
    return null;
  }
}

export function createDrainHandler(
  dependencies: DrainHandlerDependencies = {}
): (request: Request) => Promise<Response> {
  const coordinatorFactory = dependencies.coordinatorFactory ?? productionCoordinator;
  const nowMs = dependencies.nowMs ?? (() => Date.now());

  return async function post(request: Request): Promise<Response> {
    const expected = process.env.RECONCILIATION_CRON_SECRET?.trim();
    if (!expected || expected.length < MIN_SECRET_LENGTH) {
      return jsonResponse({ error: "not_configured" }, 503);
    }
    const presented = bearerToken(request);
    if (!presented || !secretsMatch(presented, expected)) {
      return jsonResponse({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }

    let coordinator: ReconciliationCoordinator | null;
    try {
      coordinator = coordinatorFactory();
    } catch {
      coordinator = null;
    }
    if (!coordinator) {
      return jsonResponse({ error: "not_configured" }, 503);
    }

    const maxJobs = boundedEnvInteger("RECONCILIATION_DRAIN_MAX_JOBS", DEFAULT_MAX_JOBS, 1, MAX_MAX_JOBS);
    const budgetMs = boundedEnvInteger(
      "RECONCILIATION_DRAIN_BUDGET_MS",
      DEFAULT_BUDGET_MS,
      MIN_BUDGET_MS,
      MAX_BUDGET_MS
    );
    const startedAt = nowMs();
    let claimed = 0;
    let verified = 0;
    let rejected = 0;
    let stillPending = 0;
    let failed = 0;
    let reaped = 0;
    let nextDueAt: string | null = null;

    const summary = (truncated: boolean): ReconciliationDrainSummary => ({
      claimed,
      verified,
      rejected,
      stillPending,
      failed,
      reaped,
      nextDueAt,
      truncated,
      durationMs: Math.max(0, nowMs() - startedAt)
    });

    try {
      reaped = (await coordinator.reapExhausted?.()) ?? 0;
      const result = await drainReconciliationQueue(coordinator, {
        workerId: `drain-${randomUUID()}`,
        leaseMs: LEASE_MS,
        maxIterations: maxJobs,
        shouldContinue: () => nowMs() - startedAt < budgetMs,
        onSettled: ({ job, outcome }) => {
          claimed += 1;
          if (job.state === "MANUAL_REVIEW") {
            failed += 1;
          } else if (outcome.state === "VERIFIED") {
            verified += 1;
          } else if (outcome.state === "REJECTED") {
            rejected += 1;
          } else {
            stillPending += 1;
            if (nextDueAt === null || job.nextAttemptAt < nextDueAt) {
              nextDueAt = job.nextAttemptAt;
            }
          }
        }
      });
      return jsonResponse(summary(result.truncated), 200);
    } catch {
      // A storage failure while settling a job. Jobs settled so far are
      // committed; the unsettled one keeps its lease and is retried when it
      // expires. Report the partial summary and a non-2xx so the scheduler
      // alerts and retries. No error detail leaves the server.
      return jsonResponse({ error: "drain_interrupted", ...summary(true) }, 502);
    }
  };
}
