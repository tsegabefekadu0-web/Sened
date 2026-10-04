import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BankVerificationService,
  InMemoryBankVerificationRepository,
  InMemoryReconciliationJobStore,
  LedgerBankVerificationSink,
  ReconciliationCoordinator,
  type BankAccountBinding,
  type BankVerificationRequest
} from "@/lib/banking";
import { FixtureBankProviderAdapter } from "@/lib/banking/adapter";
import { InMemoryReferenceVault } from "@/lib/banking/vault";
import { createDrainHandler } from "@/lib/banking/reconciliationDrainRoute";
import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";
import { RATE_LIMITED, resolveRateLimit } from "@/middleware";
import { WRITE_RULE } from "@/lib/rateLimit";

/**
 * The drain route: auth model, bounds, and the ledger staying exactly-once.
 *
 * Everything below the route is real (service, verifier, in-memory job store
 * with the same lease rules, real `LedgerBankVerificationSink` over a real
 * `LedgerService`); only the bank is a fixture and storage is in memory.
 */

const SECRET = "s".repeat(40);
const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const bindingId = "33333333-3333-4333-8333-333333333333";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";
const sender = "a".repeat(64);
const receiver = "b".repeat(64);
const occurredAt = "2026-09-25T10:30:00.000Z";

const binding: BankAccountBinding = {
  id: bindingId,
  userId,
  groupId,
  tenantId,
  ledgerAccountId: cashAccount,
  provider: "telebirr",
  currency: "ETB",
  accountLabel: "Treasury",
  accountFingerprintHmac: "c".repeat(64),
  senderFingerprintHmac: sender,
  receiverFingerprintHmac: receiver,
  active: true
};

function request(n: number): BankVerificationRequest {
  return {
    provider: "telebirr",
    bankAccountBindingId: bindingId,
    providerReference: `TX-REF-${n}`,
    amount: "25.00",
    currency: "ETB",
    direction: "inbound",
    occurredAt,
    idempotencyKey: `bank-intent-${n}`
  };
}

type Mode = "timeout" | "settled" | "throw";

function build(maxAttempts?: number) {
  let now = new Date("2026-09-25T10:30:00.000Z");
  const clock = () => now;
  let mode: Mode = "timeout";
  let providerCalls = 0;
  let onProviderCall: () => void = () => {};
  const adapter = new FixtureBankProviderAdapter("telebirr", (lookup: { transactionReference: string }) => {
    providerCalls += 1;
    onProviderCall();
    if (mode === "throw") {
      throw new Error("socket hang up");
    }
    if (mode === "timeout") {
      return { provider: "telebirr", kind: "timeout" };
    }
    return {
      provider: "telebirr",
      kind: "settled",
      evidence: {
        providerTransactionId: `provider-${lookup.transactionReference}`,
        amount: "25.00",
        currency: "ETB",
        direction: "inbound",
        senderFingerprint: sender,
        receiverFingerprint: receiver,
        occurredAt,
        settledAt: "2026-09-25T10:30:01.000Z"
      }
    };
  });

  const hmacKey = Buffer.alloc(32, 9);
  const repository = new InMemoryBankVerificationRepository({ bindings: [binding], clock });
  const jobStore = new InMemoryReconciliationJobStore({ repository, clock, ...(maxAttempts ? { maxAttempts } : {}) });
  const ledgerRepository = new InMemoryLedgerRepository({
    groups: [{ id: groupId, tenantId, members: [{ userId, role: "treasurer" }] }],
    accounts: [
      { id: cashAccount, groupId, code: "CASH", name: "Cash", type: "asset" },
      { id: incomeAccount, groupId, code: "INCOME", name: "Income", type: "income" }
    ]
  });
  const ledger = new LedgerService(ledgerRepository);
  const posted: { entryId: string; replayed: boolean; key: string }[] = [];
  const sink = new LedgerBankVerificationSink({
    ledger: {
      append: async (entry, context) => {
        const result = await ledger.append(entry, context);
        posted.push({ entryId: result.entry.id, replayed: result.replayed, key: (entry as { idempotencyKey: string }).idempotencyKey });
        return result;
      }
    },
    accounts: () => ({ cashAccountId: cashAccount, counterAccountId: incomeAccount })
  });
  const service = new BankVerificationService({
    repository,
    jobStore,
    referenceVault: new InMemoryReferenceVault(hmacKey),
    adapterResolver: () => adapter,
    ledgerSink: sink,
    clock,
    hmacKey,
    ...(maxAttempts ? { maxAttempts } : {}),
    backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 }
  });
  const coordinator = new ReconciliationCoordinator(jobStore, service, clock, {
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0
  });
  return {
    service,
    jobStore,
    coordinator,
    posted,
    clock: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setMode: (next: Mode) => {
      mode = next;
    },
    onProviderCall: (fn: () => void) => {
      onProviderCall = fn;
    },
    providerCalls: () => providerCalls
  };
}

