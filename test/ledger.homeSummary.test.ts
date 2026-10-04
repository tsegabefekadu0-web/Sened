import { describe, expect, it } from "vitest";
import { formatPotBalance, summarizeContributions, summarizeLedger, type SummaryEntry } from "@/lib/ledger/homeSummary";

const POT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INCOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXPENSE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const accounts = [
  { id: INCOME, code: "CONTRIBUTION_INCOME" },
  { id: POT, code: "POT_CASH" },
  { id: EXPENSE, code: "PAYOUT_EXPENSE" }
];

function entry(
  id: string,
  sequence: string,
  entryType: SummaryEntry["entryType"],
  postings: Array<[string, "debit" | "credit", string]>,
  correctsEntryId: string | null = null
): SummaryEntry {
  return {
    id,
    sequence,
    occurredAt: "2026-09-01T09:00:00.000Z",
    entryType,
    correctsEntryId,
    postings: postings.map(([accountId, direction, amount]) => ({ accountId, direction, amount }))
  };
}

const contribution = (id: string, sequence: string, amount: string) =>
  entry(id, sequence, "contribution", [[POT, "debit", amount], [INCOME, "credit", amount]]);
const payout = (id: string, sequence: string, amount: string) =>
  entry(id, sequence, "disbursement", [[EXPENSE, "debit", amount], [POT, "credit", amount]]);

describe("summarizeLedger", () => {
  it("balances the pot cash account: contributions in, payouts out, exact to the cent", () => {
    const summary = summarizeLedger(
      [payout("p1", "4", "1000.10"), contribution("c3", "3", "0.20"), contribution("c2", "2", "0.10"), contribution("c1", "1", "2000.00")],
      accounts
    );
    // 2000.00 + 0.10 + 0.20 - 1000.10: a float sum of these is 1000.2000000000001-ish.
    expect(summary.potBalance).toBe("1000.20");
  });

  it("does not count postings on other accounts", () => {
    const summary = summarizeLedger([contribution("c1", "1", "50.00")], accounts);
    expect(summary.potBalance).toBe("50.00");
  });

  it("counts a correction's reversing postings and drops the corrected contribution from the feed", () => {
    const reversal = entry("r1", "3", "correction", [[INCOME, "debit", "75.00"], [POT, "credit", "75.00"]], "c2");
    const summary = summarizeLedger([reversal, contribution("c2", "2", "75.00"), contribution("c1", "1", "25.00")], accounts);
    expect(summary.potBalance).toBe("25.00");
    expect(summary.contributions.map((c) => c.id)).toEqual(["c1"]);
  });

  it("lists contributions newest first by sequence, not by input order", () => {
    const summary = summarizeLedger([contribution("c2", "9", "1.00"), contribution("c10", "10", "2.00"), contribution("c1", "2", "3.00")], accounts);
    expect(summary.contributions.map((c) => c.sequence)).toEqual(["10", "9", "2"]);
    expect(summary.contributions[0]).toMatchObject({ id: "c10", amount: "2.00" });
  });

  it("includes adjustments and journals in the balance but not in the contribution feed", () => {
    const adjustment = entry("a1", "2", "adjustment", [[POT, "debit", "10.00"], [accounts[0].id, "credit", "10.00"]]);
    const summary = summarizeLedger([adjustment, contribution("c1", "1", "5.00")], accounts);
    expect(summary.potBalance).toBe("15.00");
    expect(summary.contributions).toHaveLength(1);
  });

  it("is zero with no entries", () => {
    expect(summarizeLedger([], accounts)).toEqual({ potBalance: "0.00", contributions: [] });
  });

  it("refuses a chart without a pot cash account instead of guessing one", () => {
    expect(() => summarizeLedger([contribution("c1", "1", "5.00")], accounts.filter((a) => a.code !== "POT_CASH"))).toThrow();
  });

  it("refuses a ledger that nets the pot below zero", () => {
    expect(() => summarizeLedger([payout("p1", "1", "5.00")], accounts)).toThrow();
  });

  it("refuses an amount that is not valid money", () => {
    expect(() => summarizeLedger([contribution("c1", "1", "12.345")], accounts)).toThrow();
  });
});

describe("formatPotBalance", () => {
  it("groups a ledger amount without a float round trip", () => {
    expect(formatPotBalance("175000.00")).toBe("175,000.00");
    expect(formatPotBalance("99999999999999999.99")).toBe("99,999,999,999,999,999.99");
  });
  it("formats the sample number", () => {
    expect(formatPotBalance(175000)).toBe("175,000");
  });
});

describe("summarizeContributions", () => {
  it("lists a page's contributions newest first without needing a balance, leaving out corrected ones", () => {
    const reversal = entry("r3", "3", "correction", [[INCOME, "debit", "2.00"], [POT, "credit", "2.00"]], "c2");
    const rows = summarizeContributions([reversal, contribution("c2", "2", "2.00"), contribution("c1", "1", "3.00")], POT);
    expect(rows.map((row) => [row.id, row.amount])).toEqual([["c1", "3.00"]]);
  });

  it("agrees with summarizeLedger on the same entries", () => {
    const entries = [contribution("c3", "3", "1.50"), payout("p2", "2", "1.00"), contribution("c1", "1", "9.00")];
    expect(summarizeContributions(entries, POT)).toEqual(summarizeLedger(entries, accounts).contributions);
  });
});
