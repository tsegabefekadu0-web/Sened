import { describe, expect, it } from "vitest";
import { normalizeLedgerEntryRequest, validateBalancedPostings } from "@/lib/ledger";

const accountDebit = "33333333-3333-4333-8333-333333333333";
const accountCredit = "44444444-4444-4444-8444-444444444444";

function posting(accountId: string, direction: "debit" | "credit", amount: string) {
  return { accountId, direction, amount };
}

describe("double-entry rules", () => {
  it("accepts exactly balanced positive lines", () => {
    const result = validateBalancedPostings([
      posting(accountDebit, "debit", "25.00"),
      posting(accountCredit, "credit", "25.00")
    ]);

    expect(result).toEqual({ debits: "25.00", credits: "25.00" });
  });

  it("rejects unbalanced, zero, and non-positive lines", () => {
    expect(() =>
      validateBalancedPostings([
        posting(accountDebit, "debit", "25.00"),
        posting(accountCredit, "credit", "24.99")
      ])
    ).toThrow(/balance/i);
    expect(() =>
      validateBalancedPostings([
        posting(accountDebit, "debit", "0.00"),
        posting(accountCredit, "credit", "0.00")
      ])
    ).toThrow(/positive/i);
  });

  it("rejects duplicate account and direction lines", () => {
    expect(() =>
      validateBalancedPostings([
        posting(accountDebit, "debit", "10.00"),
        posting(accountDebit, "debit", "10.00"),
        posting(accountCredit, "credit", "20.00")
      ])
    ).toThrow(/duplicate/i);
  });

  it("requires correction-only target and rationale fields", () => {
    expect(() =>
      normalizeLedgerEntryRequest({
        groupId: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: "entry-001",
        occurredAt: "2026-09-25T10:30:00.000Z",
        entryType: "journal",
        correctsEntryId: "55555555-5555-4555-8555-555555555555",
        rationale: "A sufficiently detailed correction reason",
        postings: [
          posting(accountDebit, "debit", "10.00"),
          posting(accountCredit, "credit", "10.00")
        ]
      })
    ).toThrow(/corrections/i);
  });
});
