import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: vi.fn()
  }))
}));

import { PUT, POST } from "@/app/api/ledger/attributions/route";
import { RATE_LIMITED, resolveRateLimit } from "@/middleware";
import { WRITE_RULE, resetRateLimits } from "@/lib/rateLimit";
import {
  ledgerAttributionRecordRequestSchema,
  ledgerAttributionSupersedeRequestSchema,
  ledgerEntryAttributionSchema,
  parse
} from "@/lib/validation";

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const entryId = "55555555-5555-4555-8555-555555555555";
const memberId = "33333333-3333-4333-8333-333333333333";
const cycleId = "66666666-6666-4666-8666-666666666666";
const body = { groupId, entryId, memberUserId: memberId };

function attributionRow(overrides: Record<string, unknown> = {}) {
  return {
    entryId,
    memberUserId: memberId,
    source: "treasurer",
    recordedBy: userId,
    recordedAt: "2026-10-10T09:00:00.000Z",
    cycleId: null,
    round: null,
    revision: 1,
    reason: null,
    ...overrides
  };
}

function send(method: string, payload: unknown, options: { bearer?: string | null; contentType?: string | null } = {}): Request {
  const bearer = options.bearer === undefined ? "token" : options.bearer;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  return new Request("http://localhost/api/ledger/attributions", {
    method,
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
  mocks.rpc.mockReset().mockResolvedValue({ data: { attribution: attributionRow(), replayed: false }, error: null });
});

describe("POST /api/ledger/attributions", () => {
  it("records the payer through the SQL function and passes no 'recorded by' to it", async () => {
    const response = await POST(send("POST", body));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ attribution: attributionRow(), replayed: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    // The recorder is auth.uid() inside the function: no argument can name one.
    expect(mocks.rpc).toHaveBeenCalledWith("record_ledger_entry_attribution_v1", {
      p_group_id: groupId,
      p_entry_id: entryId,
      p_member_user_id: memberId,
      p_cycle_id: null,
      p_round: null
    });
  });

  it("passes the optional cycle and round through, and a repeat is a 200 replay", async () => {
    mocks.rpc.mockResolvedValue({ data: { attribution: attributionRow({ cycleId, round: 3 }), replayed: true }, error: null });
    const response = await POST(send("POST", { ...body, cycleId, round: 3 }));
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("record_ledger_entry_attribution_v1", expect.objectContaining({ p_cycle_id: cycleId, p_round: 3 }));
  });

  it("REJECTS (400) who is recording, the source, any other field, a round without its cycle and bad ids, before the database", async () => {
    for (const bad of [
      { ...body, recordedBy: userId },
      { ...body, recorded_by: userId },
      { ...body, source: "bank_verification" },
      { ...body, actorId: userId },
      { ...body, role: "owner" },
      { ...body, round: 2 },
      { ...body, cycleId, round: 0 },
      { ...body, cycleId, round: 1001 },
      { ...body, cycleId, round: 1.5 },
      { ...body, cycleId: "nope" },
      { ...body, memberUserId: "nope" },
      { ...body, entryId: "nope" },
      { ...body, groupId: "nope" },
      { groupId, entryId },
      { groupId, memberUserId: memberId },
      { ...body, reason: "not accepted on a first record" },
      [],
      "x",
      null
    ]) {
      expect((await POST(send("POST", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS (400) a non-JSON content type, malformed JSON or an oversized body", async () => {
    expect((await POST(send("POST", body, { contentType: "text/plain" }))).status).toBe(400);
    expect((await POST(send("POST", body, { contentType: null }))).status).toBe(400);
    expect((await POST(send("POST", "{not json"))).status).toBe(400);
    expect((await POST(send("POST", { ...body, padding: "x".repeat(4_000) }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("401s without a Bearer token or with a rejected one, and never calls the database", async () => {
    expect((await POST(send("POST", body, { bearer: null }))).status).toBe(401);
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    expect((await POST(send("POST", body))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured or authentication is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network"));
    expect((await POST(send("POST", body))).status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await POST(send("POST", body))).status).toBe(503);
  });

  it("403s anyone the database refuses (a plain member, an outsider, an unknown group), saying nothing more", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });
    const response = await POST(send("POST", body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("maps each database refusal to its status and its own code", async () => {
    const cases: Array<[string, string, number]> = [
      ["P0002", "ledger_entry_not_found", 404],
      ["P0002", "ledger_member_not_found", 404],
      ["P0002", "ledger_cycle_not_found", 404],
      ["22023", "attribution_not_contribution", 422],
      ["22023", "ledger_invalid_request", 422],
      ["P0001", "attribution_bank_verified", 409],
      ["P0001", "attribution_entry_corrected", 409],
      ["P0001", "attribution_exists", 409],
      ["P0001", "attribution_conflict", 409]
    ];
    for (const [code, message, status] of cases) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message } });
      const response = await POST(send("POST", body));
      expect(response.status, message).toBe(status);
      expect(await response.json()).toEqual({ error: message });
    }
  });

  it("answers 502 for a storage failure and for a response that is not an attribution", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await POST(send("POST", body))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { attribution: { entryId: "x" }, replayed: false }, error: null });
    expect((await POST(send("POST", body))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { attribution: attributionRow({ source: "admin" }), replayed: false }, error: null });
    expect((await POST(send("POST", body))).status).toBe(502);
  });
});

describe("PUT /api/ledger/attributions (correct with a reason, never edit)", () => {
  const correction = { ...body, reason: "Receipt book shows another member paid" };

  it("supersedes through the SQL function with the reason", async () => {
    mocks.rpc.mockResolvedValue({
      data: { attribution: attributionRow({ revision: 2, reason: correction.reason }), replayed: false },
      error: null
    });
    const response = await PUT(send("PUT", correction));
    expect(response.status).toBe(201);
    expect((await response.json()).attribution).toMatchObject({ revision: 2, reason: correction.reason });
    expect(mocks.rpc).toHaveBeenCalledWith("supersede_ledger_entry_attribution_v1", {
      p_group_id: groupId,
      p_entry_id: entryId,
      p_member_user_id: memberId,
      p_reason: correction.reason,
      p_cycle_id: null,
      p_round: null
    });
  });

  it("REQUIRES a reason of 10..1000 characters and refuses extra fields", async () => {
    for (const bad of [
      body,
      { ...body, reason: "short" },
      { ...body, reason: "         " },
      { ...body, reason: "x".repeat(1001) },
      { ...correction, recordedBy: userId },
      { ...correction, round: 2 }
    ]) {
      expect((await PUT(send("PUT", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps nothing-to-supersede, no-change and the bank's precedence", async () => {
    for (const [code, message, status] of [
      ["P0002", "attribution_not_found", 404],
      ["P0001", "attribution_unchanged", 409],
      ["P0001", "attribution_bank_verified", 409],
      ["42501", "ledger_forbidden", 403]
    ] as const) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message } });
      expect((await PUT(send("PUT", correction))).status, message).toBe(status);
    }
  });

  it("401s without a token", async () => {
    expect((await PUT(send("PUT", correction, { bearer: null }))).status).toBe(401);
  });
});

describe("the attribution request schemas", () => {
  it("accept the documented bodies and nothing else", () => {
    expect(parse(ledgerAttributionRecordRequestSchema, body).ok).toBe(true);
    expect(parse(ledgerAttributionRecordRequestSchema, { ...body, cycleId, round: 4 }).ok).toBe(true);
    expect(parse(ledgerAttributionRecordRequestSchema, { ...body, recordedBy: userId }).ok).toBe(false);
    expect(parse(ledgerAttributionSupersedeRequestSchema, { ...body, reason: "ten chars!!" }).ok).toBe(true);
    expect(parse(ledgerEntryAttributionSchema, { memberUserId: memberId }).ok).toBe(true);
    expect(parse(ledgerEntryAttributionSchema, { memberUserId: memberId, round: 2 }).ok).toBe(false);
    expect(parse(ledgerEntryAttributionSchema, { memberUserId: memberId, entryId }).ok).toBe(false);
  });
});

describe("registration", () => {
  it("is metered as a write for both methods", () => {
    expect(RATE_LIMITED.has("/api/ledger/attributions")).toBe(true);
    expect(resolveRateLimit("/api/ledger/attributions", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/ledger/attributions", "PUT")).toEqual(WRITE_RULE);
  });
});
