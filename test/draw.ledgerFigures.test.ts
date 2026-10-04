import { describe, expect, it } from "vitest";

import { cycleLedgerFigures, loadCycleLedgerFigures } from "@/lib/draw/ledgerFigures";
import type { HomeContribution } from "@/lib/ledger/homeSummary";

const contribution = (sequence: string, occurredAt: string, amount: string): HomeContribution => ({
  id: `entry-${sequence}`,
  sequence,
  occurredAt,
  amount
});

describe("cycleLedgerFigures", () => {
  it("totals, in exact minor units, only the contributions on or after the cycle's start", () => {
    const figures = cycleLedgerFigures(
      [
        contribution("3", "2026-10-03T09:00:00.000Z", "2000.10"),
        contribution("2", "2026-10-01T10:00:00.000Z", "1000.20"),
        contribution("1", "2026-09-01T09:00:00.000Z", "500.00")
      ],
      "2026-10-01T10:00:00.000Z"
    );
    expect(figures).toEqual({ count: 2, total: "3000.30" });
  });

  it("is zero, not an error, when nothing falls in the cycle", () => {
    expect(cycleLedgerFigures([contribution("1", "2026-01-01T00:00:00.000Z", "10.00")], "2026-10-01T00:00:00.000Z")).toEqual({
      count: 0,
      total: "0.00"
    });
  });

  it("offers no per-member or per-round figure: the shape has only a count and a total", () => {
    // Ledger entries carry no member id and no cycle or round id, so anything
    // more would be invented. This pins the honest shape.
    expect(Object.keys(cycleLedgerFigures([], "2026-10-01T00:00:00.000Z")).sort()).toEqual(["count", "total"]);
  });
});

describe("loadCycleLedgerFigures", () => {
  const deps = (entries: unknown[], status = 200) => ({
    getToken: async () => "token",
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/my-groups")) {
        return Response.json({ groups: [{ groupId: "g", role: "member", accounts: [{ id: "cash", code: "POT_CASH" }] }] });
      }
      return Response.json({ entries }, { status });
    }) as typeof fetch
  });

  const entry = (sequence: string, occurredAt: string, amount: string) => ({
    id: `e${sequence}`,
    groupId: "g",
    occurredAt,
    sequence,
    entryType: "contribution",
    correctsEntryId: null,
    postings: [
      { accountId: "cash", direction: "debit", amount },
      { accountId: "income", direction: "credit", amount }
    ]
  });

  it("reads the ledger the way the home screen does and totals the cycle", async () => {
    const result = await loadCycleLedgerFigures(
      "2026-10-01T00:00:00.000Z",
      deps([entry("2", "2026-10-02T00:00:00.000Z", "1000.00"), entry("1", "2026-09-01T00:00:00.000Z", "250.00")])
    );
    expect(result).toEqual({ status: "ready", figures: { count: 1, total: "1000.00" } });
  });

  it("says the ledger is empty rather than inventing a zero total", async () => {
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", deps([]))).toEqual({ status: "empty" });
  });

  it("says unavailable when the ledger cannot be read", async () => {
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", deps([], 500))).toEqual({ status: "unavailable" });
  });

  it("refuses to total a ledger longer than one read returns", async () => {
    const many = Array.from({ length: 100 }, (_, index) => entry(String(index + 2), "2026-10-02T00:00:00.000Z", "1.00"));
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", deps(many))).toEqual({ status: "incomplete" });
  });
});
