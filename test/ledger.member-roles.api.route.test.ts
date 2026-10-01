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

import { POST } from "@/app/api/ledger/member-roles/route";
import { ledgerMemberRoleRequestSchema, parse } from "@/lib/validation";

const ownerId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";

const body = { groupId, userId: memberId, role: "treasurer" };

function post(payload: unknown, options: { bearer?: string | null; contentType?: string | null } = {}): Request {
  const bearer = options.bearer === undefined ? "token" : options.bearer;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  return new Request("http://localhost/api/ledger/member-roles", {
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
  // No app_metadata at all: the route must not depend on a JWT role.
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: ownerId } }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({
    data: { groupId, userId: memberId, role: "treasurer", changed: true },
    error: null
  });
});

describe("POST /api/ledger/member-roles", () => {
  it("grants the role through the SQL function under the caller's token", async () => {
    const response = await POST(post(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groupId, userId: memberId, role: "treasurer", changed: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).toHaveBeenCalledWith("sened_ledger_set_member_role_v1", {
      requested_group_id: groupId,
      requested_user_id: memberId,
      requested_role: "treasurer"
    });
  });

  it("is idempotent: an unchanged role is still a 200 with changed false", async () => {
    mocks.rpc.mockResolvedValue({
      data: { groupId, userId: memberId, role: "member", changed: false },
      error: null
    });

    const response = await POST(post({ ...body, role: "member" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: "member", changed: false });
  });

  it("401s without a Bearer token and never calls the database", async () => {
    const response = await POST(post(body, { bearer: null }));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s a rejected token", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });

    const response = await POST(post(body));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const response = await POST(post(body));

    expect(response.status).toBe(503);
  });

  it("503s when authentication is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network unavailable"));

    const response = await POST(post(body));

    expect(response.status).toBe(503);
  });

  it("REJECTS (400) a non-JSON content type or malformed JSON", async () => {
    expect((await POST(post(body, { contentType: "text/plain" }))).status).toBe(400);
    expect((await POST(post(body, { contentType: null }))).status).toBe(400);
    expect((await POST(post("{not json"))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS (400) an oversized body", async () => {
    const response = await POST(post({ ...body, padding: "x".repeat(2_000) }));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS (400) the owner role, unknown roles, bad ids and smuggled fields", async () => {
    for (const bad of [
      { ...body, role: "owner" },
      { ...body, role: "admin" },
      { ...body, role: undefined },
      { ...body, groupId: "not-a-uuid" },
      { ...body, userId: "not-a-uuid" },
      { ...body, tenantId: ownerId },
      { groupId, role: "treasurer" }
    ]) {
      const response = await POST(post(bad));
      expect(response.status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("403s when the caller is not the group's owner", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });

    const response = await POST(post(body));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("404s an unknown group and a target who is not a member", async () => {
    for (const message of ["ledger_group_not_found", "ledger_member_not_found"]) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message } });

      const response = await POST(post(body));

      expect(response.status).toBe(404);
    }
  });

  it("422s a change to an owner's role", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "ledger_invalid_request" } });

    const response = await POST(post(body));

    expect(response.status).toBe(422);
  });

  it("502s an unexpected database error without reflecting it", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret internal detail" } });

    const response = await POST(post(body));

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("502s a malformed success payload", async () => {
    mocks.rpc.mockResolvedValue({ data: { groupId }, error: null });

    const response = await POST(post(body));

    expect(response.status).toBe(502);
  });
});

describe("ledgerMemberRoleRequestSchema", () => {
  it("lower-cases ids and accepts only treasurer or member", () => {
    const parsed = parse(ledgerMemberRoleRequestSchema, {
      groupId: groupId.toUpperCase(),
      userId: memberId,
      role: "member"
    });
    expect(parsed).toMatchObject({ ok: true, data: { groupId, userId: memberId, role: "member" } });
    expect(parse(ledgerMemberRoleRequestSchema, { ...body, role: "owner" }).ok).toBe(false);
  });
});
