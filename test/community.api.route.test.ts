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

import { POST } from "@/app/api/community/route";

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";

function req(body: unknown, bearer: string | null = "token"): Request {
  return new Request("http://localhost:3000/api/community", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: userId, email: "owner@example.com" } },
    error: null
  });
  mocks.rpc.mockReset();
});

describe("POST /api/community", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("invalid") });
    const res = await POST(req({ name: "Bole Equb" }, null));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is empty", async () => {
    const res = await POST(req({ name: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when amount is negative", async () => {
    const res = await POST(req({ name: "Bole Equb", amount: -500 }));
    expect(res.status).toBe(400);
  });

  it("creates community and returns formatted invite link", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        groupId,
        tenantId: userId,
        name: "Bole Equb",
        kind: "equb",
        amount: 5000,
        frequency: "monthly",
        members: 10,
        role: "owner",
        invite: {
          inviteId: "invite-1",
          token: "abcdef1234567890abcdef1234567890",
          expiresAt: "2026-10-16T00:00:00Z",
          maxUses: 10
        }
      },
      error: null
    });

    const res = await POST(
      req({
        name: "Bole Equb",
        kind: "equb",
        amount: 5000,
        frequency: "monthly",
        members: 10
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.community.groupId).toBe(groupId);
    expect(body.community.name).toBe("Bole Equb");
    expect(body.community.role).toBe("owner");
    expect(body.community.invite.joinUrl).toBe(
      "http://localhost:3000/join#token=abcdef1234567890abcdef1234567890"
    );
    expect(mocks.rpc).toHaveBeenCalledWith("sened_community_create_v1", {
      requested_name: "Bole Equb",
      requested_kind: "equb",
      requested_amount: 5000,
      requested_frequency: "monthly",
      requested_target_members: 10
    });
  });
});
