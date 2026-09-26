import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  assessBankProviderResult,
  calculateReconciliationBackoff,
  createInMemoryBankVerificationService,
  InMemoryReconciliationJobStore,
  validateNormalizedBankProviderResult,
  type BankAccountBinding,
  type BankProviderResult,
  type BankVerificationRequest
} from "@/lib/banking";
import {
  createProductionBankProviderAdapter,
  createTestFixtureBankProviderAdapter
} from "@/lib/banking/adapter";

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const bindingId = "33333333-3333-4333-8333-333333333333";
const ledgerAccountId = "44444444-4444-4444-8444-444444444444";
const senderFingerprint = "a".repeat(64);
const receiverFingerprint = "b".repeat(64);
const occurredAt = "2026-09-25T10:30:00.000Z";

const binding: BankAccountBinding = {
  id: bindingId,
  userId,
  groupId,
  tenantId,
  ledgerAccountId,
  provider: "telebirr",
  currency: "ETB",
  accountLabel: "Treasury mobile money",
  accountFingerprintHmac: "c".repeat(64),
  senderFingerprintHmac: senderFingerprint,
  receiverFingerprintHmac: receiverFingerprint,
  active: true
};

const request: BankVerificationRequest = {
  provider: "telebirr",
  bankAccountBindingId: bindingId,
  providerReference: "TX-SECRET-001",
  amount: "25.00",
  currency: "ETB",
  direction: "inbound",
  occurredAt,
  idempotencyKey: "bank-intent-001"
};

const settled: BankProviderResult = {
  provider: "telebirr",
  kind: "settled",
  evidence: {
    providerTransactionId: "provider-tx-001",
    amount: "25.00",
    currency: "ETB",
    direction: "inbound",
    senderFingerprint,
    receiverFingerprint,
    occurredAt,
    settledAt: "2026-09-25T10:30:01.000Z"
  }
};