function call(handler: (r: Request) => Promise<Response>, authorization?: string) {
  return handler(
    new Request("http://localhost/api/reconciliation/drain", {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization }
    })
  );
}

const bearer = `Bearer ${SECRET}`;

beforeEach(() => {
  vi.stubEnv("RECONCILIATION_CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authentication fails closed", () => {
  it("is 503 and runs nothing when no secret is configured", async () => {
    vi.stubEnv("RECONCILIATION_CRON_SECRET", "");
    const factory = vi.fn(() => null);
    const response = await call(createDrainHandler({ coordinatorFactory: factory }), bearer);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(factory).not.toHaveBeenCalled();
  });

  it("is 503 for an unset or too-short secret even if the caller presents it", async () => {
    const factory = vi.fn(() => null);
    vi.stubEnv("RECONCILIATION_CRON_SECRET", "short");
    expect((await call(createDrainHandler({ coordinatorFactory: factory }), "Bearer short")).status).toBe(503);
    vi.unstubAllEnvs();
    delete process.env.RECONCILIATION_CRON_SECRET;
    expect((await call(createDrainHandler({ coordinatorFactory: factory }), "Bearer ")).status).toBe(503);
    expect(factory).not.toHaveBeenCalled();
  });

  it("is 401 for a missing, malformed or wrong secret, and builds no database client", async () => {
    const factory = vi.fn(() => null);
    const handler = createDrainHandler({ coordinatorFactory: factory });

    for (const header of [undefined, "", "Bearer", "Basic abc", `Bearer ${"x".repeat(40)}`, `Bearer ${SECRET}x`, SECRET]) {
      const response = await call(handler, header);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not accept a user's access token as the secret", async () => {
    const response = await call(createDrainHandler({ coordinatorFactory: () => null }), "Bearer eyJhbGciOi.user.token");
    expect(response.status).toBe(401);
  });

  it("is 503 when the secret is right but the service-role worker is not configured", async () => {
    const response = await call(createDrainHandler({ coordinatorFactory: () => null }), bearer);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("is 503 when no service-role key is in the environment (default factory)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const response = await call(createDrainHandler(), bearer);
    expect(response.status).toBe(503);
  });
});

describe("a correct secret drains the queue", () => {
  it("re-checks a pending verification and reports the summary", async () => {
    const h = build();
    const created = await h.service.create(request(1), { userId });
    expect(created.verification.state).toBe("PENDING_RECONCILIATION");

    h.setMode("settled");
    h.advance(5_000);
    const response = await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      claimed: 1,
      verified: 1,
      rejected: 0,
      stillPending: 0,
      failed: 0,
      nextDueAt: null,
      truncated: false
    });
    expect(typeof body.durationMs).toBe("number");
    expect(JSON.stringify(body)).not.toContain("TX-REF");
    expect((await h.service.get(created.verification.verificationId, { userId })).state).toBe("VERIFIED");
    expect(h.posted).toHaveLength(1);
  });

  it("answers an empty queue with zeros", async () => {
    const h = build();
    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(body).toMatchObject({ claimed: 0, verified: 0, stillPending: 0, failed: 0, nextDueAt: null, truncated: false });
  });

  it("leaves a job pending with backoff when the adapter errors, and reports when it is next due", async () => {
    const h = build();
    const created = await h.service.create(request(1), { userId });
    h.setMode("throw");
    h.advance(5_000);

    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();

    expect(body).toMatchObject({ claimed: 1, verified: 0, stillPending: 1, failed: 0 });
    const job = await h.jobStore.getJobByVerificationId(created.verification.verificationId);
    expect(job?.state).toBe("RETRY_SCHEDULED");
    expect(new Date(job!.nextAttemptAt).getTime()).toBeGreaterThan(h.clock().getTime());
    expect(body.nextDueAt).toBe(job!.nextAttemptAt);
    expect(h.posted).toHaveLength(0);

    // Not claimable again until the backoff has elapsed.
    const again = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(again.claimed).toBe(0);
  });

  it("counts exhausted attempts as failed", async () => {
    const h = build();
    const created = await h.service.create(request(1), { userId });
    h.setMode("timeout");
    const handler = createDrainHandler({ coordinatorFactory: () => h.coordinator });
    let last: { failed: number } = { failed: 0 };
    for (let pass = 0; pass < 8; pass += 1) {
      h.advance(120_000);
      const body = await (await call(handler, bearer)).json();
      if (body.failed) {
        last = body;
      }
    }
    expect(last.failed).toBe(1);
    expect((await h.jobStore.getJobByVerificationId(created.verification.verificationId))?.state).toBe("MANUAL_REVIEW");
  });

  it("returns 502 with the partial summary if storage fails mid-run", async () => {
    const h = build();
    await h.service.create(request(1), { userId });
    h.advance(5_000);
    const broken = {
      runWithOutcome: async () => {
        throw new Error("db down");
      }
    } as unknown as ReconciliationCoordinator;

    const response = await call(createDrainHandler({ coordinatorFactory: () => broken }), bearer);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("drain_interrupted");
    expect(JSON.stringify(body)).not.toContain("db down");
  });
});

describe("each run is bounded", () => {
  it("stops at RECONCILIATION_DRAIN_MAX_JOBS", async () => {
    vi.stubEnv("RECONCILIATION_DRAIN_MAX_JOBS", "2");
    const h = build();
    for (let n = 1; n <= 5; n += 1) {
      await h.service.create(request(n), { userId });
    }
    h.setMode("settled");
    h.advance(5_000);

    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();

    expect(body).toMatchObject({ claimed: 2, verified: 2, truncated: true });
    expect(h.providerCalls()).toBe(5 + 2);

    // The remainder is picked up by the next invocation.
    const next = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(next).toMatchObject({ claimed: 2, truncated: true });
  });

  it("stops starting jobs once the time budget is spent", async () => {
    vi.stubEnv("RECONCILIATION_DRAIN_BUDGET_MS", "1000");
    const h = build();
    for (let n = 1; n <= 5; n += 1) {
      await h.service.create(request(n), { userId });
    }
    h.setMode("settled");
    h.advance(5_000);
    let wall = 0;
    h.onProviderCall(() => {
      wall += 600;
    });

    const body = await (
      await call(createDrainHandler({ coordinatorFactory: () => h.coordinator, nowMs: () => wall }), bearer)
    ).json();

    expect(body.claimed).toBe(2);
    expect(body.truncated).toBe(true);
  });

  it("clamps absurd configuration instead of trusting it", async () => {
    vi.stubEnv("RECONCILIATION_DRAIN_MAX_JOBS", "999999");
    vi.stubEnv("RECONCILIATION_DRAIN_BUDGET_MS", "not-a-number");
    const h = build();
    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(body.claimed).toBe(0);
  });
});

describe("the ledger is posted exactly once", () => {
  it("posts a drained VERIFIED job once, however many times it is drained", async () => {
    const h = build();
    await h.service.create(request(1), { userId });
    h.setMode("settled");
    h.advance(5_000);
    const handler = createDrainHandler({ coordinatorFactory: () => h.coordinator });

    const first = await (await call(handler, bearer)).json();
    const second = await (await call(handler, bearer)).json();

    expect(first.verified).toBe(1);
    expect(second.claimed).toBe(0);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]?.key).toBe("bank-verified-bank-intent-1");
  });

  it("is idempotent when the same job is processed twice (a crash between post and finalize)", async () => {
    const h = build();
    const created = await h.service.create(request(1), { userId });
    h.setMode("settled");
    h.advance(5_000);

    const claim = await h.jobStore.claimNext("worker-a", h.clock(), 30_000);
    expect(claim).not.toBeNull();
    // Worker A verified and posted, then died before finalize.
    const first = await h.service.verifyIntent(claim!.intent);
    // Its lease expires; worker B claims the same job and does the work again.
    h.advance(31_000);
    const reclaimed = await h.jobStore.claimNext("worker-b", h.clock(), 30_000);
    expect(reclaimed?.job.id).toBe(claim!.job.id);
    const second = await h.service.verifyIntent(reclaimed!.intent);

    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(h.posted).toHaveLength(2);
    expect(h.posted[0]?.replayed).toBe(false);
    expect(h.posted[1]?.replayed).toBe(true);
    expect(new Set(h.posted.map((p) => p.entryId)).size).toBe(1);
    expect(created.verification.state).toBe("PENDING_RECONCILIATION");
  });

  it("does not let a stale worker settle a job another worker holds", async () => {
    const h = build();
    await h.service.create(request(1), { userId });
    h.advance(5_000);
    const a = await h.jobStore.claimNext("worker-a", h.clock(), 30_000);
    expect(await h.jobStore.claimNext("worker-b", h.clock(), 30_000)).toBeNull();
    h.advance(31_000);
    const b = await h.jobStore.claimNext("worker-b", h.clock(), 30_000);
    expect(b).not.toBeNull();

    await expect(
      h.jobStore.finalize(a!.job.id, "worker-a", a!.job.leaseToken!, {
        state: "VERIFIED",
        reasonCode: "VERIFIED",
        evidenceFingerprint: "d".repeat(64),
        providerTransactionIdentityHmac: "e".repeat(64),
        ledgerEntryId: null
      })
    ).rejects.toThrow();
  });
});

