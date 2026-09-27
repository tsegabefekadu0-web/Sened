import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  InMemoryLedgerRepository,
  LedgerService,
  verifyLedgerChain,
  type LedgerEntry
} from "@/lib/ledger";
import { bankLedgerIdempotencyKey, LedgerBankVerificationSink } from "@/lib/banking/ledgerSink";
import type { BankVerificationIntent } from "@/lib/banking/types";

/**
 * Bank truth → committed ledger.
 *
 * `BankVerificationLedgerSink` was an interface with zero implementations, so a
 * `VERIFIED` provider result ended at the UI: the product could assert a bank
 * confirmed a contribution while no balanced, hash-chained entry existed
 * anywhere. This is board task #3's definition of done — a test that proves
 * VERIFIED → ledger entry — and, just as importantly, proves the paths where it
 * refuses to write.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const memberId = "abababab-abab-4bab-8bab-abababababab";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";
const expenseAccount = "55555555-5555-4555-8555-555555555555";

function repository(): InMemoryLedgerRepository {
  return new InMemoryLedgerRepository({
    groups: [
      {
        id: groupId,
        tenantId,
        members: [
          { userId, role: "treasurer" },
          { userId: memberId, role: "member" }
        ]
      }
    ],
    accounts: [
      { id: cashAccount, groupId, code: "CASH", name: "Cash", type: "asset" },
      { id: incomeAccount, groupId, code: "INCOME", name: "Contribution income", type: "income" },
      { id: expenseAccount, groupId, code: "EXPENSE", name: "Payout expense", type: "expense" }
    ]
  });
}

function intent(overrides: Partial<BankVerificationIntent> = {}): BankVerificationIntent {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    userId,
    groupId,
    tenantId,
    bankAccountBindingId: "77777777-7777-4777-8777-777777777777",
    ledgerAccountId: cashAccount,
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
    idempotencyKey: "bank-intent-001",
    requestFingerprint: "c".repeat(64),
    state: "VERIFIED",
    reasonCode: "VERIFIED",
    evidenceFingerprint: "d".repeat(64),
    providerTransactionIdentityHmac: "e".repeat(64),
    createdAt: "2026-09-25T10:30:00.000Z",
    updatedAt: "2026-09-25T10:30:01.000Z",
    ledgerEntryId: null,
    ...overrides
  };
}

interface Harness {
  readonly sink: LedgerBankVerificationSink;
  readonly requests: unknown[];
  readonly entries: LedgerEntry[];
}

/**
 * A real `LedgerService` over the in-memory repository, with the requests and
 * the resulting entries recorded so a test can assert on what was actually
 * written rather than on what the sink meant to write.
 */
function harness(
  accounts: (
    intent: BankVerificationIntent
  ) => { cashAccountId: string; counterAccountId: string } | null
): Harness {
  const requests: unknown[] = [];
  const entries: LedgerEntry[] = [];
  const service = new LedgerService(repository());

  return {
    requests,
    entries,
    sink: new LedgerBankVerificationSink({
      ledger: {
        append: async (request, context) => {
          requests.push(request);
          const result = await service.append(request, context);
          entries.push(result.entry);
          return result;
        }
      },
      accounts
    })
  };
}

describe("a verified bank result becomes a balanced, chained ledger entry", () => {
  it("posts a contribution for money arriving", async () => {
    const { sink, requests } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    }));

    const entryId = await sink.postVerifiedContribution(intent());

    expect(entryId).not.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      groupId,
      entryType: "contribution",
      idempotencyKey: "bank-verified-bank-intent-001",
      occurredAt: "2026-09-25T10:30:00.000Z",
      postings: [
        { accountId: cashAccount, direction: "debit", amount: "25.00" },
        { accountId: incomeAccount, direction: "credit", amount: "25.00" }
      ]
    });
  });

  it("leaves the chain verifiable afterwards", async () => {
    const { sink, entries } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    }));

    await sink.postVerifiedContribution(intent());
    await sink.postVerifiedContribution(
      intent({ id: "aaaaaaaa-1111-4111-8111-111111111111", idempotencyKey: "bank-intent-002" })
    );

    expect(verifyLedgerChain(entries)).toEqual({ valid: true, entriesChecked: 2 });
  });

  it("posts a disbursement for money leaving, against an expense", async () => {
    const { sink, requests } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: expenseAccount
    }));

    await sink.postVerifiedContribution(intent({ direction: "outbound" }));

    expect(requests[0]).toMatchObject({
      entryType: "disbursement",
      postings: [
        { accountId: expenseAccount, direction: "debit", amount: "25.00" },
        { accountId: cashAccount, direction: "credit", amount: "25.00" }
      ]
    });
  });

  it("is idempotent, so a retried verification cannot double-count a contribution", async () => {
    const { sink, entries, requests } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    }));

    const first = await sink.postVerifiedContribution(intent());
    const second = await sink.postVerifiedContribution(intent());

    expect(second).toBe(first);
    // Both calls reached the ledger; the second was replayed, so the chain
    // gained no second posting. Dedupe first — the harness records one entry per
    // call, and the chain verifier rightly rejects the same entry listed twice.
    const distinct = Array.from(new Map(entries.map((entry) => [entry.id, entry])).values());
    expect(requests).toHaveLength(2);
    expect(distinct).toHaveLength(1);
    expect(verifyLedgerChain(distinct)).toEqual({ valid: true, entriesChecked: 1 });
  });

  it("namespaces the idempotency key so it cannot collide with the caller's own", () => {
    expect(bankLedgerIdempotencyKey(intent())).toBe("bank-verified-bank-intent-001");
  });
});

describe("it fails closed rather than inventing an entry", () => {
  it("writes nothing when the group has no counter-account configured", async () => {
    const { sink, entries, requests } = harness(() => null);

    expect(await sink.postVerifiedContribution(intent())).toBeNull();
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("writes nothing when the pot account would post against itself", async () => {
    // Two postings to one account balance arithmetically and mean nothing.
    const { sink, entries, requests } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: cashAccount
    }));

    expect(await sink.postVerifiedContribution(intent())).toBeNull();
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("writes nothing when an account id is not a uuid", async () => {
    const { sink, requests } = harness(() => ({
      cashAccountId: "not-a-uuid",
      counterAccountId: incomeAccount
    }));

    expect(await sink.postVerifiedContribution(intent())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("refuses an intent that is not verified, even when called directly", async () => {
    const { sink, entries, requests } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    }));

    await expect(
      sink.postVerifiedContribution(intent({ state: "PENDING_RECONCILIATION" }))
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("surfaces the ledger's own refusal rather than flattening it", async () => {
    const { sink } = harness(() => ({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    }));

    await expect(
      sink.postVerifiedContribution(intent({ groupId: "88888888-8888-4888-8888-888888888888" }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
