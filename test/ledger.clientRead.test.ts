import { describe, expect, it, vi } from "vitest";
import { loadCorrectionTargets, pickGroup } from "@/lib/ledger/clientRead";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GROUP = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OCCURRED = "2026-09-01T09:00:00.000Z";

function entry(id: string, sequence: string, entryType: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    groupId: GROUP,
    occurredAt: OCCURRED,
    sequence,
    entryType,
    correctsEntryId: null,
    postings: [
      { accountId: ACCOUNT_A, direction: "debit", amount: "12000.50" },
      { accountId: ACCOUNT_B, direction: "credit", amount: "12000.50" }
    ],
    ...extra
  };
}

const carried = {
  groupId: GROUP,
  occurredAt: OCCURRED,
  postings: [
    { accountId: ACCOUNT_A, direction: "debit", amount: "12000.50" },
    { accountId: ACCOUNT_B, direction: "credit", amount: "12000.50" }
  ]
};

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
        { id: "e1", type: "contribution", sequence: "7", amount: "12000.50", direction: "inbound", reference: "#7", ...carried },
        { id: "e2", type: "disbursement", sequence: "6", amount: "12000.50", direction: "outbound", reference: "#6", ...carried }
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

  const OTHER = "33333333-3333-4333-8333-333333333333";
  const TWO_GROUPS = { groups: [{ groupId: GROUP, role: "owner" }, { groupId: OTHER, role: "treasurer" }] };

  it("asks for a choice, and does not guess, with several groups and no active one", async () => {
    const d = deps([json(TWO_GROUPS)]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "choose-group" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the active group among several, and the switch decides which one", async () => {
    for (const chosen of [GROUP, OTHER]) {
      const d = deps([json(TWO_GROUPS), json({ entries: [entry("e1", "1", "contribution")] })]);
      const result = await loadCorrectionTargets(d, { groupId: chosen });
      expect(result.status).toBe("ready");
      expect(String(d.fetchImpl.mock.calls[1]?.[0])).toContain(`groupId=${chosen}`);
    }
  });

  it("applies the writer-only rule to the chosen group's role, not to another group's", async () => {
    const groups = { groups: [{ groupId: GROUP, role: "owner" }, { groupId: OTHER, role: "member" }] };
    expect(await loadCorrectionTargets(deps([json(groups)]), { groupId: OTHER })).toEqual({ status: "read-only" });
    expect((await loadCorrectionTargets(deps([json(groups), json({ entries: [] })]), { groupId: GROUP })).status).toBe("empty");
  });

  it("ignores an active group the server did not return for this caller", async () => {
    const foreign = "44444444-4444-4444-8444-444444444444";
    expect(await loadCorrectionTargets(deps([json(TWO_GROUPS)]), { groupId: foreign })).toEqual({ status: "choose-group" });
    // Even with exactly one group a preference that is not among them is never
    // replaced by it: the switcher would say one group while money posts to another.
    const d = deps([json({ groups: [{ groupId: GROUP, role: "owner" }] })]);
    expect(await loadCorrectionTargets(d, { groupId: foreign })).toEqual({ status: "choose-group" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
    // With no preference the only group is still used.
    const only = deps([json({ groups: [{ groupId: GROUP, role: "owner" }] }), json({ entries: [] })]);
    expect((await loadCorrectionTargets(only)).status).toBe("empty");
  });

  it("pickGroup returns null for a missing preference and the only group for none", () => {
    const one = [{ groupId: GROUP }];
    expect(pickGroup(one, "other")).toBeNull();
    expect(pickGroup(one, null)).toBe(one[0]);
    expect(pickGroup(one, GROUP)).toBe(one[0]);
    expect(pickGroup([{ groupId: "a" }, { groupId: "b" }], null)).toBeNull();
  });

  it("returns read-only for a plain member without reading entries", async () => {
    const d = deps([json({ groups: [{ groupId: GROUP, role: "member" }] })]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "read-only" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("loads entries for an owner or a treasurer", async () => {
    for (const role of ["owner", "treasurer"]) {
      const d = deps([json({ groups: [{ groupId: GROUP, role }] }), json({ entries: [entry("e1", "1", "contribution")] })]);
      expect((await loadCorrectionTargets(d)).status).toBe("ready");
    }
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

  it("reports error when a posting has no account id, so a reversal is never guessed", async () => {
    const d = deps([
      json({ groups: [{ groupId: GROUP }] }),
      json({ entries: [entry("e1", "1", "contribution", { postings: [{ direction: "debit", amount: "1.00" }] })] })
    ]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "error" });
  });

  it("reports error rather than guessing at a malformed entry", async () => {
    const d = deps([
      json({ groups: [{ groupId: GROUP }] }),
      json({ entries: [{ id: "e1", sequence: "1", entryType: "contribution", postings: [{ direction: "debit", amount: "bad" }] }] })
    ]);
    expect(await loadCorrectionTargets(d)).toEqual({ status: "error" });
  });
});
