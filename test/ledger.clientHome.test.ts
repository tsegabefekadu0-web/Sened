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

/** `GET /api/ledger/balances` body: the pot and income nets at `head`, over `count` entries. */
function balancesBody(pot: string, head: number, count = head) {
  return {
    groupId: GROUP,
    headSequence: String(head),
    entryCount: String(count),
    balances: [
      { accountId: POT, code: "POT_CASH", name: "x", accountType: "asset", balance: pot },
      { accountId: INCOME, code: "CONTRIBUTION_INCOME", name: "y", accountType: "income", balance: pot.startsWith("-") ? pot.slice(1) : `-${pot}` }
    ]
  };
}

const page = (entries: unknown[], hasMore = false, nextCursor: string | null = null) => ({ entries, hasMore, nextCursor });

describe("loadHomeLedger", () => {
  it("takes the pot from the balances endpoint and reads the feed up to that head, for a plain member too", async () => {
    const d = deps([
      json(groupBody("member")),
      json(balancesBody("15.05", 2)),
      json(page([wire(2, "5.05"), wire(1, "10.00")]))
    ]);
    const result = await loadHomeLedger(d);
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.summary.potBalance).toBe("15.05");
    expect(result.status === "ready" && result.summary.contributions.map((c) => c.id)).toEqual(["e2", "e1"]);
    expect(result.status === "ready" && result.feedTruncated).toBe(false);
    expect(d.fetchImpl.mock.calls[1][0]).toBe(`/api/ledger/balances?groupId=${GROUP}`);
    // The feed ends exactly at the snapshot's head: sequence < head + 1.
    expect(d.fetchImpl.mock.calls[2][0]).toBe(`/api/ledger/entries?groupId=${GROUP}&limit=100&beforeSequence=3`);
  });

  it("gives a group with more than 100 entries a balance (the old 'incomplete' case) and a truncated feed", async () => {
    const recent = Array.from({ length: 100 }, (_, i) => wire(250 - i, "2.00"));
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("500.00", 250)), json(page(recent, true, "151"))])
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // The balance is the server's figure, not the sum of the 100 entries shown (200.00).
    expect(result.summary.potBalance).toBe("500.00");
    expect(result.summary.contributions).toHaveLength(100);
    expect(result.summary.contributions[0].sequence).toBe("250");
    expect(result.feedTruncated).toBe(true);
  });

  it("totals a ledger of exactly one page and checks the page against the server balance", async () => {
    const full = Array.from({ length: 100 }, (_, i) => wire(100 - i, "1.00"));
    const result = await loadHomeLedger(deps([json(groupBody()), json(balancesBody("100.00", 100)), json(page(full))]));
    expect(result.status === "ready" && result.summary.potBalance).toBe("100.00");
    expect(result.status === "ready" && result.feedTruncated).toBe(false);
  });

  it("refuses contradictory numbers: a complete page that does not add up to the server balance", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("99.00", 2)), json(page([wire(2, "5.00"), wire(1, "10.00")]))])
    );
    expect(result.status).toBe("error");
  });

  it("refuses an entry newer than the balance snapshot rather than showing it beside a balance that lacks it", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("10.00", 1)), json(page([wire(2, "5.00"), wire(1, "10.00")]))])
    );
    expect(result.status).toBe("error");
  });

  it("is empty when the snapshot has no entries, without reading the feed", async () => {
    const d = deps([json(groupBody()), json(balancesBody("0.00", 0))]);
    expect(await loadHomeLedger(d)).toEqual({ status: "empty" });
    expect(d.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("errors on a negative pot, as before", async () => {
    expect((await loadHomeLedger(deps([json(groupBody()), json(balancesBody("-5.00", 1)), json(page([wire(1)]))]))).status).toBe("error");
  });

  it("errors when the balances have no pot account, or are malformed", async () => {
    const noPot = { ...balancesBody("1.00", 1), balances: [balancesBody("1.00", 1).balances[1]] };
    expect((await loadHomeLedger(deps([json(groupBody()), json(noPot)]))).status).toBe("error");
    for (const bad of [
      { ...balancesBody("1.00", 1), headSequence: "01" },
      { ...balancesBody("1.00", 1), entryCount: 1 },
      { ...balancesBody("1.5", 1) },
      { ...balancesBody("1.00", 1), balances: "x" },
      balancesBody("1.00", 0, 1),
      balancesBody("1.00", 1, 5),
      balancesBody("5.00", 0, 0)
    ]) {
      expect((await loadHomeLedger(deps([json(groupBody()), json(bad), json(page([wire(1, "1.00")]))]))).status).toBe("error");
    }
  });

  it("rejects a feed that says there is more but gives no usable cursor", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("1.00", 5)), json({ entries: [wire(5, "1.00")], hasMore: true })])
    );
    expect(result.status).toBe("error");
  });

  it.each([
    ["no group", [json({ groups: [] })], "no-group"],
    ["several groups and none chosen", [json({ groups: [{ groupId: GROUP }, { groupId: "33333333-3333-4333-8333-333333333333" }] })], "choose-group"],
    ["a 401 on groups", [json({}, 401)], "unauthorized"],
    ["a 401 on balances", [json(groupBody()), json({}, 401)], "unauthorized"],
    ["a 401 on entries", [json(groupBody()), json(balancesBody("10.00", 1)), json({}, 401)], "unauthorized"],
    ["a 502 on groups", [json({}, 502)], "error"],
    ["a 502 on balances", [json(groupBody()), json({}, 502)], "error"],
    ["a 502 on entries", [json(groupBody()), json(balancesBody("10.00", 1)), json({}, 502)], "error"],
    ["a malformed entry", [json(groupBody()), json(balancesBody("10.00", 1)), json(page([{ id: "x" }]))], "error"],
    ["a malformed amount", [json(groupBody()), json(balancesBody("1.23", 1)), json(page([wire(1, "1.234")]))], "error"]
  ])("reports %s distinctly", async (_name, responses, status) => {
    expect((await loadHomeLedger(deps(responses as Response[]))).status).toBe(status);
  });

  it("is unauthorized when there is no token, and an error when the network throws", async () => {
    expect((await loadHomeLedger({ getToken: async () => null, fetchImpl: vi.fn() })).status).toBe("unauthorized");
    expect((await loadHomeLedger({ getToken: async () => "t", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) })).status).toBe("error");
  });
});

