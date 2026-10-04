import { describe, expect, it, vi } from "vitest";
import { fetchLedgerBalances, readEntriesPage } from "@/lib/ledger/clientRead";

const GROUP = "22222222-2222-4222-8222-222222222222";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deps = (response: Response | Error) => ({
  getToken: async () => "tok",
  fetchImpl: (response instanceof Error ? vi.fn().mockRejectedValue(response) : vi.fn().mockResolvedValue(response)) as unknown as typeof fetch
});

describe("readEntriesPage", () => {
  it("sends limit and beforeSequence and returns the cursor", async () => {
    const d = deps(json({ entries: [{ id: "a" }], hasMore: true, nextCursor: "41" }));
    const page = await readEntriesPage(GROUP, { limit: 100, beforeSequence: "51" }, d);
    expect(page).toEqual({ status: "ok", entries: [{ id: "a" }], hasMore: true, nextCursor: "41" });
    expect(vi.mocked(d.fetchImpl).mock.calls[0][0]).toBe(`/api/ledger/entries?groupId=${GROUP}&limit=100&beforeSequence=51`);
  });

  it("omits both when not given, and treats a body without hasMore as the last page", async () => {
    const d = deps(json({ entries: [] }));
    expect(await readEntriesPage(GROUP, {}, d)).toEqual({ status: "ok", entries: [], hasMore: false, nextCursor: null });
    expect(vi.mocked(d.fetchImpl).mock.calls[0][0]).toBe(`/api/ledger/entries?groupId=${GROUP}`);
  });

  it.each([
    ["hasMore without a cursor", json({ entries: [], hasMore: true })],
    ["hasMore with a malformed cursor", json({ entries: [], hasMore: true, nextCursor: "0" })],
    ["a body with no entries", json({})],
    ["a server error", json({}, 502)]
  ])("is an error for %s", async (_name, response) => {
    expect((await readEntriesPage(GROUP, {}, deps(response))).status).toBe("error");
  });

  it("maps 401 and a thrown network error", async () => {
    expect((await readEntriesPage(GROUP, {}, deps(json({}, 401)))).status).toBe("unauthorized");
    expect((await readEntriesPage(GROUP, {}, deps(new Error("x")))).status).toBe("error");
    expect((await readEntriesPage(GROUP, {}, { getToken: async () => null, fetchImpl: vi.fn() })).status).toBe("unauthorized");
  });
});

describe("fetchLedgerBalances", () => {
  const body = {
    groupId: GROUP,
    headSequence: "7",
    entryCount: "7",
    balances: [{ accountId: "a", code: "POT_CASH", name: "n", accountType: "asset", balance: "1234567890123456.50" }]
  };

  it("keeps the balance as the exact string the server sent", async () => {
    const d = deps(json(body));
    const result = await fetchLedgerBalances(GROUP, d);
    expect(result).toEqual({
      status: "ok",
      headSequence: "7",
      entryCount: "7",
      balances: [{ accountId: "a", code: "POT_CASH", accountType: "asset", balance: "1234567890123456.50" }]
    });
    expect(vi.mocked(d.fetchImpl).mock.calls[0][0]).toBe(`/api/ledger/balances?groupId=${GROUP}`);
  });

  it.each([
    ["a numeric balance", { ...body, balances: [{ ...body.balances[0], balance: 12.5 }] }],
    ["a one-decimal balance", { ...body, balances: [{ ...body.balances[0], balance: "12.5" }] }],
    ["a numeric head", { ...body, headSequence: 7 }],
    ["a missing list", { ...body, balances: undefined }]
  ])("is an error for %s", async (_name, bad) => {
    expect((await fetchLedgerBalances(GROUP, deps(json(bad)))).status).toBe("error");
  });

  it("maps 401, 404 and a thrown network error", async () => {
    expect((await fetchLedgerBalances(GROUP, deps(json({}, 401)))).status).toBe("unauthorized");
    expect((await fetchLedgerBalances(GROUP, deps(json({}, 404)))).status).toBe("error");
    expect((await fetchLedgerBalances(GROUP, deps(new Error("x")))).status).toBe("error");
  });
});
