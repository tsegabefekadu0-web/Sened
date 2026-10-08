import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { attributionFromPayload } from "@/lib/db/attribution";
import {
  claimAttributionRetry,
  getOutboxRow,
  listAttributionRetriesDue,
  recordAttributionAttempt
} from "@/lib/db/outbox";
import type { SenedDatabase } from "@/lib/db/schema";
import type { OutboxRow } from "@/lib/db/types";
import { attributePayer, type AttributeResult } from "@/lib/ledger/clientAttribution";
import { attributeCodeFromServer, type AttributeFailureCode } from "@/lib/ledger/attributionCodes";
import {
  ATTRIBUTION_MAX_AUTO_ATTEMPTS,
  attributionAttemptsOf,
  attributionNextAttemptAtOf,
  attributionRetryView,
  classifyAttributionError
} from "./attributionPolicy";
import { nextAttemptAtMs, type BackoffOptions } from "./backoff";

/**
 * Retry the payer attribution of a ledger draft whose ENTRY the server already
 * holds.
 *
 * Only the attribution is sent (`POST /api/ledger/attributions`, the same action
 * the home feed's "attribute payer" uses) against the server's entry id; the entry
 * is never pushed again, so it cannot post twice. The attribution RPC records the
 * first attribution of an entry and answers an identical one with the existing
 * record, so a retry after a lost response is `recorded`, not an error. The payer's
 * channel and note ride in the same call, so a retry is exactly the record the draft
 * described.
 *
 * Two callers share one attempt:
 *
 * - `retryDraftAttribution`: the treasurer's button. Works on any synced draft whose
 *   payer is not recorded, whatever the reason; a transient failure changes nothing.
 * - `retryDueAttributions`: AUTOMATIC. Only for payers whose last answer was transient
 *   (`attributionPolicy.ts`), only while online and signed in, with the backoff helper,
 *   a bound, and the attempt count and next-due time persisted on the outbox row so a
 *   reload carries on where it was. A definitive refusal is never retried by itself.
 */

export type RetryAttributionResult =
  | { readonly status: "recorded" }
  /** The database refused it (the entry is unchanged; the reason is stored for the console). */
  | { readonly status: "refused"; readonly code: AttributeFailureCode }
  /** Nothing to retry: the mutation is not a synced draft that carried a payer. */
  | { readonly status: "nothing-to-retry" }
  /** Could not reach a verdict (offline, signed out, rate limited): nothing was changed. */
  | { readonly status: "unavailable"; readonly cause: Exclude<AttributeResult["status"], "ok" | "refused" | "forbidden"> };

/** One request for the row's payer; the entry is not touched. */
async function sendAttribution(row: OutboxRow, deps: AuthedFetchDeps): Promise<AttributeResult | null> {
  const attribution = attributionFromPayload(row.payload);
  if (!attribution || !row.serverEntryId) {
    return null;
  }
  return attributePayer(
    {
      groupId: row.groupId,
      entryId: row.serverEntryId,
      memberUserId: attribution.memberUserId,
      ...(attribution.cycleId === undefined ? {} : { cycleId: attribution.cycleId }),
      ...(attribution.round === undefined ? {} : { round: attribution.round }),
      ...(attribution.channel ? { channel: attribution.channel } : {}),
      ...(attribution.note ? { note: attribution.note } : {})
    },
    deps
  );
}

