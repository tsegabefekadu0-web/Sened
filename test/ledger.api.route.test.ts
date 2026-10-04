import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc
  }))
}));

import { POST } from "@/app/api/ledger/entries/route";
import { buildLedgerEntry, type LedgerEntryRequest } from "@/lib/ledger";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";

const requestBody: LedgerEntryRequest = {
  groupId,
  idempotencyKey: "contribution-001",
  occurredAt: "2026-09-25T10:30:00.000Z",
  entryType: "contribution",
  postings: [
    { accountId: cashAccount, direction: "debit", amount: "25.00" },
    { accountId: incomeAccount, direction: "credit", amount: "25.00" }
  ]
};

const persistedEntry = buildLedgerEntry({
  request: requestBody,
  actorId,
  tenantId,
  entryId: "55555555-5555-4555-8555-555555555555",
  nonce: "66666666-6666-4666-8666-666666666666",
  sequence: "1",
  previousHash: "0".repeat(64),
  recordedAt: "2026-09-25T10:30:01.000Z",
  postingIds: [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  ]
});

function post(body: unknown, bearer = "token"): Request {
  return new Request("http://localhost/api/ledger/entries", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: actorId } },
    error: null
  });
  mocks.rpc.mockReset().mockResolvedValue({
    data: { entry: persistedEntry, replayed: false },
    error: null
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ledger/entries", () => {
  it("401s without a Bearer token", async () => {
    const response = await POST(post(requestBody, ""));

    expect(response.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const response = await POST(post(requestBody));

    expect(response.status).toBe(503);
  });

  it("503s when Supabase authentication is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network unavailable"));

    const response = await POST(post(requestBody));

    expect(response.status).toBe(503);
  });

  it("REJECTS (400) spoofed actor and user fields before the RPC", async () => {
    const response = await POST(post({ ...requestBody, actorId, user_id: actorId }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: expect.stringContaining("actorId")
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS (400) numeric money instead of coercing it", async () => {
    const numericAmountBody = {
      ...requestBody,
      postings: [
        { ...requestBody.postings[0], amount: 25 },
        requestBody.postings[1]
      ]
    };

    const response = await POST(post(numericAmountBody));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("403s when the database refuses the caller's role in the group", async () => {
    // The JWT carries no role. post_ledger_entry_v1 reads the caller's role in
    // the group from ledger_group_memberships and refuses a plain member.
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "ledger_forbidden" }
    });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(403);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not consult the JWT's app_metadata: a claimed role neither grants nor blocks", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: actorId, app_metadata: { role: "member" } } },
      error: null
    });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("creates an entry without accepting identity, hash, sequence, or tenant fields", async () => {
    const response = await POST(post(requestBody));

    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.replayed).toBe(false);
    expect(payload.entry).not.toHaveProperty("tenantId");
    expect(payload.entry).not.toHaveProperty("requestFingerprint");
    expect(payload.entry).not.toHaveProperty("idempotencyKey");
    const rpcArguments = mocks.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcArguments).toEqual({
      requested_group_id: groupId,
      requested_idempotency_key: "contribution-001",
      requested_occurred_at: "2026-09-25T10:30:00.000Z",
      requested_entry_type: "contribution",
      requested_corrects_entry_id: null,
      requested_rationale: null,
      requested_postings: requestBody.postings
    });
  });

  it("returns 200 and the original entry for an RPC replay", async () => {
    mocks.rpc.mockResolvedValue({ data: { entry: persistedEntry, replayed: true }, error: null });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: true,
      entry: { id: persistedEntry.id, sequence: "1" }
    });
  });

  it.each([
    ["ledger_group_not_found", 404],
    ["ledger_idempotency_conflict", 409],
    ["ledger_invalid_correction_amounts", 422],
    ["ledger_history_immutable", 502]
  ])("maps %s to %i", async (message, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(status);
  });

  it("503s when the production RPC is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(503);
  });
});

