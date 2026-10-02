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

import { GET as listInvites, POST as createInvite } from "@/app/api/ledger/invites/route";
import { POST as redeem } from "@/app/api/ledger/invites/redeem/route";
import { POST as revoke } from "@/app/api/ledger/invites/revoke/route";
import { GET as listMembers } from "@/app/api/ledger/members/route";
import { RATE_LIMITED, isRateLimitedPath, resolveRateLimit } from "@/middleware";
import { READ_RULE, WRITE_RULE } from "@/lib/rateLimit";

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const inviteId = "33333333-3333-4333-8333-333333333333";
const TOKEN = "a".repeat(64);

function post(url: string, payload: unknown, options: { bearer?: string | null; contentType?: string | null } = {}): Request {
  const bearer = options.bearer === undefined ? "jwt" : options.bearer;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

function get(url: string, bearer: string | null = "jwt"): Request {
  return new Request(`http://localhost${url}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
  });
}

const sqlError = (message: string, code = "P0001") => ({ data: null, error: { message, code } });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: userId } }, error: null });
  mocks.rpc.mockReset();
});

describe("POST /api/ledger/invites (create)", () => {
  const created = {
    inviteId,
    groupId,
    token: TOKEN,
    expiresAt: "2026-10-08T00:00:00Z",
    maxUses: 1
  };

  it("creates through the SQL function with defaults and returns the token with no-store", async () => {
    mocks.rpc.mockResolvedValue({ data: created, error: null });

    const response = await createInvite(post("/api/ledger/invites", { groupId }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(created);
    expect(mocks.rpc).toHaveBeenCalledWith("create_group_invite_v1", {
      requested_group_id: groupId,
      expires_in_hours: 168,
      requested_max_uses: 1
    });
  });

  it("passes explicit expiry and uses through", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...created, maxUses: 5 }, error: null });

    await createInvite(post("/api/ledger/invites", { groupId, expiresInHours: 24, maxUses: 5 }));

    expect(mocks.rpc).toHaveBeenCalledWith("create_group_invite_v1", {
      requested_group_id: groupId,
      expires_in_hours: 24,
      requested_max_uses: 5
    });
  });

  it("REJECTS (400) out-of-range, fractional, unknown and malformed input without calling the database", async () => {
    for (const payload of [
      { groupId, expiresInHours: 721 },
      { groupId, expiresInHours: 0 },
      { groupId, maxUses: 51 },
      { groupId, maxUses: 1.5 },
      { groupId, tenantId: userId },
      { groupId: "nope" },
      "{not json"
    ]) {
      expect((await createInvite(post("/api/ledger/invites", payload))).status).toBe(400);
    }
    expect((await createInvite(post("/api/ledger/invites", { groupId }, { contentType: "text/plain" }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s without a Bearer token, 503s when unconfigured", async () => {
    expect((await createInvite(post("/api/ledger/invites", { groupId }, { bearer: null }))).status).toBe(401);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await createInvite(post("/api/ledger/invites", { groupId }))).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps SQL errors: 403 non-owner, 404 no group, 502 unknown", async () => {
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_forbidden", "42501"));
    expect((await createInvite(post("/api/ledger/invites", { groupId }))).status).toBe(403);
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_group_not_found", "P0002"));
    expect((await createInvite(post("/api/ledger/invites", { groupId }))).status).toBe(404);
    mocks.rpc.mockResolvedValueOnce(sqlError("boom", "XX000"));
    const failed = await createInvite(post("/api/ledger/invites", { groupId }));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("boom");
  });
});

describe("POST /api/ledger/invites/redeem", () => {
  it("joins and returns the outcome, never the token", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "joined", groupId, role: "member" }, error: null });

    const response = await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(JSON.parse(text)).toEqual({ outcome: "joined", groupId, role: "member" });
    expect(text).not.toContain(TOKEN);
    expect(mocks.rpc).toHaveBeenCalledWith("redeem_group_invite_v1", { requested_token: TOKEN });
  });

  it("reports already_member", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "already_member", groupId, role: "treasurer" }, error: null });

    const response = await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }));

    expect(await response.json()).toEqual({ outcome: "already_member", groupId, role: "treasurer" });
  });

  it("maps dead invites: 404 invalid, 410 expired / revoked / exhausted", async () => {
    const cases: Array<[string, string, number, string]> = [
      ["ledger_invite_invalid", "P0002", 404, "not_found"],
      ["ledger_invite_expired", "P0001", 410, "invite_expired"],
      ["ledger_invite_revoked", "P0001", 410, "invite_revoked"],
      ["ledger_invite_exhausted", "P0001", 410, "invite_exhausted"]
    ];
    for (const [message, code, status, error] of cases) {
      mocks.rpc.mockResolvedValueOnce(sqlError(message, code));
      const response = await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("never echoes or logs the token, even when the database fails", async () => {
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    mocks.rpc.mockResolvedValue(sqlError(`failure involving ${TOKEN}`, "XX000"));

    const response = await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }));

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      spy.mockRestore();
    }
  });

  it("REJECTS (400) a malformed token and does not echo it", async () => {
    for (const token of ["short", "has spaces in it ok 1234567890", "x".repeat(300), 12345]) {
      const response = await redeem(post("/api/ledger/invites/redeem", { token }));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(String(token));
    }
    expect((await redeem(post("/api/ledger/invites/redeem", { token: TOKEN, extra: 1 }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s with no Bearer token (anon) and never reaches the database", async () => {
    const response = await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }, { bearer: null }));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("403s a token with no subject (the SQL function refuses)", async () => {
    mocks.rpc.mockResolvedValue(sqlError("ledger_forbidden", "42501"));

    expect((await redeem(post("/api/ledger/invites/redeem", { token: TOKEN }))).status).toBe(403);
  });
});

describe("POST /api/ledger/invites/revoke", () => {
  it("revokes through SQL and is idempotent", async () => {
    mocks.rpc.mockResolvedValue({ data: { inviteId, revoked: true, changed: false }, error: null });

    const response = await revoke(post("/api/ledger/invites/revoke", { inviteId }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inviteId, revoked: true, changed: false });
    expect(mocks.rpc).toHaveBeenCalledWith("revoke_group_invite_v1", { requested_invite_id: inviteId });
  });

  it("403 non-owner, 404 unknown, 400 bad id", async () => {
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_forbidden", "42501"));
    expect((await revoke(post("/api/ledger/invites/revoke", { inviteId }))).status).toBe(403);
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_invite_invalid", "P0002"));
    expect((await revoke(post("/api/ledger/invites/revoke", { inviteId }))).status).toBe(404);
    expect((await revoke(post("/api/ledger/invites/revoke", { inviteId: "x" }))).status).toBe(400);
    expect((await revoke(post("/api/ledger/invites/revoke", { inviteId }, { bearer: null }))).status).toBe(401);
  });
});

describe("GET /api/ledger/invites", () => {
  it("lists invites without a token or hash", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          inviteId,
          createdAt: "2026-10-01T00:00:00Z",
          expiresAt: "2026-10-08T00:00:00Z",
          maxUses: 3,
          useCount: 1,
          revokedAt: null,
          status: "active",
          token_hash: "should-not-pass-through",
          token: "should-not-pass-through"
        }
      ],
      error: null
    });

    const response = await listInvites(get(`/api/ledger/invites?groupId=${groupId}`));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).toContain(inviteId);
    expect(text).not.toContain("should-not-pass-through");
    expect(mocks.rpc).toHaveBeenCalledWith("list_group_invites_v1", { requested_group_id: groupId });
  });

  it("403s a non-owner, 400s bad queries, 401s without a token", async () => {
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_forbidden", "42501"));
    expect((await listInvites(get(`/api/ledger/invites?groupId=${groupId}`))).status).toBe(403);
    expect((await listInvites(get("/api/ledger/invites"))).status).toBe(400);
    expect((await listInvites(get(`/api/ledger/invites?groupId=${groupId}&x=1`))).status).toBe(400);
    expect((await listInvites(get(`/api/ledger/invites?groupId=${groupId}`, null))).status).toBe(401);
  });
});

describe("GET /api/ledger/members", () => {
  it("returns the members, with email only as the database supplied it", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { userId, role: "owner", joinedAt: "2026-10-01T00:00:00Z", email: "o@example.test" },
        { userId: inviteId, role: "member", joinedAt: "2026-10-02T00:00:00Z", email: null }
      ],
      error: null
    });

    const response = await listMembers(get(`/api/ledger/members?groupId=${groupId}`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { members: Array<{ email: string | null }> };
    expect(body.members.map((member) => member.email)).toEqual(["o@example.test", null]);
    expect(mocks.rpc).toHaveBeenCalledWith("list_group_members_v1", { requested_group_id: groupId });
  });

  it("403s an outsider and 502s a malformed response", async () => {
    mocks.rpc.mockResolvedValueOnce(sqlError("ledger_forbidden", "42501"));
    expect((await listMembers(get(`/api/ledger/members?groupId=${groupId}`))).status).toBe(403);
    mocks.rpc.mockResolvedValueOnce({ data: [{ userId: 1 }], error: null });
    expect((await listMembers(get(`/api/ledger/members?groupId=${groupId}`))).status).toBe(502);
  });
});

describe("rate limits", () => {
  it("meters every invite route: writes on WRITE_RULE, reads on READ_RULE", () => {
    for (const path of ["/api/ledger/invites", "/api/ledger/invites/redeem", "/api/ledger/invites/revoke", "/api/ledger/members"]) {
      expect(RATE_LIMITED.has(path)).toBe(true);
      expect(isRateLimitedPath(path)).toBe(true);
    }
    expect(resolveRateLimit("/api/ledger/invites", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/ledger/invites", "GET")).toEqual(READ_RULE);
    expect(resolveRateLimit("/api/ledger/invites/redeem", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/ledger/invites/revoke", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/ledger/members", "GET")).toEqual(READ_RULE);
  });
});
