import { describe, expect, it } from "vitest";

import { cycleLedgerFigures, loadCycleLedgerFigures } from "@/lib/draw/ledgerFigures";
import type { HomeContribution } from "@/lib/ledger/homeSummary";

const ALEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BERHAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const contribution = (
  sequence: string,
  occurredAt: string,
  amount: string,
  payer?: string
): HomeContribution => ({
  id: `entry-${sequence}`,
  sequence,
  occurredAt,
  amount,
  provenance: payer
    ? { provider: "telebirr", verifiedAt: occurredAt, verificationId: `ffffffff-ffff-4fff-8fff-${sequence.padStart(12, "0")}`, memberUserId: payer, referenceMasked: null }
    : null
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
    expect(figures).toMatchObject({ count: 2, total: "3000.30" });
  });

  it("is zero, not an error, when nothing falls in the cycle", () => {
    expect(cycleLedgerFigures([contribution("1", "2026-01-01T00:00:00.000Z", "10.00")], "2026-10-01T00:00:00.000Z")).toEqual({
      count: 0,
      total: "0.00",
      byMember: [],
      unattributedCount: 0,
      unattributedTotal: "0.00"
    });
  });

  it("credits a member only for entries a verified bank receipt posted for them", () => {
    const figures = cycleLedgerFigures(
      [
        contribution("5", "2026-10-05T09:00:00.000Z", "1000.00", ALEM),
        contribution("4", "2026-10-04T09:00:00.000Z", "250.50", BERHAN),
        contribution("3", "2026-10-03T09:00:00.000Z", "1000.00", ALEM),
        contribution("2", "2026-10-02T09:00:00.000Z", "300.00"),
        contribution("1", "2026-09-01T09:00:00.000Z", "999.00", BERHAN)
      ],
      "2026-10-01T00:00:00.000Z"
    );
    expect(figures.byMember).toEqual([
      { memberUserId: ALEM, count: 2, total: "2000.00" },
      { memberUserId: BERHAN, count: 1, total: "250.50" }
    ]);
    // The entry before the cycle began is neither counted nor credited.
    expect(figures.count).toBe(4);
    expect(figures.total).toBe("2550.50");
  });

  it("keeps an entry with no bank provenance unattributed instead of guessing its payer", () => {
    const figures = cycleLedgerFigures(
      [contribution("2", "2026-10-02T09:00:00.000Z", "300.00"), contribution("1", "2026-10-01T09:00:00.000Z", "50.25", ALEM)],
      "2026-10-01T00:00:00.000Z"
    );
    expect(figures.unattributedCount).toBe(1);
    expect(figures.unattributedTotal).toBe("300.00");
    expect(figures.byMember).toEqual([{ memberUserId: ALEM, count: 1, total: "50.25" }]);
    // Attributed + unattributed always reconciles with the cycle total.
    expect(figures.total).toBe("350.25");
  });

  it("lists no member at all when no entry carries provenance", () => {
    const figures = cycleLedgerFigures([contribution("1", "2026-10-02T09:00:00.000Z", "10.00")], "2026-10-01T00:00:00.000Z");
    expect(figures.byMember).toEqual([]);
    expect(figures.unattributedCount).toBe(1);
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
    expect(result).toMatchObject({ status: "ready", figures: { count: 1, total: "1000.00" } });
  });

  it("attributes a wire entry to the member named by its bank provenance and not to its actor", async () => {
    const payer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const bankEntry = {
      ...entry("2", "2026-10-02T00:00:00.000Z", "1000.00"),
      actorId: "11111111-1111-4111-8111-111111111111",
      provenance: {
        kind: "bank_verification",
        provider: "telebirr",
        verifiedAt: "2026-10-02T00:00:05.000Z",
        verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        memberUserId: payer
      }
    };
    const result = await loadCycleLedgerFigures(
      "2026-10-01T00:00:00.000Z",
      deps([bankEntry, entry("3", "2026-10-03T00:00:00.000Z", "40.00")])
    );
    expect(result).toMatchObject({
      status: "ready",
      figures: {
        count: 2,
        total: "1040.00",
        byMember: [{ memberUserId: payer, count: 1, total: "1000.00" }],
        unattributedCount: 1,
        unattributedTotal: "40.00"
      }
    });
  });

  it("says the ledger is empty rather than inventing a zero total", async () => {
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", deps([]))).toEqual({ status: "empty" });
  });

  it("says unavailable when the ledger cannot be read", async () => {
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", deps([], 500))).toEqual({ status: "unavailable" });
  });

  /** A server over `all` (newest first) that honours limit and beforeSequence like the real route. */
  const pagedDeps = (all: ReturnType<typeof entry>[] & { recordedAt?: string }[], calls: string[] = []) => ({
    getToken: async () => "token",
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/my-groups")) {
        return Response.json({ groups: [{ groupId: "g", role: "member", accounts: [{ id: "cash", code: "POT_CASH" }] }] });
      }
      calls.push(url);
      const params = new URL(url, "http://localhost").searchParams;
      const limit = Number(params.get("limit") ?? "50");
      const before = params.get("beforeSequence");
      const eligible = all.filter((row) => before === null || BigInt(row.sequence) < BigInt(before));
      const entries = eligible.slice(0, limit);
      const hasMore = eligible.length > limit;
      return Response.json({
        entries,
        hasMore,
        nextCursor: hasMore ? entries[entries.length - 1].sequence : null
      });
    }) as typeof fetch
  });

  const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
  const recorded = (row: ReturnType<typeof entry>) => ({ ...row, recordedAt: row.occurredAt });

  it("pages back through a group of more than 100 entries so the whole cycle is attributed", async () => {
    // 250 entries: the oldest 50 are before the cycle (September), the newest 200 are in it.
    const all = Array.from({ length: 250 }, (_, index) => {
      const sequence = 250 - index;
      return recorded(entry(String(sequence), sequence > 50 ? day(5) : "2026-09-01T00:00:00.000Z", "2.00"));
    });
    const calls: string[] = [];
    const result = await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all, calls));
    expect(result).toMatchObject({ status: "ready", figures: { count: 200, total: "400.00", unattributedCount: 200 } });
    expect(calls).toEqual([
      "/api/ledger/entries?groupId=g&limit=100",
      "/api/ledger/entries?groupId=g&limit=100&beforeSequence=151",
      "/api/ledger/entries?groupId=g&limit=100&beforeSequence=51"
    ]);
  });

  it("stops paging once a page reaches entries recorded before the cycle, even if the ledger is longer", async () => {
    const all = Array.from({ length: 1000 }, (_, index) => {
      const sequence = 1000 - index;
      return recorded(entry(String(sequence), sequence > 950 ? day(5) : "2026-09-01T00:00:00.000Z", "1.00"));
    });
    const calls: string[] = [];
    const result = await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all, calls));
    expect(result).toMatchObject({ status: "ready", figures: { count: 50, total: "50.00" } });
    expect(calls).toHaveLength(1);
  });

  it("counts a backdated entry only if it occurred in the cycle, and keeps paging past it", async () => {
    // Sequence 150 is recorded in October but backdated to September: it must not
    // end the paging (older in-cycle entries exist) and must not be counted.
    const all = Array.from({ length: 150 }, (_, index) => {
      const sequence = 150 - index;
      return { ...entry(String(sequence), sequence === 150 ? "2026-09-15T00:00:00.000Z" : day(5), "1.00"), recordedAt: day(5) };
    });
    const result = await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all));
    expect(result).toMatchObject({ status: "ready", figures: { count: 149 } });
  });

  it("says incomplete, with no total, only when the page bound is hit before the cycle start", async () => {
    const all = Array.from({ length: 450 }, (_, index) => recorded(entry(String(450 - index), day(5), "1.00")));
    const calls: string[] = [];
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all, calls), 3)).toEqual({ status: "incomplete" });
    expect(calls).toHaveLength(3);
    // The same ledger within a larger bound is read in full.
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all), 5)).toMatchObject({
      status: "ready",
      figures: { count: 450, total: "450.00" }
    });
  });

  it("is not incomplete when the bound is reached exactly on the last page", async () => {
    const all = Array.from({ length: 300 }, (_, index) => recorded(entry(String(300 - index), day(5), "1.00")));
    expect(await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", pagedDeps(all), 3)).toMatchObject({
      status: "ready",
      figures: { count: 300 }
    });
  });

  it("is unavailable when a later page cannot be read", async () => {
    let calls = 0;
    const base = pagedDeps(Array.from({ length: 250 }, (_, index) => recorded(entry(String(250 - index), day(5), "1.00"))));
    const result = await loadCycleLedgerFigures("2026-10-01T00:00:00.000Z", {
      getToken: base.getToken,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/ledger/entries") && (calls += 1) === 2) return new Response("{}", { status: 502 });
        return base.fetchImpl(input, init);
      }) as typeof fetch
    });
    expect(result).toEqual({ status: "unavailable" });
  });
});
