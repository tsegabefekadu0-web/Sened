import { describe, expect, it, vi } from "vitest";
import { loadCorrectionTargets } from "@/lib/ledger/clientRead";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GROUP = "22222222-2222-4222-8222-222222222222";

function entry(id: string, sequence: string, entryType: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    sequence,
    entryType,
    correctsEntryId: null,
    postings: [
      { direction: "debit", amount: "12000.50" },
      { direction: "credit", amount: "12000.50" }
    ],
    ...extra
  };
}

function deps(responses: Response[]) {
  const fetchImpl = vi.fn();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }
  return { getToken: async () => "tok", fetchImpl };
}

describe("loadCorrectionTargets", () => {
  it("reads the group, then its entries, with the bearer token", async () => {
    const d = deps([
      json({ groups: [{ groupId: GROUP }] }),
      json({ entries: [entry("e1", "7", "contribution"), entry("e2", "6", "disbursement")] })
    ]);
    const result = await loadCorrectionTargets(d);
    expect(result).toEqual({
      status: "ready",
      targets: [
        { id: "e1", type: "contribution", sequence: "7", amount: "12000.50", direction: "inbound", reference: "#7" },
        { id: "e2", type: "disbursement", sequence: "6", amount: "12000.50", direction: "outbound", reference: "#6" }
      ]
    });
    expect(d.fetchImpl.mock.calls[0][0]).toBe("/api/my-groups");
    expect(d.fetchImpl.mock.calls[1][0]).toBe(`/api/ledger/entries?groupId=${GROUP}`);
    expect((d.fetchImpl.mock.calls[1][1].headers as Headers).get("Authorization")).toBe("Bearer tok");
  });

  it("leaves out corrections and entries that already have a correction", async () => {
    const d = deps([
      json({ groups: [{ groupId: GROUP }] }),
      json({
        entries: [
          entry("c1", "8", "correction", { correctsEntryId: "e1" }),
          entry("e1", "7", "contribution"),
          entry("e2", "6", "contribution")
        ]
      })
    ]);
    const result = await loadCorrectionTargets(d);
    expect(result.status === "ready" && result.targets.map((t) => t.id)).toEqual(["e2"]);
  });

  it("reports empty when nothing can be corrected", async () => {
    const d = deps([json({ groups: [{ groupId: GROUP }] }), json({ entries: [] })]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "empty" });
  });

  it("reports no-group without asking for entries", async () => {
    const d = deps([json({ groups: [] })]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "no-group" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to choose between several groups", async () => {
    const d = deps([json({ groups: [{ groupId: GROUP }, { groupId: "33333333-3333-4333-8333-333333333333" }] })]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "multiple-groups" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a 401 from either read to unauthorized", async () => {
    expect(await loadCorrectionTargets(deps([json({ error: "unauthorized" }, 401)]))).toEqual({ status: "unauthorized" });
    expect(
      await loadCorrectionTargets(deps([json({ groups: [{ groupId: GROUP }] }), json({ error: "unauthorized" }, 401)]))
    ).toEqual({ status: "unauthorized" });
  });

  it("returns unauthorized and sends nothing with no token", async () => {
    const fetchImpl = vi.fn();
    expect(await loadCorrectionTargets({ getToken: async () => null, fetchImpl })).toEqual({ status: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports error for a server failure, a 404 or a network failure", async () => {
    expect(await loadCorrectionTargets(deps([json({ error: "storage_failure" }, 502)]))).toEqual({ status: "error" });
    expect(
      await loadCorrectionTargets(deps([json({ groups: [{ groupId: GROUP }] }), json({ error: "not_found" }, 404)]))
    ).toEqual({ status: "error" });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await loadCorrectionTargets({ getToken: async () => "tok", fetchImpl })).toEqual({ status: "error" });
  });

  it("reports error rather than guessing at a malformed entry", async () => {
    const d = deps([
      json({ groups: [{ groupId: GROUP }] }),
      json({ entries: [{ id: "e1", sequence: "1", entryType: "contribution", postings: [{ direction: "debit", amount: "bad" }] }] })
    ]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "error" });
  });
});
