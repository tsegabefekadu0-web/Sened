import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

import { GET as GET_BINDINGS } from "@/app/api/bank-account-bindings/route";
import { GET as GET_GROUPS } from "@/app/api/my-groups/route";
import { isRateLimitedPath, middleware, resolveRateLimit } from "@/middleware";
import { READ_RULE, resetRateLimits } from "@/lib/rateLimit";

/**
 * The two reads the voice → bank hand-off was missing.
 *
 * `get_bank_account_binding_v1` takes a binding id and a client cannot know its
 * own, so a treasurer could hold a valid binding and be unable to name it —
 * and `bankAccountBindingId` is the field the whole verification is driven by.
 * The SQL behind these is verified against a real Postgres by
 * `scripts/verify-migrations.ps1`; these cover the HTTP contract around it, and
 * the two ways it must refuse.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api", { headers });
}

function signedIn(): Request {
  return request({ authorization: "Bearer user-token" });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resetRateLimits();
  mocks.getUser.mockReset();
  mocks.rpc.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
});

describe("GET /api/bank-account-bindings", () => {
  it("returns the caller's own bindings", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          id: bindingId,
          groupId,
          provider: "telebirr",
          currency: "ETB",
          accountLabel: "Treasury mobile money",
          active: true
        }
      ],
      error: null
    });

    const response = await GET_BINDINGS(signedIn());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]).toMatchObject({ id: bindingId, provider: "telebirr" });
    expect(mocks.rpc).toHaveBeenCalledWith("list_bank_account_bindings_v1");
  });

  it("never returns account fingerprints or a sealed reference", async () => {
    // Even if the RPC ever grew a field, the browser must not see it: the
    // fingerprints are HMACs over masked account numbers and exist to be
    // compared server-side.
    mocks.rpc.mockResolvedValue({
      data: [
        {
          id: bindingId,
          groupId,
          provider: "telebirr",
          currency: "ETB",
          accountLabel: "Treasury mobile money",
          active: true,
          accountFingerprintHmac: "a".repeat(64),
          senderFingerprintHmac: "b".repeat(64),
          sealedProviderReference: { ciphertext: "sealed" }
        }
      ],
      error: null
    });

    const response = await GET_BINDINGS(signedIn());
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("FingerprintHmac");
    expect(text).not.toContain("sealedProviderReference");
    expect(text).not.toContain("a".repeat(64));
  });

  it("drops a malformed row rather than surfacing a half-built account", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { id: bindingId, groupId, provider: "telebirr", currency: "ETB", accountLabel: "ok", active: true },
        { id: "not-a-uuid", groupId, provider: "telebirr", currency: "ETB", accountLabel: "bad", active: true },
        { id: bindingId, groupId, provider: "western-union", currency: "ETB", accountLabel: "bad", active: true }
      ],
      error: null
    });

    const response = await GET_BINDINGS(signedIn());
    const body = await response.json();

    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0].accountLabel).toBe("ok");
  });

  it("401s a request with no bearer token", async () => {
    const response = await GET_BINDINGS(request());

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s a rejected token", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });

    const response = await GET_BINDINGS(signedIn());

    expect(response.status).toBe(401);
  });

  it("503s when Supabase is not configured, rather than claiming no accounts", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");

    const response = await GET_BINDINGS(signedIn());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("502s a storage failure rather than answering with an empty list", async () => {
    // The distinction a treasurer needs: "you have no accounts" is a fixable
    // setup problem, "we could not read them" is not. They must not look alike.
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const response = await GET_BINDINGS(signedIn());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "storage_failure" });
  });

  it("returns an empty list, not an error, for a treasurer with no bindings", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await GET_BINDINGS(signedIn());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bindings: [] });
  });
});

describe("GET /api/my-groups", () => {
  it("returns the caller's groups with the chart of accounts", async () => {
    // The accounts are the point: the resolver looks an account up by code, so
    // without them a group looks unprovisioned and every write is refused.
    mocks.rpc.mockResolvedValue({
      data: [
        {
          groupId,
          tenantId: "99999999-9999-4999-8999-999999999999",
          name: "Bole Equb",
          currency: "ETB",
          role: "owner",
          accounts: [
            { id: cashAccount, code: "POT_CASH", name: "የእቁብ ጥሬ ሂሳብ", type: "asset" },
            { id: incomeAccount, code: "CONTRIBUTION_INCOME", name: "የስጠታ ገቢ", type: "income" }
          ]
        }
      ],
      error: null
    });

    const response = await GET_GROUPS(signedIn());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].role).toBe("owner");
    expect(body.groups[0].accounts.map((a: { code: string }) => a.code)).toEqual([
      "POT_CASH",
      "CONTRIBUTION_INCOME"
    ]);
  });

  it("drops a group whose account type is not one the ledger accepts", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          groupId,
          tenantId: "99999999-9999-4999-8999-999999999999",
          name: "Bole Equb",
          currency: "ETB",
          role: "owner",
          accounts: [{ id: cashAccount, code: "POT", name: "Pot", type: "crypto" }]
        }
      ],
      error: null
    });

    const response = await GET_GROUPS(signedIn());
    const body = await response.json();

    expect(body.groups[0].accounts).toEqual([]);
  });

  it("401s without a bearer token and never reaches storage", async () => {
    const response = await GET_GROUPS(request());

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect((await GET_GROUPS(signedIn())).status).toBe(503);
  });

  it("returns no default group when the treasurer belongs to none", async () => {
    // Guessing which group someone is acting for is how money ends up on the
    // wrong ledger, so an empty answer is the only safe one.
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await GET_GROUPS(signedIn());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
  });
});

describe("both reads are metered", () => {
  it("registers them and gives them the read rule", () => {
    expect(isRateLimitedPath("/api/bank-account-bindings")).toBe(true);
    expect(isRateLimitedPath("/api/my-groups")).toBe(true);
    expect(resolveRateLimit("/api/bank-account-bindings")).toEqual(READ_RULE);
    expect(resolveRateLimit("/api/my-groups")).toEqual(READ_RULE);
  });

  it("the limiter actually answers rather than passing through", () => {
    // `middleware` reads `request.nextUrl`, which a plain `Request` does not
    // have — the same mistake as elsewhere in this file's sibling suites.
    const response = middleware(
      new NextRequest("http://localhost/api/my-groups", {
        headers: { authorization: "Bearer user-token" }
      })
    );

    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
  });
});
