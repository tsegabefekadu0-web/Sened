import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET } from "@/app/api/draw/collateral/route";
import { POST } from "@/app/api/draw/guarantees/route";
import { RATE_LIMITED, resolveRateLimit } from "@/middleware";
import { READ_RULE, WRITE_RULE, resetRateLimits } from "@/lib/rateLimit";
import { drawCollateralQuerySchema, drawGuaranteeRequestSchema, parse } from "@/lib/validation";

const userId = "11111111-1111-4111-8111-111111111111";
const cycleId = "66666666-6666-4666-8666-666666666666";
const groupId = "22222222-2222-4222-8222-222222222222";
const winnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const guarantorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guaranteeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";

function guarantee(overrides: Record<string, unknown> = {}) {
  return {
    guaranteeId,
    cycleId,
    winnerMemberId: winnerId,
    guarantorMemberId: guarantorId,
    proposedBy: userId,
    proposedAt: T0,
    state: "proposed",
    stateAt: T0,
    stateBy: userId,
    acceptedAt: null,
    reason: null,
    successorGuaranteeId: null,
    ...overrides
  };
}

const view = {
  cycleId,
  groupId,
  totalRounds: 4,
  contributionAmount: "100.00",
  potAmount: "500.00",
  reserveRatioBps: 1000,
  startedAt: T0,
  nextRound: 2,
  eligibleCount: 4,
  reserveRetained: "50.00",
  flaggedCount: 0,
  winners: [
    {
      memberId: winnerId,
      round: 1,
      revealedAt: T0,
      owed: [{ round: 2, status: "not_due", dueAt: null, entryId: null, source: null }],
      guarantees: [guarantee()]
    }
  ]
};

function get(query: string, bearer: string | null = "token"): Request {
  return new Request(`http://localhost/api/draw/collateral${query}`, {
    method: "GET",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
  });
}

function post(payload: unknown, options: { bearer?: string | null; contentType?: string | null } = {}): Request {
  const bearer = options.bearer === undefined ? "token" : options.bearer;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  return new Request("http://localhost/api/draw/guarantees", {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  resetRateLimits();
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: userId } }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({ data: view, error: null });
});

