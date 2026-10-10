import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc
  }))
}));

import { GET, PUT } from "@/app/api/profile/route";

const userId = "11111111-1111-4111-8111-111111111111";

function req(method: "GET" | "PUT", body?: unknown, bearer: string | null = "token"): Request {
  return new Request("http://localhost/api/profile", {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: userId, email: "user@example.com" } },
    error: null
  });
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe("GET /api/profile", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("invalid") });
    const res = await GET(req("GET", undefined, null));
    expect(res.status).toBe(401);
  });

  it("returns profile for authenticated user", async () => {
    mocks.from.mockReturnValueOnce({
      select: vi.fn().mockReturnValueOnce({
        eq: vi.fn().mockReturnValueOnce({
          maybeSingle: vi.fn().mockResolvedValueOnce({
            data: {
              id: userId,
              name: "Abebe Bikila",
              phone: "0911223344",
              photo: "https://example.com/avatar.jpg",
              preferred_locale: "am",
              preferred_theme: "dark",
              created_at: "2026-10-09T00:00:00Z",
              updated_at: "2026-10-09T00:00:00Z"
            },
            error: null
          })
        })
      })
    });

    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toEqual({
      id: userId,
      name: "Abebe Bikila",
      phone: "0911223344",
      photo: "https://example.com/avatar.jpg",
      preferredLocale: "am",
      preferredTheme: "dark",
      createdAt: "2026-10-09T00:00:00Z",
      updatedAt: "2026-10-09T00:00:00Z"
    });
  });
});

describe("PUT /api/profile", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("invalid") });
    const res = await PUT(req("PUT", { name: "Test" }, null));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is too long (> 120 chars)", async () => {
    const res = await PUT(req("PUT", { name: "a".repeat(125) }));
    expect(res.status).toBe(400);
  });

  it("successfully upserts profile and returns updated data", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        id: userId,
        name: "Almaz Ayana",
        phone: "0922334455",
        photo: null,
        preferredLocale: "en",
        preferredTheme: "light",
        createdAt: "2026-10-09T00:00:00Z",
        updatedAt: "2026-10-09T00:00:00Z"
      },
      error: null
    });

    const res = await PUT(
      req("PUT", {
        name: "Almaz Ayana",
        phone: "0922334455",
        preferredLocale: "en",
        preferredTheme: "light"
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.name).toBe("Almaz Ayana");
    expect(body.profile.preferredLocale).toBe("en");
    expect(mocks.rpc).toHaveBeenCalledWith("sened_profile_upsert_v1", {
      requested_name: "Almaz Ayana",
      requested_phone: "0922334455",
      requested_photo: null,
      requested_locale: "en",
      requested_theme: "light"
    });
  });
});
