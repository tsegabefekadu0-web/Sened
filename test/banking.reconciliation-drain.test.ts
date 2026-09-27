import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  drainReconciliationQueue,
  InMemoryReconciliationJobStore,
  ReconciliationCoordinator,
  type BankProviderResult,
  type BankVerificationIntent,
  type ReconciliationVerificationOutcome
} from "@/lib/banking";

/**
 * The reconciliation queue had no entry point.
 *
 * `ReconciliationCoordinator` was written, tested and then never driven: it
 * settles exactly one job per call and nothing called it. Every
 * `PENDING_RECONCILIATION` raised by a bank timeout or a 429 therefore stayed
 * pending forever, which is the opposite of ROADMAP 2.3 — "an exponential
 * backoff queue that automatically checks bank status when connectivity
 * returns".
 *
 * These tests cover the drain's own contract: it keeps going until nothing is
 * claimable, it counts verdicts a person can act on, it does not busy-loop on a
 * job it has just rescheduled, and it terminates.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";

let intentCounter = 0;

function intent(overrides: Partial<BankVerificationIntent> = {}): BankVerificationIntent {
  intentCounter += 1;
  const id = `00000000-0000-4000-8000-${String(intentCounter).padStart(12, "0")}`;
  return {
    id,
    userId,
    groupId,
    tenantId,
    bankAccountBindingId: "33333333-3333-4333-8333-333333333333",
    ledgerAccountId: "44444444-4444-4444-8444-444444444444",
    provider: "telebirr",
    providerReferenceHmac: "a".repeat(64),
    sealedProviderReference: {
      provider: "telebirr",
      ciphertext: "sealed",
      hmac: "b".repeat(64),
      keyVersion: "v1"
    },
    amount: "25.00",
    currency: "ETB",
    direction: "inbound",
    occurredAt: "2026-09-25T10:30:00.000Z",
    idempotencyKey: `bank-intent-${intentCounter}`,
    requestFingerprint: "c".repeat(64),
    state: "PENDING_RECONCILIATION",
    reasonCode: "PROVIDER_TIMEOUT",
    evidenceFingerprint: null,
    providerTransactionIdentityHmac: null,
    createdAt: "2026-09-25T10:30:00.000Z",
    updatedAt: "2026-09-25T10:30:00.000Z",
    ledgerEntryId: null,
    ...overrides
  };
}

type Script = (attempt: number) => ReconciliationVerificationOutcome;

function pending(reasonCode: ReconciliationVerificationOutcome["reasonCode"] = "PROVIDER_TIMEOUT") {
  return {
    state: "PENDING_RECONCILIATION",
    reasonCode,
    evidenceFingerprint: null,
    providerTransactionIdentityHmac: null,
    ledgerEntryId: null
  } as const;
}

const settledOk = (ledgerEntryId: string | null = null) =>
  ({
    state: "VERIFIED",
    reasonCode: "VERIFIED",
    evidenceFingerprint: "d".repeat(64),
    providerTransactionIdentityHmac: "e".repeat(64),
    ledgerEntryId
  }) as const;

const rejected = {
  state: "REJECTED",
  reasonCode: "AMOUNT_MISMATCH",
  evidenceFingerprint: "f".repeat(64),
  providerTransactionIdentityHmac: "e".repeat(64),
  ledgerEntryId: null
} as const;

/** A clock the test advances by hand, so backoff is observable. */
function testClock(start = new Date("2026-09-25T10:30:00.000Z")) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    }
  };
}

function coordinator(
  store: InMemoryReconciliationJobStore,
  script: Script,
  clock: () => Date,
  random = () => 0.5
): ReconciliationCoordinator {
  return new ReconciliationCoordinator(
    store,
    {
      verifyIntent: async () => script(0)
    },
    clock,
    { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, random }
  );
}