describe("loadHomeLedger provenance", () => {
  const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const proof = {
    kind: "bank_verification",
    provider: "cbe",
    verifiedAt: "2026-09-01T09:00:05.000Z",
    verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    memberUserId: PAYER
  };
  const members = (email: string | null) => ({
    members: [{ userId: PAYER, role: "member", joinedAt: "2026-08-01T00:00:00.000Z", email }]
  });

  it("carries a complete provenance object onto the contribution and names the payer from the members API", async () => {
    const d = deps([
      json(groupBody()),
      json(balancesBody("20.00", 2)),
      json({ entries: [{ ...wire(2), provenance: proof }, wire(1)] }),
      json(members(null))
    ]);
    const result = await loadHomeLedger(d);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const [bank, plain] = result.summary.contributions;
    expect(bank.provenance).toEqual({
      provider: "cbe",
      verifiedAt: proof.verifiedAt,
      verificationId: proof.verificationId,
      memberUserId: PAYER,
      referenceMasked: null
    });
    expect(plain.provenance).toBeNull();
    // The members API showed this caller no email, so none is invented.
    expect(result.memberLabels).toEqual({ [PAYER]: null });
    expect(d.fetchImpl.mock.calls[3][0]).toBe(`/api/ledger/members?groupId=${GROUP}`);
  });

  it("passes on an email only when the members API already returned one", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), provenance: proof }] }), json(members("payer@example.test"))])
    );
    expect(result.status === "ready" && result.memberLabels).toEqual({ [PAYER]: "payer@example.test" });
  });

  it("does not read the members when nothing is bank-verified", async () => {
    const d = deps([json(groupBody()), json(balancesBody("10.00", 1)), json({ entries: [wire(1)] })]);
    const result = await loadHomeLedger(d);
    expect(d.fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.status === "ready" && result.memberLabels).toEqual({});
  });

  it("carries a masked reference and drops anything that is not exactly the masked shape", async () => {
    const masked = "\u2022\u2022\u2022\u20222F42";
    const read = async (referenceMasked: unknown) => {
      const result = await loadHomeLedger(
        deps([
          json(groupBody()),
          json(balancesBody("10.00", 1)),
          json({ entries: [{ ...wire(1), provenance: { ...proof, referenceMasked } }] }),
          json(members(null))
        ])
      );
      expect(result.status).toBe("ready");
      return result.status === "ready" ? result.summary.contributions[0].provenance : undefined;
    };
    expect((await read(masked))?.referenceMasked).toBe(masked);
    // The row stays verified (the rest of the proof is intact); only the reference is dropped.
    for (const bad of ["FT26268ABCD1234", "2F42", "\u2022\u2022\u2022\u2022123456", 42, null, undefined]) {
      const provenance = await read(bad);
      expect(provenance?.referenceMasked, String(bad)).toBeNull();
      expect(provenance?.provider).toBe("cbe");
    }
  });

  it("returns each named member's own attire from the members read, and none for one it did not return", async () => {
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const result = await loadHomeLedger(
      deps([
        json(groupBody()),
        json(balancesBody("20.00", 2)),
        json({ entries: [{ ...wire(1), provenance: proof }, { ...wire(2), provenance: { ...proof, memberUserId: other, verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" } }] }),
        json({ members: [{ userId: PAYER, role: "member", joinedAt: "2026-08-01T00:00:00.000Z", email: null, attire: "netela" }] })
      ])
    );
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.memberAttire).toEqual({ [PAYER]: "netela" });
  });

  it("keeps the verified contribution when the members cannot be read", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), provenance: proof }] }), json({}, 502)])
    );
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.summary.contributions[0].provenance?.memberUserId).toBe(PAYER);
    expect(result.status === "ready" && result.memberLabels).toEqual({});
  });

  it.each([
    ["an unknown provider", { ...proof, provider: "paypal" }],
    ["a missing verification id", { ...proof, verificationId: undefined }],
    ["a non-uuid member", { ...proof, memberUserId: "someone" }],
    ["an unparseable time", { ...proof, verifiedAt: "yesterday" }],
    ["the wrong kind", { ...proof, kind: "manual" }],
    ["a bare string", "verified"]
  ])("treats %s as no provenance, so the row is never half-verified", async (_name, bad) => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), provenance: bad }] })])
    );
    expect(result.status === "ready" && result.summary.contributions[0].provenance).toBeNull();
  });
});