describe("a job stuck on an expired final-attempt lease", () => {
  it("is moved to manual review and reported as reaped", async () => {
    const h = build(1);
    const created = await h.service.create(request(1), { userId });
    h.advance(5_000);
    // The only allowed attempt is claimed, then the worker dies holding the lease.
    expect(await h.jobStore.claimNext("dead-worker", h.clock(), 30_000)).not.toBeNull();
    h.advance(31_000);
    // Without the reaper this job is unclaimable and silent.
    expect(await h.jobStore.claimNext("worker-b", h.clock(), 30_000)).toBeNull();

    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();

    expect(body).toMatchObject({ reaped: 1, claimed: 0 });
    const job = await h.jobStore.getJobByVerificationId(created.verification.verificationId);
    expect(job?.state).toBe("MANUAL_REVIEW");
    expect(job?.lastReasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(job?.leaseToken).toBeNull();
    expect(job?.terminalAt).not.toBeNull();
    expect((await h.service.get(created.verification.verificationId, { userId })).reasonCode).toBe(
      "MANUAL_REVIEW_REQUIRED"
    );

    const again = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(again.reaped).toBe(0);
  });

  it("leaves an expired lease with attempts remaining reclaimable, as before", async () => {
    const h = build(3);
    await h.service.create(request(1), { userId });
    h.setMode("settled");
    h.advance(5_000);
    expect(await h.jobStore.claimNext("dead-worker", h.clock(), 30_000)).not.toBeNull();
    h.advance(31_000);

    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();

    expect(body).toMatchObject({ reaped: 0, claimed: 1, verified: 1 });
  });

  it("does not reap a lease that is still live", async () => {
    const h = build(1);
    await h.service.create(request(1), { userId });
    h.advance(5_000);
    await h.jobStore.claimNext("busy-worker", h.clock(), 30_000);
    h.advance(1_000);
    const body = await (await call(createDrainHandler({ coordinatorFactory: () => h.coordinator }), bearer)).json();
    expect(body.reaped).toBe(0);
  });
});

describe("the path is metered", () => {
  it("is registered with the write rule", () => {
    expect(RATE_LIMITED.has("/api/reconciliation/drain")).toBe(true);
    expect(resolveRateLimit("/api/reconciliation/drain")).toEqual(WRITE_RULE);
  });
});