describe("POST /api/ledger/entries with an attribution (who paid a cash contribution)", () => {
  const memberId = "77777777-7777-4777-8777-777777777777";
  const cycleId = "88888888-8888-4888-8888-888888888888";
  const attributionRow = {
    entryId: persistedEntry.id,
    memberUserId: memberId,
    source: "treasurer",
    recordedBy: actorId,
    recordedAt: "2026-09-25T10:30:02.000Z",
    cycleId: null,
    round: null,
    revision: 1,
    reason: null
  };

  /** post_ledger_entry_v1 answers the entry; record_ledger_entry_attribution_v1 answers `attribution`. */
  function answer(attribution: { data: unknown; error: unknown }) {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "record_ledger_entry_attribution_v1"
        ? attribution
        : { data: { entry: persistedEntry, replayed: false }, error: null }
    );
  }

  it("posts the entry first, with the attribution split off, then records the payer for the new entry", async () => {
    answer({ data: { attribution: attributionRow, replayed: false }, error: null });

    const response = await POST(post({ ...requestBody, attribution: { memberUserId: memberId } }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.attribution).toEqual({ status: "recorded", replayed: false });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["post_ledger_entry_v1", "record_ledger_entry_attribution_v1"]);
    // The entry RPC never sees the attribution: it cannot reach the hash or the fingerprint.
    const [, entryArgs] = mocks.rpc.mock.calls[0]!;
    expect(JSON.stringify(entryArgs)).not.toContain(memberId);
    expect(Object.keys(entryArgs)).not.toContain("attribution");
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_ledger_entry_attribution_v1", {
      p_group_id: groupId,
      p_entry_id: persistedEntry.id,
      p_member_user_id: memberId,
      p_cycle_id: null,
      p_round: null
    });
    // The public entry is unchanged by it.
    expect(body.entry.entryHash).toBe(persistedEntry.entryHash);
  });

  it("passes the cycle and round, and reports a replayed entry's attribution as a replay", async () => {
    answer({ data: { attribution: { ...attributionRow, cycleId, round: 2 }, replayed: true }, error: null });
    const response = await POST(post({ ...requestBody, attribution: { memberUserId: memberId, cycleId, round: 2 } }));
    expect((await response.json()).attribution).toEqual({ status: "recorded", replayed: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_ledger_entry_attribution_v1",
      expect.objectContaining({ p_cycle_id: cycleId, p_round: 2 })
    );
  });

  it("REPORTS a refused attribution but keeps the posted entry: the ledger is never held back by it", async () => {
    for (const [code, message, reported] of [
      ["42501", "ledger_forbidden", "forbidden"],
      ["P0002", "ledger_member_not_found", "ledger_member_not_found"],
      ["P0001", "attribution_bank_verified", "attribution_bank_verified"]
    ] as const) {
      answer({ data: null, error: { code, message } });
      const response = await POST(post({ ...requestBody, attribution: { memberUserId: memberId } }));
      expect(response.status, message).toBe(201);
      const body = await response.json();
      expect(body.entry.id).toBe(persistedEntry.id);
      expect(body.attribution).toEqual({ status: "refused", error: reported });
    }
    answer({ data: null, error: { code: "XX000", message: "boom" } });
    const failed = await POST(post({ ...requestBody, attribution: { memberUserId: memberId } }));
    expect(failed.status).toBe(201);
    expect((await failed.json()).attribution).toEqual({ status: "failed" });
  });

  it("does not record anything when the entry itself is refused", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });
    const response = await POST(post({ ...requestBody, attribution: { memberUserId: memberId } }));
    expect(response.status).toBe(403);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["post_ledger_entry_v1"]);
  });

  it("REJECTS (400) an attribution on anything but a contribution, and a malformed one, before any write", async () => {
    const disbursement = { ...requestBody, entryType: "disbursement" };
    for (const bad of [
      { ...disbursement, attribution: { memberUserId: memberId } },
      { ...requestBody, attribution: null },
      { ...requestBody, attribution: {} },
      { ...requestBody, attribution: { memberUserId: "nope" } },
      { ...requestBody, attribution: { memberUserId: memberId, round: 2 } },
      { ...requestBody, attribution: { memberUserId: memberId, recordedBy: actorId } },
      { ...requestBody, attribution: { memberUserId: memberId, source: "bank_verification" } },
      { ...requestBody, attribution: [memberId] }
    ]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad.attribution)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is unchanged for a post with no attribution: one RPC and no attribution field", async () => {
    const response = await POST(post(requestBody));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(Object.keys(await response.json()).sort()).toEqual(["entry", "replayed"]);
  });
});