export async function retryDraftAttribution(
  db: SenedDatabase,
  outboxId: string,
  options: { readonly deps?: AuthedFetchDeps; readonly now?: Date } = {}
): Promise<RetryAttributionResult> {
  const row = await getOutboxRow(db, outboxId);
  const attribution = row ? attributionFromPayload(row.payload) : null;
  if (!row || row.kind !== "ledger-draft" || row.state !== "synced" || !row.serverEntryId || attribution === null) {
    return { status: "nothing-to-retry" };
  }
  if (row.attributionOutcome === "RECORDED") {
    return { status: "recorded" };
  }
  const result = await sendAttribution(row, options.deps ?? {});
  const now = options.now ?? new Date();
  if (result === null) {
    return { status: "nothing-to-retry" };
  }
  const attempts = attributionAttemptsOf(row) + 1;
  if (result.status === "ok") {
    await recordAttributionAttempt(db, outboxId, { outcome: "RECORDED", error: null, attempts, nextAttemptAt: null }, now);
    return { status: "recorded" };
  }
  if (result.status === "refused") {
    await recordAttributionAttempt(db, outboxId, { outcome: "REFUSED", error: result.code, attempts, nextAttemptAt: null }, now);
    return { status: "refused", code: result.code };
  }
  if (result.status === "forbidden") {
    // A 403 is a definitive answer about this person's role: stored, so nothing retries it by itself.
    await recordAttributionAttempt(db, outboxId, { outcome: "REFUSED", error: "forbidden", attempts, nextAttemptAt: null }, now);
    return { status: "refused", code: "forbidden" };
  }
  return { status: "unavailable", cause: result.status };
}

export interface AutoRetryOptions {
  /** `false` when nobody is signed in: nothing is read, sent or counted. */
  readonly signedIn: boolean;
  /** `false` when the device knows it is offline: nothing is sent or counted. Defaults to `navigator.onLine`. */
  readonly online?: boolean;
  /** Token source and `fetch` for the calls (test seam). */
  readonly deps?: AuthedFetchDeps;
  readonly now?: Date;
  readonly maxAttempts?: number;
  /** Injected in tests so jitter does not make assertions flaky. */
  readonly backoff?: BackoffOptions;
  readonly groupId?: string;
  readonly limit?: number;
}

export type AutoRetryReport =
  | { readonly status: "signed-out" }
  | { readonly status: "offline" }
  | {
      readonly status: "done";
      /** Requests sent. */
      readonly attempted: number;
      readonly recorded: number;
      /** Definitive answers (including `forbidden`): the draft now needs a person. */
      readonly refused: number;
      /** Transient failures with another try scheduled. */
      readonly scheduled: number;
      /** Transient failures that used the last try: the draft now needs a person. */
      readonly exhausted: number;
      /** A 401 came back: the run stopped and no try was spent. */
      readonly stoppedSignedOut: boolean;
    };

