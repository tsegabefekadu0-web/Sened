import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc
  }))
}));

import { createClient } from "@supabase/supabase-js";
import { GET } from "@/app/api/ledger/balances/route";
import { RATE_LIMITED, isRateLimitedPath, resolveRateLimit } from "@/middleware";
import { READ_RULE } from "@/lib/rateLimit";

/**
 * `GET /api/ledger/balances` — per-account balances from `get_ledger_balances_v1`.
 * The function itself is executed against Postgres by scripts/verify-migrations.sql;
 * these tests pin the route around it: auth, scoping, exact numeric passthrough,
 * strict parsing of what the function returns, and the error mapping.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const otherGroupId = "99999999-9999-4999-8999-999999999999";
const cash = "33333333-3333-4333-8333-333333333333";
const income = "44444444-4444-4444-8444-444444444444";

function rpcBody(overrides: Record<string, unknown> = {}) {
  return {
    groupId,
    headSequence: "250",
    entryCount: "250",
    balances: [
      { accountId: income, code: "CONTRIBUTION_INCOME", name: "Contribution income", accountType: "income", balance: "-1234567890123456.50" },
      { accountId: cash, code: "POT_CASH", name: "Pot cash", accountType: "asset", balance: "1234567890123456.50" }
    ],
    ...overrides
  };
}

function request(query: string, headers: Record<string, string> = { authorization: "Bearer user-token" }) {
  return new Request(`http://localhost/api/ledger/balances${query}`, { headers });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.mocked(createClient).mockClear();
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: rpcBody(), error: null } satisfies Result);
});

describe("GET /api/ledger/balances", () => {
  it("returns the snapshot with exact numeric strings, untouched, and no-store caching", async () => {
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual(rpcBody());
    // Beyond 2^53: a JS number would have rounded this; the string is exact.
    expect(body.balances[1].balance).toBe("1234567890123456.50");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("get_ledger_balances_v1", { p_group_id: groupId });
  });

  it("is a single RPC under the caller's own JWT: no table reads, no service role", async () => {
    await GET(request(`?groupId=${groupId}`));
    expect(mocks.from).not.toHaveBeenCalled();
    const clientCalls = vi.mocked(createClient).mock.calls;
    expect(clientCalls.length).toBeGreaterThan(0);
    for (const call of clientCalls) {
      expect(call[1]).toBe("anon-key");
      expect(JSON.stringify(call[2])).toContain("Bearer user-token");
    }
  });

  it("serves an empty ledger as head 0 with zero balances", async () => {
    mocks.rpc.mockResolvedValue({
      data: rpcBody({
        headSequence: "0",
        entryCount: "0",
        balances: [{ accountId: cash, code: "POT_CASH", name: "Pot cash", accountType: "asset", balance: "0.00" }]
      }),
      error: null
    });
    const body = await (await GET(request(`?groupId=${groupId}`))).json();
    expect(body).toMatchObject({ headSequence: "0", entryCount: "0", balances: [{ balance: "0.00" }] });
  });

  it("refuses a group the caller is not a member of with 404, the same as an absent one", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });
    const response = await GET(request(`?groupId=${otherGroupId}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).toHaveBeenCalledWith("get_ledger_balances_v1", { p_group_id: otherGroupId });
  });

  it("recognises the refusal by message as well as by sqlstate", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "ledger_forbidden" } });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(404);
  });

  it("returns 401 with no bearer token and touches nothing", async () => {
    const response = await GET(request(`?groupId=${groupId}`, {}));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 401 for a rejected token", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 503 when Supabase is not configured or the auth server is unreachable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network"));
    const unreachable = await GET(request(`?groupId=${groupId}`));
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toEqual({ error: "auth_unavailable" });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const unconfigured = await GET(request(`?groupId=${groupId}`));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "not_configured" });
  });

  it("returns 502 on a storage failure, never an empty balance", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "storage_failure" });
  });

  const malformed: Array<[string, unknown]> = [
    ["a null body", null],
    ["another group's snapshot", rpcBody({ groupId: otherGroupId })],
    ["a numeric head", rpcBody({ headSequence: 250 })],
    ["a zero-padded head", rpcBody({ headSequence: "0250" })],
    ["a negative count", rpcBody({ entryCount: "-1" })],
    ["a non-list balances", rpcBody({ balances: {} })],
    ["a float balance", rpcBody({ balances: [{ accountId: cash, code: "POT_CASH", name: "x", accountType: "asset", balance: 12.5 }] })],
    ["a balance without two decimals", rpcBody({ balances: [{ accountId: cash, code: "POT_CASH", name: "x", accountType: "asset", balance: "12.5" }] })],
    ["an unknown account type", rpcBody({ balances: [{ accountId: cash, code: "POT_CASH", name: "x", accountType: "magic", balance: "1.00" }] })],
    ["a non-uuid account", rpcBody({ balances: [{ accountId: "nope", code: "POT_CASH", name: "x", accountType: "asset", balance: "1.00" }] })],
    [
      "a duplicated account",
      rpcBody({
        balances: [
          { accountId: cash, code: "POT_CASH", name: "x", accountType: "asset", balance: "1.00" },
          { accountId: cash, code: "POT_CASH", name: "x", accountType: "asset", balance: "1.00" }
        ]
      })
    ]
  ];
  it.each(malformed)("returns 502 for %s rather than passing it on", async (_name, data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });
});

describe("GET /api/ledger/balances query contract", () => {
  const rejects: Array<[string, string]> = [
    ["a missing groupId", ""],
    ["a non-uuid groupId", "?groupId=not-a-uuid"],
    ["a repeated groupId", `?groupId=${groupId}&groupId=${groupId}`],
    ["an unknown tenantId parameter", `?groupId=${groupId}&tenantId=${otherGroupId}`],
    ["a smuggled user_id", `?groupId=${groupId}&user_id=${userId}`],
    ["a limit it does not take", `?groupId=${groupId}&limit=5`]
  ];

  it.each(rejects)("REJECTS (400) %s", async (_name, query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not reflect the offending value in the 400 message", async () => {
    const text = JSON.stringify(await (await GET(request(`?groupId=${groupId}&secret=hunter2`))).json());
    expect(text).toContain("secret");
    expect(text).not.toContain("hunter2");
  });
});

describe("GET /api/ledger/balances is metered with the read rule", () => {
  it("is registered and charged READ_RULE", () => {
    expect(RATE_LIMITED.has("/api/ledger/balances")).toBe(true);
    expect(isRateLimitedPath("/api/ledger/balances")).toBe(true);
    expect(resolveRateLimit("/api/ledger/balances", "GET")).toEqual(READ_RULE);
  });
});
