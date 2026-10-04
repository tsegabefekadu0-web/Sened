import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BankVerificationService,
  InMemoryBankVerificationRepository,
  InMemoryReferenceVault,
  type BankAccountBinding,
  type BankProviderResult
} from "@/lib/banking";
import { createTestFixtureBankProviderAdapter } from "@/lib/banking/adapter";
import { toPublicBankVerification } from "@/lib/banking/repository";
import { publicBankVerificationSchema } from "@/lib/banking/schemas";

const userId = "11111111-1111-4111-8111-111111111111";
const bindingId = "33333333-3333-4333-8333-333333333333";
const hmacKey = Buffer.alloc(32, 9);
const B = "••••";

const binding: BankAccountBinding = {
  id: bindingId,
  userId,
  groupId: "22222222-2222-4222-8222-222222222222",
  tenantId: "99999999-9999-4999-8999-999999999999",
  ledgerAccountId: "44444444-4444-4444-8444-444444444444",
  provider: "telebirr",
  currency: "ETB",
  accountLabel: "Treasury",
  accountFingerprintHmac: "c".repeat(64),
  senderFingerprintHmac: "a".repeat(64),
  receiverFingerprintHmac: "b".repeat(64),
  active: true
};

const timeout: BankProviderResult = { provider: "telebirr", kind: "timeout" };

function setup() {
  const repository = new InMemoryBankVerificationRepository({ bindings: [binding] });
  const service = new BankVerificationService({
    repository,
    referenceVault: new InMemoryReferenceVault(hmacKey),
    adapterResolver: () => createTestFixtureBankProviderAdapter("telebirr", timeout),
    hmacKey
  });
  return { repository, service };
}

const request = (providerReference: string, idempotencyKey = "mask-1") => ({
  provider: "telebirr",
  bankAccountBindingId: bindingId,
  providerReference,
  amount: "25.00",
  currency: "ETB",
  direction: "inbound",
  occurredAt: "2026-09-25T10:30:00.000Z",
  idempotencyKey
});

describe("masked reference at intent creation", () => {
  it("stores the masked display form and returns it, never the full reference, to the owner", async () => {
    const { repository, service } = setup();
    const reference = "FT26280ABCD2F42";

    const result = await service.create(request(reference), { userId });

    expect(result.verification.referenceMasked).toBe(`${B}2F42`);
    expect(JSON.stringify(result)).not.toContain(reference);
    expect(JSON.stringify(result)).not.toContain("ABCD");
    const stored = repository.getIntentUnsafe(result.verification.verificationId);
    expect(stored?.referenceDisplay).toBe(`${B}2F42`);
    // The only other copy is the sealed ciphertext; the display never carries it.
    expect(stored?.referenceDisplay).not.toContain(reference);
  });

  it("stores no display for a reference too short to mask, and the response says null", async () => {
    const { repository, service } = setup();

    const result = await service.create(request("A"), { userId });

    expect(result.verification.referenceMasked).toBeNull();
    expect(repository.getIntentUnsafe(result.verification.verificationId)?.referenceDisplay).toBeNull();
  });

  it("masks the trimmed reference the HMAC and ciphertext are made from", async () => {
    const { service } = setup();
    const result = await service.create(request("  TX-SECRET-001  "), { userId });
    expect(result.verification.referenceMasked).toBe(`${B}-001`);
  });

  it("a replay returns the same display without recomputing a different one", async () => {
    const { service } = setup();
    const first = await service.create(request("FT26280ABCD2F42"), { userId });
    const replay = await service.create(request("FT26280ABCD2F42"), { userId });
    expect(replay.replayed).toBe(true);
    expect(replay.verification.referenceMasked).toBe(first.verification.referenceMasked);
  });

  it("the repository refuses to store anything that is not the masked shape", async () => {
    const repository = new InMemoryBankVerificationRepository({ bindings: [binding] });
    const vault = new InMemoryReferenceVault(hmacKey);
    const { createProviderReferenceHmac } = await import("@/lib/banking/vault");
    const hmac = createProviderReferenceHmac("telebirr", "FT26280ABCD2F42", hmacKey);
    const sealed = await vault.seal("telebirr", "FT26280ABCD2F42");
    await expect(
      repository.createIntent(
        {
          bankAccountBindingId: bindingId,
          provider: "telebirr",
          providerReferenceHmac: hmac,
          sealedProviderReference: sealed,
          amount: "25.00",
          currency: "ETB",
          direction: "inbound",
          occurredAt: "2026-09-25T10:30:00.000Z",
          idempotencyKey: "full-ref",
          requestFingerprint: "e".repeat(64),
          referenceDisplay: "FT26280ABCD2F42"
        },
        { userId }
      )
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("the public DTO re-checks the shape and the strict schema accepts only masked values", () => {
    const base = {
      verificationId: "22222222-2222-4222-8222-222222222222",
      provider: "telebirr" as const,
      state: "VERIFIED" as const,
      reasonCode: "VERIFIED" as const,
      amount: "25.00",
      currency: "ETB" as const,
      direction: "inbound" as const,
      occurredAt: "2026-09-25T10:30:00.000Z",
      createdAt: "2026-09-25T10:30:00.000Z",
      updatedAt: "2026-09-25T10:30:01.000Z"
    };
    expect(publicBankVerificationSchema.safeParse({ ...base, referenceMasked: `${B}2F42` }).success).toBe(true);
    expect(publicBankVerificationSchema.safeParse({ ...base, referenceMasked: null }).success).toBe(true);
    expect(publicBankVerificationSchema.safeParse({ ...base, referenceMasked: "FT26280ABCD2F42" }).success).toBe(false);
    const intent = {
      id: base.verificationId,
      userId,
      groupId: binding.groupId,
      tenantId: binding.tenantId,
      bankAccountBindingId: bindingId,
      ledgerAccountId: binding.ledgerAccountId,
      provider: "telebirr" as const,
      providerReferenceHmac: "a".repeat(64),
      sealedProviderReference: { provider: "telebirr" as const, ciphertext: "x", hmac: "a".repeat(64), keyVersion: "v1" },
      amount: "25.00",
      currency: "ETB",
      direction: "inbound" as const,
      occurredAt: base.occurredAt,
      idempotencyKey: "k",
      requestFingerprint: "e".repeat(64),
      state: "PENDING_RECONCILIATION" as const,
      reasonCode: "AWAITING_PROVIDER_EVIDENCE" as const,
      evidenceFingerprint: null,
      providerTransactionIdentityHmac: null,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      ledgerEntryId: null
    };
    expect(toPublicBankVerification({ ...intent, referenceDisplay: "FT26280ABCD2F42" }).referenceMasked).toBeNull();
    expect(toPublicBankVerification({ ...intent, referenceDisplay: `${B}2F42` }).referenceMasked).toBe(`${B}2F42`);
    expect(toPublicBankVerification(intent).referenceMasked).toBeNull();
  });
});