function isOnline(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// An attempt that is on its way: a second trigger in the same tab skips it without touching storage.
const inFlight = new Set<string>();

/**
 * One automatic pass: every synced draft whose payer is owed a try right now.
 * Safe to call from any number of triggers (reconnect, the console's drain, the
 * service worker's drain message, a timer): a row is claimed inside a transaction
 * first, so two triggers send ONE request, and a request that is repeated anyway is
 * answered with the existing record, never a second one.
 */
export async function retryDueAttributions(db: SenedDatabase, options: AutoRetryOptions): Promise<AutoRetryReport> {
  if (!options.signedIn) {
    return { status: "signed-out" };
  }
  if (!isOnline(options.online)) {
    return { status: "offline" };
  }
  const now = options.now ?? new Date();
  const max = options.maxAttempts ?? ATTRIBUTION_MAX_AUTO_ATTEMPTS;
  const due = await listAttributionRetriesDue(db, {
    now,
    maxAttempts: max,
    ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
    ...(options.limit === undefined ? {} : { limit: options.limit })
  });

  let attempted = 0;
  let recorded = 0;
  let refused = 0;
  let scheduled = 0;
  let exhausted = 0;
  let stoppedSignedOut = false;

  for (const candidate of due) {
    if (inFlight.has(candidate.id)) {
      continue;
    }
    inFlight.add(candidate.id);
    try {
      const claimed = await claimAttributionRetry(db, candidate.id, { now, maxAttempts: max });
      if (!claimed) {
        continue;
      }
      const result = await sendAttribution(claimed, options.deps ?? {});
      if (result === null) {
        continue;
      }
      // Counted from the row as it was before the claim: the claim only moved the due time.
      const spent = attributionAttemptsOf(claimed);
      if (result.status === "unauthorized") {
        // Signed out (or the session lapsed): no verdict, no try spent, and no point asking again.
        await recordAttributionAttempt(
          db,
          candidate.id,
          {
            outcome: candidate.attributionOutcome ?? null,
            error: candidate.attributionError ?? null,
            attempts: spent,
            nextAttemptAt: attributionNextAttemptAtOf(candidate)
          },
          now
        );
        stoppedSignedOut = true;
        break;
      }
      attempted += 1;
      const attempts = spent + 1;
      if (result.status === "ok") {
        await recordAttributionAttempt(db, candidate.id, { outcome: "RECORDED", error: null, attempts, nextAttemptAt: null }, now);
        recorded += 1;
      } else if (result.status === "refused") {
        await recordAttributionAttempt(db, candidate.id, { outcome: "REFUSED", error: result.code, attempts, nextAttemptAt: null }, now);
        refused += 1;
      } else if (result.status === "forbidden") {
        await recordAttributionAttempt(db, candidate.id, { outcome: "REFUSED", error: "forbidden", attempts, nextAttemptAt: null }, now);
        refused += 1;
      } else {
        // Network, 5xx, rate limit: nothing was said about the payer. Back off, within the bound.
        const error = candidate.attributionError ?? "attribution_failed";
        const keep = classifyAttributionError(error) === "transient" ? error : "attribution_failed";
        if (attempts >= max) {
          await recordAttributionAttempt(db, candidate.id, { outcome: "REFUSED", error: keep, attempts, nextAttemptAt: null }, now);
          exhausted += 1;
        } else {
          await recordAttributionAttempt(
            db,
            candidate.id,
            {
              outcome: "REFUSED",
              error: keep,
              attempts,
              nextAttemptAt: nextAttemptAtMs({
                attempt: attempts,
                nowMs: now.getTime(),
                retryAfterMs: null,
                options: options.backoff
              })
            },
            now
          );
          scheduled += 1;
        }
      }
    } finally {
      inFlight.delete(candidate.id);
    }
  }

  return { status: "done", attempted, recorded, refused, scheduled, exhausted, stoppedSignedOut };
}

/** When the next automatic try is due across the whole queue, or `null` when none is waiting. */
export async function nextAttributionRetryAt(
  db: SenedDatabase,
  options: { readonly groupId?: string; readonly maxAttempts?: number } = {}
): Promise<number | null> {
  const max = options.maxAttempts ?? ATTRIBUTION_MAX_AUTO_ATTEMPTS;
  const rows = await db.outbox.toArray();
  let earliest: number | null = null;
  for (const row of rows) {
    if (options.groupId !== undefined && row.groupId !== options.groupId) {
      continue;
    }
    const view = attributionRetryView(row, max);
    if (view.kind !== "auto" || !row.serverEntryId) {
      continue;
    }
    const at = view.nextAt ?? 0;
    earliest = earliest === null ? at : Math.min(earliest, at);
  }
  return earliest;
}

/** Both the server's codes (`attribution_bank_verified`) and the retry's (`bank_verified`) as one code. */
export function attributionRefusalCode(error: string | null | undefined): AttributeFailureCode {
  if (!error) return "other";
  const fromServer = attributeCodeFromServer(error);
  if (fromServer !== "other") return fromServer;
  const friendly: readonly AttributeFailureCode[] = [
    "bank_verified",
    "corrected",
    "exists",
    "unchanged",
    "not_contribution",
    "entry_not_found",
    "member_not_found",
    "cycle_not_found",
    "attribution_not_found"
  ];
  return (friendly as readonly string[]).includes(error) ? (error as AttributeFailureCode) : "other";
}
