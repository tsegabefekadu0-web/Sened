import { describe, expect, it, vi } from "vitest";
import { loadHomeLedger } from "@/lib/ledger/clientHome";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GROUP = "22222222-2222-4222-8222-222222222222";
const POT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INCOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const accounts = [
  { id: POT, code: "POT_CASH", name: "x", type: "asset" },
  { id: INCOME, code: "CONTRIBUTION_INCOME", name: "y", type: "income" }
];
const groupBody = (role = "member") => ({ groups: [{ groupId: GROUP, role, accounts }] });

function wire(sequence: number, amount = "10.00", entryType = "contribution") {
  return {
    id: `e${sequence}`,
    groupId: GROUP,
    occurredAt: "2026-09-01T09:00:00.000Z",
    sequence: String(sequence),
    entryType,
    correctsEntryId: null,
    postings: [
      { accountId: POT, direction: "debit", amount },
      { accountId: INCOME, direction: "credit", amount }
    ]
  };
}

function deps(responses: Response[]) {
  const fetchImpl = vi.fn();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }
  return { getToken: async () => "tok", fetchImpl };
}

describe("loadHomeLedger", () => {
  it("reads the group and its entries (max page) and totals the pot, for a plain member too", async () => {
    const d = deps([json(groupBody("member")), json({ entries: [wire(2, "5.05"), wire(1, "10.00")] })]);
    const result = await loadHomeLedger(d);
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.summary.potBalance).toBe("15.05");
    expect(result.status === "ready" && result.summary.contributions.map((c) => c.id)).toEqual(["e2", "e1"]);
    expect(d.fetchImpl.mock.calls[1][0]).toBe(`/api/ledger/entries?groupId=${GROUP}&limit=100`);
  });

  it("is empty when the group has no entries", async () => {
    expect(await loadHomeLedger(deps([json(groupBody()), json({ entries: [] })]))).toEqual({ status: "empty" });
  });

  it.each([
    ["no group", [json({ groups: [] })], "no-group"],
    ["several groups", [json({ groups: [{ groupId: GROUP }, { groupId: GROUP }] })], "multiple-groups"],
    ["a 401 on groups", [json({}, 401)], "unauthorized"],
    ["a 401 on entries", [json(groupBody()), json({}, 401)], "unauthorized"],
    ["a 502 on groups", [json({}, 502)], "error"],
    ["a 502 on entries", [json(groupBody()), json({}, 502)], "error"],
    ["a malformed entry", [json(groupBody()), json({ entries: [{ id: "x" }] })], "error"],
    ["a malformed amount", [json(groupBody()), json({ entries: [wire(1, "1.234")] })], "error"],
    ["a chart with no pot account", [json({ groups: [{ groupId: GROUP, accounts: [accounts[1]] }] }), json({ entries: [wire(1)] })], "error"]
  ])("reports %s distinctly", async (_name, responses, status) => {
    expect((await loadHomeLedger(deps(responses as Response[]))).status).toBe(status);
  });

  it("is unauthorized when there is no token, and an error when the network throws", async () => {
    expect((await loadHomeLedger({ getToken: async () => null, fetchImpl: vi.fn() })).status).toBe("unauthorized");
    expect((await loadHomeLedger({ getToken: async () => "t", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) })).status).toBe("error");
  });

  it("refuses to total a ledger longer than one read", async () => {
    const page = Array.from({ length: 100 }, (_, i) => wire(150 - i));
    expect((await loadHomeLedger(deps([json(groupBody()), json({ entries: page })]))).status).toBe("incomplete");
  });

  it("totals a full read that reaches sequence 1", async () => {
    const page = Array.from({ length: 100 }, (_, i) => wire(100 - i, "1.00"));
    const result = await loadHomeLedger(deps([json(groupBody()), json({ entries: page })]));
    expect(result.status === "ready" && result.summary.potBalance).toBe("100.00");
  });
});