describe("draining the queue", () => {
  it("settles every queued job and reports the verdicts", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    await store.enqueue(intent());
    await store.enqueue(intent());
    await store.enqueue(intent());

    const verdicts: ReconciliationVerificationOutcome[] = [settledOk("entry-1"), rejected, settledOk("entry-3")];
    let call = 0;
    const drain = new ReconciliationCoordinator(
      store,
      {
        verifyIntent: async () => {
          const verdict = verdicts[call] ?? settledOk();
          call += 1;
          return verdict;
        }
      },
      clock.now,
      { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, random: () => 0.5 }
    );

    const result = await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 });

    expect(result).toEqual({
      attempted: 3,
      verified: 2,
      rejected: 1,
      rescheduled: 0,
      manualReview: 0,
      truncated: false
    });
  });

  it("does not busy-loop on a job it has just rescheduled", async () => {
    // A rescheduled job's nextAttemptAt is in the future, so the next
    // claimNext must not return it. Without that the drain would spin.
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    const job = await store.enqueue(intent());

    const drain = coordinator(store, () => pending(), clock.now);
    const result = await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 });

    expect(result).toMatchObject({ attempted: 1, rescheduled: 1, truncated: false });
    const after = await store.getJobByVerificationId(job.verificationId);
    expect(after?.state).toBe("RETRY_SCHEDULED");
    expect(after?.attempt).toBe(1);
  });

  it("resolves on a later pass once the backoff has elapsed", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    const job = await store.enqueue(intent());

    const first = coordinator(store, () => pending(), clock.now);
    expect(
      await drainReconciliationQueue(first, { workerId: "worker-1", leaseMs: 30_000 })
    ).toMatchObject({ rescheduled: 1 });

    // Connectivity returns, the bank answers.
    clock.advance(120_000);
    const second = coordinator(store, () => settledOk("entry-9"), clock.now);
    expect(
      await drainReconciliationQueue(second, { workerId: "worker-1", leaseMs: 30_000 })
    ).toMatchObject({ attempted: 1, verified: 1, rescheduled: 0 });

    const after = await store.getJobByVerificationId(job.verificationId);
    expect(after?.state).toBe("SUCCEEDED");
  });

  it("stops retrying and hands the job to a person when attempts run out", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now, maxAttempts: 2 });
    const job = await store.enqueue(intent());

    const drain = coordinator(store, () => pending(), clock.now);
    for (let pass = 0; pass < 4; pass += 1) {
      clock.advance(120_000);
      await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 });
    }

    const after = await store.getJobByVerificationId(job.verificationId);
    expect(after?.state).toBe("MANUAL_REVIEW");
    expect(after?.lastReasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(after?.terminalAt).not.toBeNull();
  });

  it("reports manual review separately from a plain reschedule", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now, maxAttempts: 1 });
    await store.enqueue(intent());

    const drain = coordinator(store, () => pending(), clock.now);
    const result = await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 });

    expect(result).toMatchObject({ attempted: 1, manualReview: 1, rescheduled: 0 });
  });

  it("treats a provider that throws as a retry, not a rejection", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    await store.enqueue(intent());

    const drain = new ReconciliationCoordinator(
      store,
      {
        verifyIntent: async () => {
          throw new Error("socket hang up");
        }
      },
      clock.now,
      { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, random: () => 0.5 }
    );

    expect(
      await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 })
    ).toMatchObject({ attempted: 1, rescheduled: 1, rejected: 0, manualReview: 0 });
  });

  it("stops on its iteration bound rather than looping forever", async () => {
    // Backstop. The backoff floor is 1ms, so with a frozen clock a rescheduled
    // job is never re-claimable and the bound is unreachable — which is the
    // healthy case. A clock that ticks past that floor simulates a store that
    // keeps handing work back, and only the bound can end the call.
    let now = new Date("2026-09-25T10:30:00.000Z").getTime();
    const ticking = () => {
      const value = new Date(now);
      now += 5;
      return value;
    };
    const store = new InMemoryReconciliationJobStore({ clock: ticking, maxAttempts: 20 });
    await store.enqueue(intent());

    const drain = new ReconciliationCoordinator(
      store,
      { verifyIntent: async () => pending() },
      ticking,
      { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, random: () => 0.5 }
    );
    const result = await drainReconciliationQueue(drain, {
      workerId: "worker-1",
      leaseMs: 30_000,
      maxIterations: 3
    });

    expect(result).toEqual({
      attempted: 3,
      verified: 0,
      rejected: 0,
      rescheduled: 3,
      manualReview: 0,
      truncated: true
    });
  });

  it("is a no-op on an empty queue", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    const drain = coordinator(store, () => settledOk(), clock.now);

    expect(await drainReconciliationQueue(drain, { workerId: "worker-1", leaseMs: 30_000 })).toEqual({
      attempted: 0,
      verified: 0,
      rejected: 0,
      rescheduled: 0,
      manualReview: 0,
      truncated: false
    });
  });
});

describe("the coordinator keeps its single-job contract", () => {
  it("run() still returns the job it settled", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    const job = await store.enqueue(intent());

    const drain = coordinator(store, () => settledOk("entry-1"), clock.now);
    const settled = await drain.run("worker-1", 30_000);

    expect(settled?.id).toBe(job.id);
    expect(settled?.state).toBe("SUCCEEDED");
  });

  it("run() returns null when nothing is claimable", async () => {
    const clock = testClock();
    const store = new InMemoryReconciliationJobStore({ clock: clock.now });
    const drain = coordinator(store, () => settledOk(), clock.now);

    expect(await drain.run("worker-1", 30_000)).toBeNull();
  });
});

// Referenced so the unused-import guard does not fire on the provider shape the
// fixture mirrors.
export type { BankProviderResult };