const expected = {
  amount: "25.00",
  currency: "ETB",
  direction: "inbound" as const,
  senderFingerprint,
  receiverFingerprint,
  occurredAt
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bank provider boundaries and matching", () => {
  it("keeps the production adapter unconfigured and fails closed", async () => {
    const adapter = createProductionBankProviderAdapter("telebirr");

    expect(adapter.isConfigured()).toBe(false);
    await expect(
      adapter.verify({
        provider: "telebirr",
        transactionReference: request.providerReference,
        accountFingerprintHmac: binding.accountFingerprintHmac
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("does not permit the fixture adapter in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => createTestFixtureBankProviderAdapter("telebirr", settled)).toThrow(/production/i);
  });

  it("strictly rejects raw or unknown fields in normalized provider results", () => {
    expect(() =>
      validateNormalizedBankProviderResult("telebirr", {
        ...settled,
        rawProviderPayload: { secret: "must-not-be-accepted" }
      })
    ).toThrow();
    expect(() => validateNormalizedBankProviderResult("cbe", settled)).toThrow();
  });

  it("requires exact amount, currency, direction, sender, receiver, and timestamp", () => {
    expect(assessBankProviderResult(settled, expected)).toMatchObject({
      state: "VERIFIED",
      reasonCode: "VERIFIED"
    });

    const mismatches = [
      ["amount", { ...settled.evidence!, amount: "25.01" }, "AMOUNT_MISMATCH"],
      ["currency", { ...settled.evidence!, currency: "USD" }, "CURRENCY_MISMATCH"],
      ["direction", { ...settled.evidence!, direction: "outbound" }, "DIRECTION_MISMATCH"],
      ["sender", { ...settled.evidence!, senderFingerprint: "d".repeat(64) }, "SENDER_MISMATCH"],
      ["receiver", { ...settled.evidence!, receiverFingerprint: "d".repeat(64) }, "RECEIVER_MISMATCH"],
      ["timestamp", { ...settled.evidence!, occurredAt: "2026-09-25T10:30:00.001Z" }, "TIMESTAMP_MISMATCH"]
    ] as const;

    for (const [, evidence, reasonCode] of mismatches) {
      const result = assessBankProviderResult(
        { provider: "telebirr", kind: "settled", evidence },
        expected
      );
      expect(result.state).toBe("REJECTED");
      expect(result.reasonCode).toBe(reasonCode);
    }
  });

  it.each([
    ["unsettled", "PROVIDER_UNSETTLED"],
    ["not_found", "PROVIDER_NOT_FOUND"],
    ["timeout", "PROVIDER_TIMEOUT"],
    ["rate_limited", "PROVIDER_RATE_LIMITED"],
    ["provider_error", "PROVIDER_UNAVAILABLE"]
  ] as const)("keeps %s evidence pending", (kind, reasonCode) => {
    const result: BankProviderResult = {
      provider: "telebirr",
      kind,
      ...(kind === "rate_limited" ? { retryAfterSeconds: 2 } : {})
    } as BankProviderResult;
    const assessment = assessBankProviderResult(result, expected);

    expect(assessment.state).toBe("PENDING_RECONCILIATION");
    expect(assessment.reasonCode).toBe(reasonCode);
  });
});

describe("reconciliation backoff", () => {
  it("keeps exponential jitter and Retry-After within the configured cap", () => {
    const low = calculateReconciliationBackoff(1, {
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      jitterRatio: 0.2,
      random: () => 0
    });
    const high = calculateReconciliationBackoff(1, {
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      jitterRatio: 0.2,
      random: () => 1
    });
    const capped = calculateReconciliationBackoff(20, {
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      jitterRatio: 0.2,
      random: () => 1
    }, 30);

    expect(low).toBe(80);
    expect(high).toBe(120);
    expect(capped).toBe(5_000);
  });
});

describe("durable reconciliation leases", () => {
  it("moves an exhausted claimed job to terminal manual review", async () => {
    const now = new Date("2026-09-25T10:30:00.000Z");
    const store = new InMemoryReconciliationJobStore({ clock: () => now });
    const intent = {
      id: "55555555-5555-4555-8555-555555555555",
      userId,
      groupId,
      tenantId,
      bankAccountBindingId: bindingId,
      ledgerAccountId,
      provider: "telebirr" as const,
      providerReferenceHmac: "d".repeat(64),
      sealedProviderReference: {
        provider: "telebirr" as const,
        ciphertext: "encrypted",
        hmac: "d".repeat(64),
        keyVersion: "test-v1"
      },
      amount: "25.00",
      currency: "ETB",
      direction: "inbound" as const,
      occurredAt,
      idempotencyKey: "lease-test",
      requestFingerprint: "e".repeat(64),
      state: "PENDING_RECONCILIATION" as const,
      reasonCode: "AWAITING_PROVIDER_EVIDENCE" as const,
      evidenceFingerprint: null,
      providerTransactionIdentityHmac: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ledgerEntryId: null
    };
    await store.enqueue(intent, 1);
    const claim = await store.claimNext("worker-1", now, 1_000);

    expect(claim?.job.state).toBe("CLAIMED");
    expect(claim?.job.attempt).toBe(1);
    const manual = await store.reschedule(
      claim!.job.id,
      "worker-1",
      claim!.job.leaseToken!,
      "PROVIDER_TIMEOUT",
      new Date(now.getTime() + 1_000)
    );

    expect(manual.state).toBe("MANUAL_REVIEW");
    expect(manual.lastReasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(await store.claimNext("worker-2", new Date(now.getTime() + 60_000), 1_000)).toBeNull();
  });
});

describe("in-memory bank verification", () => {
  it("replays an idempotent intent without a second provider call or raw reference", async () => {
    const providerCall = vi.fn(() => settled);
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: createTestFixtureBankProviderAdapter("telebirr", providerCall) },
      hmacKey: Buffer.alloc(32, 1)
    });

    const first = await service.create(request, { userId });
    const replay = await service.create(request, { userId });

    expect(first.replayed).toBe(false);
    expect(first.verification.state).toBe("VERIFIED");
    expect(replay.replayed).toBe(true);
    expect(replay.verification).toEqual(first.verification);
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replay)).not.toContain(request.providerReference);
    expect(JSON.stringify(replay)).not.toContain(senderFingerprint);
  });

  it("does not post a ledger entry for pending or mismatched evidence", async () => {
    const postVerifiedContribution = vi.fn(async () => "55555555-5555-4555-8555-555555555555");
    const pendingService = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: {
        telebirr: createTestFixtureBankProviderAdapter("telebirr", {
          provider: "telebirr",
          kind: "timeout"
        })
      },
      hmacKey: Buffer.alloc(32, 2),
      ledgerSink: { postVerifiedContribution }
    });
    const pending = await pendingService.create(request, { userId });

    expect(pending.verification.state).toBe("PENDING_RECONCILIATION");
    expect(postVerifiedContribution).not.toHaveBeenCalled();

    const mismatchService = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: {
        telebirr: createTestFixtureBankProviderAdapter("telebirr", {
          ...settled,
          evidence: { ...settled.evidence!, amount: "24.99" }
        })
      },
      hmacKey: Buffer.alloc(32, 3),
      ledgerSink: { postVerifiedContribution }
    });
    const rejected = await mismatchService.create(request, { userId });

    expect(rejected.verification.state).toBe("REJECTED");
    expect(rejected.verification.reasonCode).toBe("AMOUNT_MISMATCH");
    expect(postVerifiedContribution).not.toHaveBeenCalled();
  });
});