describe("GET /api/draw/collateral", () => {
  it("returns the derived view for any member, uncached", async () => {
    const response = await GET(get(`?cycleId=${cycleId}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ collateral: view });
    expect(mocks.rpc).toHaveBeenCalledWith("get_draw_cycle_collateral_v1", { p_cycle_id: cycleId });
  });

  it("copies only the documented fields", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...view, secret: "x", winners: [{ ...view.winners[0], hidden: 1 }] }, error: null });
    const text = JSON.stringify(await (await GET(get(`?cycleId=${cycleId}`))).json());
    expect(text).not.toContain("secret");
    expect(text).not.toContain("hidden");
  });

  it("REJECTS (400) a missing or malformed cycle id and any other parameter, before the database", async () => {
    for (const query of ["", "?cycleId=nope", `?cycleId=${cycleId}&cycleId=${cycleId}`, `?cycleId=${cycleId}&groupId=${groupId}`, `?groupId=${groupId}`]) {
      expect((await GET(get(query))).status, query).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s without a token or with a rejected one", async () => {
    expect((await GET(get(`?cycleId=${cycleId}`, null))).status).toBe(401);
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    expect((await GET(get(`?cycleId=${cycleId}`))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await GET(get(`?cycleId=${cycleId}`))).status).toBe(503);
  });

  it("403s a cycle the caller cannot see, the same for an unknown cycle", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "collateral_forbidden" } });
    const response = await GET(get(`?cycleId=${cycleId}`));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("502s on a storage failure and on a view that is not one", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await GET(get(`?cycleId=${cycleId}`))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { cycleId }, error: null });
    expect((await GET(get(`?cycleId=${cycleId}`))).status).toBe(502);
  });
});

describe("POST /api/draw/guarantees", () => {
  beforeEach(() => {
    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee(), replayed: false }, error: null });
  });

  it("propose: calls the proposer-only function with the winner and guarantor and no acting user", async () => {
    const response = await POST(post({ action: "propose", cycleId, winnerMemberId: winnerId, guarantorMemberId: guarantorId }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ guarantee: guarantee(), superseded: null, replayed: false });
    expect(mocks.rpc).toHaveBeenCalledWith("propose_collateral_guarantee_v1", {
      p_cycle_id: cycleId,
      p_winner_member_id: winnerId,
      p_guarantor_member_id: guarantorId
    });
  });

  it("propose: a repeat is a 200 replay", async () => {
    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee(), replayed: true }, error: null });
    const response = await POST(post({ action: "propose", cycleId, winnerMemberId: winnerId, guarantorMemberId: guarantorId }));
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
  });

  it("accept and decline carry ONLY the guarantee id: nobody can answer 'as' someone else", async () => {
    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee({ state: "accepted", stateBy: guarantorId, acceptedAt: T0 }), replayed: false }, error: null });
    expect((await POST(post({ action: "accept", guaranteeId }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("respond_collateral_guarantee_v1", { p_guarantee_id: guaranteeId, p_accept: true, p_reason: null });

    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee({ state: "declined", reason: "not able" }), replayed: false }, error: null });
    expect((await POST(post({ action: "decline", guaranteeId, reason: "not able" }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("respond_collateral_guarantee_v1", { p_guarantee_id: guaranteeId, p_accept: false, p_reason: "not able" });

    await POST(post({ action: "decline", guaranteeId }));
    expect(mocks.rpc).toHaveBeenLastCalledWith("respond_collateral_guarantee_v1", { p_guarantee_id: guaranteeId, p_accept: false, p_reason: null });
  });

  it("REJECTS (400) a member id, the guarantor or any acting user on accept and decline, before the database", async () => {
    mocks.rpc.mockClear();
    for (const bad of [
      { action: "accept", guaranteeId, guarantorMemberId: guarantorId },
      { action: "accept", guaranteeId, memberId: guarantorId },
      { action: "accept", guaranteeId, userId },
      { action: "accept", guaranteeId, actorId: userId },
      { action: "accept", guaranteeId, accept: true },
      { action: "accept", guaranteeId, reason: "x" },
      { action: "decline", guaranteeId, userId },
      { action: "decline", guaranteeId, reason: "" },
      { action: "decline", guaranteeId, reason: "x".repeat(1001) },
      { action: "accept" },
      { action: "accept", guaranteeId: "nope" }
    ]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("release and supersede require a reason of 10..1000 characters", async () => {
    mocks.rpc.mockClear();
    for (const bad of [
      { action: "release", guaranteeId },
      { action: "release", guaranteeId, reason: "short" },
      { action: "release", guaranteeId, reason: "x".repeat(1001) },
      { action: "supersede", guaranteeId, newGuarantorMemberId: guarantorId },
      { action: "supersede", guaranteeId, newGuarantorMemberId: guarantorId, reason: "short" },
      { action: "supersede", guaranteeId, reason: "a perfectly good reason" }
    ]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee({ state: "released", reason: "No longer able to vouch" }), replayed: false }, error: null });
    expect((await POST(post({ action: "release", guaranteeId, reason: "No longer able to vouch" }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_collateral_guarantee_v1", { p_guarantee_id: guaranteeId, p_reason: "No longer able to vouch" });
  });

  it("supersede returns the new guarantee and the one it replaced", async () => {
    const successor = guarantee({ guaranteeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", guarantorMemberId: userId });
    mocks.rpc.mockResolvedValue({
      data: { guarantee: successor, superseded: guarantee({ state: "superseded", successorGuaranteeId: successor.guaranteeId, reason: "Moved away" + "!!!" }), replayed: false },
      error: null
    });
    const response = await POST(post({ action: "supersede", guaranteeId, newGuarantorMemberId: userId, reason: "Moved away from the area" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.guarantee.guaranteeId).toBe(successor.guaranteeId);
    expect(body.superseded.state).toBe("superseded");
    expect(mocks.rpc).toHaveBeenLastCalledWith("supersede_collateral_guarantee_v1", {
      p_guarantee_id: guaranteeId,
      p_new_guarantor_member_id: userId,
      p_reason: "Moved away from the area"
    });
  });

  it("REJECTS (400) an unknown action, an extra field, a non-JSON body and an oversized one", async () => {
    mocks.rpc.mockClear();
    for (const bad of [
      { action: "approve", guaranteeId },
      { guaranteeId },
      { action: "propose", cycleId, winnerMemberId: winnerId, guarantorMemberId: guarantorId, proposedBy: userId },
      { action: "propose", cycleId, winnerMemberId: winnerId },
      { action: "propose", cycleId: "nope", winnerMemberId: winnerId, guarantorMemberId: guarantorId },
      [],
      null
    ]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await POST(post({ action: "accept", guaranteeId }, { contentType: "text/plain" }))).status).toBe(400);
    expect((await POST(post("{not json"))).status).toBe(400);
    expect((await POST(post({ action: "release", guaranteeId, reason: "x".repeat(1100), padding: "y".repeat(2000) }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts a full 1000-character Amharic reason (3 bytes a character) and still refuses a body over the 4096-byte cap", async () => {
    // 1000 Ethiopic characters are 3000 bytes of UTF-8: the old 2048-byte cap refused an honest reason.
    const amharic = "አ".repeat(1000);
    expect(new TextEncoder().encode(amharic).byteLength).toBe(3000);
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee({ state: "released", reason: amharic }), replayed: false }, error: null });
    const accepted = await POST(post({ action: "release", guaranteeId, reason: amharic }));
    expect(accepted.status).not.toBe(400);
    expect(mocks.rpc).toHaveBeenCalledWith("release_collateral_guarantee_v1", expect.objectContaining({ p_reason: amharic }));

    mocks.rpc.mockClear();
    const body = JSON.stringify({ action: "release", guaranteeId, reason: amharic, padding: "y".repeat(1200) });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4096);
    expect((await POST(post(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s without a token, 503s without configuration", async () => {
    expect((await POST(post({ action: "accept", guaranteeId }, { bearer: null }))).status).toBe(401);
    mocks.getUser.mockRejectedValue(new Error("network"));
    expect((await POST(post({ action: "accept", guaranteeId }))).status).toBe(503);
  });

  it("maps each database refusal to its status and its own code", async () => {
    const cases: Array<[string, string, number, string]> = [
      ["42501", "collateral_forbidden", 403, "forbidden"],
      ["P0002", "collateral_member_not_found", 404, "collateral_member_not_found"],
      ["22023", "collateral_invalid_request", 422, "collateral_invalid_request"],
      ["P0001", "collateral_winner_not_found", 409, "collateral_winner_not_found"],
      ["P0001", "collateral_no_remaining_rounds", 409, "collateral_no_remaining_rounds"],
      ["P0001", "collateral_cycle_closed", 409, "collateral_cycle_closed"],
      ["P0001", "collateral_exists", 409, "collateral_exists"],
      ["P0001", "collateral_limit", 409, "collateral_limit"],
      ["P0001", "collateral_state_conflict", 409, "collateral_state_conflict"]
    ];
    for (const [code, message, status, error] of cases) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message } });
      const response = await POST(post({ action: "accept", guaranteeId }));
      expect(response.status, message).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("502s on a storage failure and on a response that is not a guarantee", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await POST(post({ action: "accept", guaranteeId }))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { guarantee: { guaranteeId }, replayed: false }, error: null });
    expect((await POST(post({ action: "accept", guaranteeId }))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { guarantee: guarantee({ state: "approved" }), replayed: false }, error: null });
    expect((await POST(post({ action: "accept", guaranteeId }))).status).toBe(502);
  });
});

describe("schemas and registration", () => {
  it("are strict and registered with the right rule for each method", () => {
    expect(parse(drawCollateralQuerySchema, { cycleId }).ok).toBe(true);
    expect(parse(drawCollateralQuerySchema, { cycleId, extra: "x" }).ok).toBe(false);
    expect(parse(drawGuaranteeRequestSchema, { action: "accept", guaranteeId }).ok).toBe(true);
    expect(parse(drawGuaranteeRequestSchema, { action: "accept", guaranteeId, userId }).ok).toBe(false);
    expect(RATE_LIMITED.has("/api/draw/collateral")).toBe(true);
    expect(RATE_LIMITED.has("/api/draw/guarantees")).toBe(true);
    expect(resolveRateLimit("/api/draw/collateral", "GET")).toEqual(READ_RULE);
    expect(resolveRateLimit("/api/draw/guarantees", "POST")).toEqual(WRITE_RULE);
  });
});