describe("loadHomeLedger attribution (who paid a cash contribution)", () => {
  const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const RECORDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const record = {
    source: "treasurer",
    memberUserId: PAYER,
    recordedBy: RECORDER,
    recordedAt: "2026-10-10T09:00:00.000Z",
    cycleId: null,
    round: null,
    revision: 1,
    reason: null,
    channel: null,
    note: null
  };
  const proof = {
    kind: "bank_verification",
    provider: "cbe",
    verifiedAt: "2026-09-01T09:00:05.000Z",
    verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    memberUserId: OTHER
  };
  const members = {
    members: [
      { userId: PAYER, role: "member", joinedAt: "2026-08-01T00:00:00.000Z", email: "payer@example.test" },
      { userId: OTHER, role: "member", joinedAt: "2026-08-01T00:00:00.000Z", email: null }
    ]
  };

  it("carries the treasurer's record onto the contribution and names the payer from the members API", async () => {
    const d = deps([
      json(groupBody()),
      json(balancesBody("20.00", 2)),
      json({ entries: [{ ...wire(2), attribution: record }, wire(1)] }),
      json(members)
    ]);
    const result = await loadHomeLedger(d);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const [attributed, plain] = result.summary.contributions;
    expect(attributed.provenance).toBeNull();
    expect(attributed.attribution).toEqual(record);
    expect(plain.attribution).toBeNull();
    expect(result.memberLabels).toEqual({ [PAYER]: "payer@example.test" });
  });

  it("carries the treasurer's channel and note, and treats an older server's record (neither key) as not stated", async () => {
    const withBoth = { ...record, channel: "cash", note: "Brought by his brother" };
    const { channel: _c, note: _n, ...older } = record;
    const result = await loadHomeLedger(
      deps([
        json(groupBody()),
        json(balancesBody("20.00", 2)),
        json({ entries: [{ ...wire(2), attribution: withBoth }, { ...wire(1), attribution: older }] }),
        json(members)
      ])
    );
    if (result.status !== "ready") throw new Error("not ready");
    const [first, second] = result.summary.contributions;
    expect(first.attribution).toMatchObject({ channel: "cash", note: "Brought by his brother" });
    expect(second.attribution).toMatchObject({ channel: null, note: null });
  });

  it("drops a channel outside the list and a non-text note instead of showing them", async () => {
    const result = await loadHomeLedger(
      deps([
        json(groupBody()),
        json(balancesBody("10.00", 1)),
        json({ entries: [{ ...wire(1), attribution: { ...record, channel: "paypal", note: 12 } }] }),
        json(members)
      ])
    );
    if (result.status !== "ready") throw new Error("not ready");
    expect(result.summary.contributions[0].attribution).toMatchObject({ channel: null, note: null, memberUserId: PAYER });
  });

  it("shows a bank-verified row's provider as its channel and never a note, whatever the server sent with it", async () => {
    const result = await loadHomeLedger(
      deps([
        json(groupBody()),
        json(balancesBody("10.00", 1)),
        json({ entries: [{ ...wire(1), provenance: proof, attribution: { ...record, channel: "cash", note: "I paid cash" } }] }),
        json(members)
      ])
    );
    if (result.status !== "ready") throw new Error("not ready");
    expect(result.summary.contributions[0].attribution).toMatchObject({ source: "bank_verification", channel: "cbe", note: null });
  });

  it("makes bank provenance win over a treasurer's record that came with it", async () => {
    const result = await loadHomeLedger(
      deps([
        json(groupBody()),
        json(balancesBody("10.00", 1)),
        json({ entries: [{ ...wire(1), provenance: proof, attribution: record }] }),
        json(members)
      ])
    );
    if (result.status !== "ready") throw new Error("not ready");
    const [row] = result.summary.contributions;
    expect(row.attribution).toMatchObject({ source: "bank_verification", memberUserId: OTHER, recordedAt: proof.verifiedAt });
    expect(result.memberLabels).toEqual({ [OTHER]: null });
  });

  it.each([
    ["an unknown source", { ...record, source: "admin" }],
    ["a missing source", { ...record, source: undefined }],
    ["a non-uuid member", { ...record, memberUserId: "someone" }],
    ["a non-uuid recorder", { ...record, recordedBy: "someone" }],
    ["an unparseable time", { ...record, recordedAt: "yesterday" }],
    ["a zero revision", { ...record, revision: 0 }],
    ["a fractional round", { ...record, round: 1.5 }],
    ["a bare string", "paid"],
    ["an array", [record]]
  ])("treats %s as no attribution, so a payer is never half-shown", async (_name, bad) => {
    const result = await loadHomeLedger(
      deps([json(groupBody()), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), attribution: bad }] })])
    );
    expect(result.status === "ready" && result.summary.contributions[0].attribution).toBeNull();
  });

  it("reads the members for an owner or treasurer so they can be offered as payers, and for nobody else", async () => {
    for (const role of ["owner", "treasurer"]) {
      const d = deps([json(groupBody(role)), json(balancesBody("10.00", 1)), json({ entries: [wire(1)] }), json(members)]);
      const result = await loadHomeLedger(d);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.groupId).toBe(GROUP);
      expect(result.role).toBe(role);
      expect(result.attributableMembers.map((member) => member.userId)).toEqual([PAYER, OTHER]);
      expect(d.fetchImpl.mock.calls[3][0]).toBe(`/api/ledger/members?groupId=${GROUP}`);
    }
    const plain = deps([json(groupBody("member")), json(balancesBody("10.00", 1)), json({ entries: [wire(1)] })]);
    const result = await loadHomeLedger(plain);
    expect(plain.fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.status === "ready" && result.attributableMembers).toEqual([]);
    expect(result.status === "ready" && result.role).toBe("member");
  });

  it("offers a plain member nothing even when a treasurer record names a payer", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody("member")), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), attribution: record }] }), json(members)])
    );
    expect(result.status === "ready" && result.attributableMembers).toEqual([]);
    expect(result.status === "ready" && result.memberLabels).toEqual({ [PAYER]: "payer@example.test" });
  });

  it("still shows the row, attributed, when the members cannot be read", async () => {
    const result = await loadHomeLedger(
      deps([json(groupBody("treasurer")), json(balancesBody("10.00", 1)), json({ entries: [{ ...wire(1), attribution: record }] }), json({}, 502)])
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.summary.contributions[0].attribution?.memberUserId).toBe(PAYER);
    expect(result.attributableMembers).toEqual([]);
    expect(result.memberLabels).toEqual({});
  });
});
