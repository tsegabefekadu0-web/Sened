import { readFileSync } from "node:fs";
import { join } from "node:path";
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

import { PUT } from "@/app/api/ledger/member-attire/route";
import { RATE_LIMITED, middleware, resolveRateLimit } from "@/middleware";
import { WRITE_RULE, resetRateLimits } from "@/lib/rateLimit";
import { ledgerMemberAttireRequestSchema, parse } from "@/lib/validation";
import { NextRequest } from "next/server";

const userId = "11111111-1111-4111-8111-111111111111";
const otherId = "33333333-3333-4333-8333-333333333333";
const groupId = "22222222-2222-4222-8222-222222222222";
const body = { groupId, attire: "gabi" };

function put(payload: unknown, options: { bearer?: string | null; contentType?: string | null; method?: string } = {}): Request {
  const bearer = options.bearer === undefined ? "token" : options.bearer;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  return new Request("http://localhost/api/ledger/member-attire", {
    method: options.method ?? "PUT",
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
  mocks.rpc.mockReset().mockResolvedValue({ data: { groupId, attire: "gabi", changed: true }, error: null });
});

describe("PUT /api/ledger/member-attire", () => {
  it("sets the caller's own attire through the SQL function, passing no user id", async () => {
    const response = await PUT(put(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groupId, attire: "gabi", changed: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("sened_ledger_set_member_attire_v1", {
      requested_group_id: groupId,
      requested_attire: "gabi"
    });
  });

  it("accepts each of none, gabi and netela and nothing else", async () => {
    for (const attire of ["none", "gabi", "netela"]) {
      mocks.rpc.mockResolvedValue({ data: { groupId, attire, changed: false }, error: null });
      expect((await PUT(put({ groupId, attire }))).status).toBe(200);
    }
  });

  it("REJECTS (400) another user's id, any other field, unknown values and bad ids, before the database", async () => {
    mocks.rpc.mockClear();
    for (const bad of [
      { ...body, userId: otherId },
      { ...body, user_id: otherId },
      { ...body, role: "owner" },
      { ...body, attire: "female" },
      { ...body, attire: "male" },
      { ...body, attire: "GABI" },
      { ...body, attire: "" },
      { ...body, attire: null },
      { groupId, attire: undefined },
      { ...body, groupId: "not-a-uuid" },
      { attire: "gabi" },
      [],
      "gabi",
      null
    ]) {
      expect((await PUT(put(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS (400) a non-JSON content type, malformed JSON or an oversized body", async () => {
    expect((await PUT(put(body, { contentType: "text/plain" }))).status).toBe(400);
    expect((await PUT(put(body, { contentType: null }))).status).toBe(400);
    expect((await PUT(put("{not json"))).status).toBe(400);
    expect((await PUT(put({ ...body, padding: "x".repeat(2_000) }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s without a Bearer token or with a rejected one, and never calls the database", async () => {
    expect((await PUT(put(body, { bearer: null }))).status).toBe(401);
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    expect((await PUT(put(body))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured or authentication is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network"));
    expect((await PUT(put(body))).status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await PUT(put(body))).status).toBe(503);
  });

  it("403s a caller who is not an active member (an outsider), without saying whether the group exists", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });
    const response = await PUT(put(body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("400s a value the database refuses", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "ledger_invalid_request" } });
    expect((await PUT(put(body))).status).toBe(400);
  });

  it("502s an unexpected database error without reflecting it, and a malformed success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret internal detail" } });
    const failed = await PUT(put(body));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("secret");
    mocks.rpc.mockResolvedValue({ data: { groupId, attire: "female", changed: true }, error: null });
    expect((await PUT(put(body))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { groupId }, error: null });
    expect((await PUT(put(body))).status).toBe(502);
  });

  it("exports only PUT: no other method reaches the handler", async () => {
    const route = await import("@/app/api/ledger/member-attire/route");
    expect(Object.keys(route).filter((key) => /^(GET|POST|PATCH|DELETE|PUT)$/.test(key))).toEqual(["PUT"]);
  });
});

describe("rate limiting", () => {
  it("is registered and charged the write limit", () => {
    expect(RATE_LIMITED.has("/api/ledger/member-attire")).toBe(true);
    expect(resolveRateLimit("/api/ledger/member-attire", "PUT")).toEqual(WRITE_RULE);
  });

  it("answers 429 once the write limit is spent", () => {
    let last = 200;
    for (let index = 0; index <= WRITE_RULE.limit; index += 1) {
      last = middleware(
        new NextRequest("http://localhost/api/ledger/member-attire", { method: "PUT", headers: { authorization: "Bearer one" } })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("ledgerMemberAttireRequestSchema", () => {
  it("lower-cases the group id and takes only a known attire", () => {
    expect(parse(ledgerMemberAttireRequestSchema, { groupId: groupId.toUpperCase(), attire: "netela" })).toMatchObject({
      ok: true,
      data: { groupId, attire: "netela" }
    });
    expect(parse(ledgerMemberAttireRequestSchema, { groupId, attire: "female" }).ok).toBe(false);
    expect(parse(ledgerMemberAttireRequestSchema, { groupId, attire: "gabi", userId: otherId }).ok).toBe(false);
  });
});

describe("20261009100000_member_attire.sql contract", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261009100000_member_attire.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const route = readFileSync(join(process.cwd(), "src/lib/ledger/memberAttire.ts"), "utf8");

  it("the setter has exactly the arguments the server sends and no user argument", () => {
    const signature = /create or replace function public\.sened_ledger_set_member_attire_v1\(([^)]*)\)/.exec(code);
    expect(signature).not.toBeNull();
    const names = signature![1].split(",").map((part) => part.trim().split(/\s+/)[0]);
    expect(names).toEqual(["requested_group_id", "requested_attire"]);
    for (const name of names) expect(route).toContain(`${name}:`);
  });

  it("takes the identity from auth.uid() and only touches the caller's own active row", () => {
    const body = code.slice(code.indexOf("create or replace function public.sened_ledger_set_member_attire_v1"), code.indexOf("comment on function public.sened_ledger_set_member_attire_v1"));
    expect(body).toMatch(/actor uuid := auth\.uid\(\)/);
    expect(body.match(/membership\.user_id = actor/g)).toHaveLength(2);
    expect(body).not.toMatch(/user_id = requested/);
    expect(body).toMatch(/security definer/i);
  });

  it("is callable by signed-in users only and widens no policy or table privilege", () => {
    expect(code).toContain("revoke all on function public.sened_ledger_set_member_attire_v1(uuid, text) from public, anon;");
    expect(code).toContain("grant execute on function public.sened_ledger_set_member_attire_v1(uuid, text) to authenticated;");
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant (select|update|all) on/i);
  });

  it("constrains the column to the three known values, defaulting to none", () => {
    expect(code).toMatch(/add column if not exists attire text not null default 'none'/);
    expect(code).toMatch(/check \(attire in \('none', 'gabi', 'netela'\)\)/);
  });

  it("adds attire to the existing members read and my-groups, with unchanged signatures", () => {
    expect(code).toContain("create or replace function public.list_group_members_v1(requested_group_id uuid)");
    expect(code).toContain("'attire', membership.attire");
    expect(code).toContain("create or replace function public.list_my_groups_v1()");
    expect(code).toContain("'attire', membership_row.attire");
    // the email rule of the members read is untouched
    expect(code).toContain("case when caller_role = 'owner' then member_user.email else null end");
  });

  it("is covered by the SQL harness and its runner", () => {
    expect(readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8")).toContain("ALL MEMBER ATTIRE CHECKS PASSED");
    expect(readFileSync(join(process.cwd(), "scripts/verify-migrations.ps1"), "utf8")).toContain("ALL MEMBER ATTIRE CHECKS PASSED");
  });
});
