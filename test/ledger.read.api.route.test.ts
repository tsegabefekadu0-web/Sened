import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  results: {} as Record<string, Result>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
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

import { createClient } from "@supabase/supabase-js";
import { GET, POST } from "@/app/api/ledger/entries/route";
import { RATE_LIMITED, isRateLimitedPath } from "@/middleware";

/**
 * `GET /api/ledger/entries` — the read the O-3 correction form depends on.
 * Tenant isolation is the tables' RLS under the caller's JWT, so these tests
 * check the contract around it: it only ever reads, it never uses a service
 * key, it refuses at every step, and the response carries nothing it should not.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const entryId = "55555555-5555-4555-8555-555555555555";
const correctionId = "77777777-7777-4777-8777-777777777777";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";
const hash = "a".repeat(64);

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: entryId,
    group_id: groupId,
    sequence: 7,
    occurred_at: "2026-09-25T10:30:00+00:00",
    recorded_at: "2026-09-25T10:31:00+00:00",
    entry_type: "contribution",
    corrects_entry_id: null,
    rationale: null,
    actor_id: userId,
    nonce: "66666666-6666-4666-8666-666666666666",
    previous_hash: "0".repeat(64),
    entry_hash: hash,
    ...overrides
  };
}

function postingRows(forEntry = entryId) {
  return [
    {
      id: "88888888-8888-4888-8888-888888888881",
      entry_id: forEntry,
      account_id: cashAccount,
      direction: "debit",
      amount: 25,
      ordinal: 1
    },
    {
      id: "88888888-8888-4888-8888-888888888882",
      entry_id: forEntry,
      account_id: incomeAccount,
      direction: "credit",
      amount: "25.00",
      ordinal: 2
    }
  ];
}

function builder(table: string) {
  const self: Record<string, unknown> = {};
  for (const op of ["select", "eq", "in", "lt", "order", "limit"]) {
    self[op] = (...args: unknown[]) => {
      mocks.calls.push({ table, op, args });
      return self;
    };
  }
  self.maybeSingle = () => Promise.resolve(mocks.results[table]);
  self.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(mocks.results[table]).then(resolve, reject);
  return self;
}

function request(query: string, headers: Record<string, string> = { authorization: "Bearer user-token" }) {
  return new Request(`http://localhost/api/ledger/entries${query}`, { headers });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.mocked(createClient).mockClear();
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  mocks.calls.length = 0;
  mocks.from.mockReset();
  mocks.from.mockImplementation((table: string) => builder(table));
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.results = {
    ledger_groups: { data: { id: groupId }, error: null },
    ledger_entries: { data: [entryRow()], error: null },
    ledger_entry_postings: { data: postingRows(), error: null }
  };
});

describe("GET /api/ledger/entries", () => {
  it("returns the group's entries with canonical postings, newest first", async () => {
    const response = await GET(request(`?groupId=${groupId}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: entryId,
      groupId,
      sequence: "7",
      entryType: "contribution",
      correctsEntryId: null,
      entryHash: hash
    });
    expect(body.entries[0].postings).toEqual([
      expect.objectContaining({ accountId: cashAccount, direction: "debit", amount: "25.00", ordinal: 1 }),
      expect.objectContaining({ accountId: incomeAccount, direction: "credit", amount: "25.00", ordinal: 2 })
    ]);
    expect(mocks.calls).toContainEqual({
      table: "ledger_entries",
      op: "order",
      args: ["sequence", { ascending: false }]
    });
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "limit", args: [51] });
  });

  it("is read-only and runs under the anon key, never a service role", async () => {
    await GET(request(`?groupId=${groupId}`));
    const ops = new Set(mocks.calls.map((call) => call.op));
    expect([...ops].every((op) => ["select", "eq", "in", "lt", "order", "limit"].includes(op))).toBe(true);
    const clientCalls = vi.mocked(createClient).mock.calls;
    expect(clientCalls.length).toBeGreaterThan(0);
    for (const call of clientCalls) {
      expect(call[1]).toBe("anon-key");
    }
  });

  it("never exposes the tenant, request fingerprint or idempotency key", async () => {
    mocks.results.ledger_entries = {
      data: [
        entryRow({
          tenant_id: tenantId,
          request_fingerprint: "f".repeat(64),
          idempotency_key: "secret-idem-key"
        })
      ],
      error: null
    };
    const text = JSON.stringify(await (await GET(request(`?groupId=${groupId}`))).json());
    expect(text).not.toContain(tenantId);
    expect(text).not.toContain("f".repeat(64));
    expect(text).not.toContain("secret-idem-key");
    expect(text).not.toContain("tenant");
    expect(text).not.toContain("idempotency");
  });

  it("returns an empty list for a visible group with no entries", async () => {
    mocks.results.ledger_entries = { data: [], error: null };
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(200);
    expect((await response.json()).entries).toEqual([]);
  });

  it("honours a valid limit", async () => {
    await GET(request(`?groupId=${groupId}&limit=5`));
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "limit", args: [6] });
  });

  it("returns 404 when RLS hides the group, without reading its entries", async () => {
    mocks.results.ledger_groups = { data: null, error: null };
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mocks.calls.some((call) => call.table === "ledger_entries")).toBe(false);
  });

  it("returns 401 with no bearer token and touches nothing", async () => {
    const response = await GET(request(`?groupId=${groupId}`, {}));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 401 for a rejected token", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 503 when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("returns 503 when the auth server is unreachable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network"));
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "auth_unavailable" });
  });

  it("returns 502 on a storage failure rather than an empty list", async () => {
    mocks.results.ledger_entries = { data: null, error: { code: "XX000", message: "boom" } };
    const response = await GET(request(`?groupId=${groupId}`));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "storage_failure" });
  });

  it("returns 502 rather than dropping a malformed row from the record", async () => {
    mocks.results.ledger_entries = {
      data: [entryRow(), entryRow({ id: "not-a-uuid" })],
      error: null
    };
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("returns 502 for an entry that has no postings", async () => {
    mocks.results.ledger_entry_postings = { data: [], error: null };
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("returns 502 for a posting with an invalid amount", async () => {
    mocks.results.ledger_entry_postings = {
      data: [{ ...postingRows()[0], amount: -3 }, postingRows()[1]],
      error: null
    };
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("keeps a correction's link to the entry it corrects", async () => {
    mocks.results.ledger_entries = {
      data: [
        entryRow({
          id: correctionId,
          sequence: 8,
          entry_type: "correction",
          corrects_entry_id: entryId,
          rationale: "Wrong member credited"
        }),
        entryRow()
      ],
      error: null
    };
    mocks.results.ledger_entry_postings = {
      data: [...postingRows(correctionId), ...postingRows()],
      error: null
    };
    const body = await (await GET(request(`?groupId=${groupId}`))).json();
    expect(body.entries[0]).toMatchObject({
      id: correctionId,
      entryType: "correction",
      correctsEntryId: entryId,
      rationale: "Wrong member credited"
    });
  });
});

describe("GET /api/ledger/entries cursor paging", () => {
  const ids = ["a", "b", "c"].map((letter) => letter.repeat(8) + "-0000-4000-8000-" + letter.repeat(12));

  function threeEntries() {
    // The route asks for limit + 1 rows; the database returns them newest first.
    mocks.results.ledger_entries = {
      data: [
        entryRow({ id: ids[2], sequence: 30 }),
        entryRow({ id: ids[1], sequence: 20 }),
        entryRow({ id: ids[0], sequence: 10 })
      ],
      error: null
    };
    mocks.results.ledger_entry_postings = {
      data: [...postingRows(ids[2]), ...postingRows(ids[1]), ...postingRows(ids[0])],
      error: null
    };
  }

  it("keeps the existing fields and adds hasMore: false and nextCursor: null on a short page", async () => {
    const body = await (await GET(request(`?groupId=${groupId}`))).json();
    expect(body.entries).toHaveLength(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("returns exactly `limit` entries with hasMore and a cursor when older entries exist", async () => {
    threeEntries();
    const body = await (await GET(request(`?groupId=${groupId}&limit=2`))).json();
    expect(body.entries.map((entry: { sequence: string }) => entry.sequence)).toEqual(["30", "20"]);
    expect(body.hasMore).toBe(true);
    // The cursor is the oldest returned sequence: the next page is strictly older.
    expect(body.nextCursor).toBe("20");
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "limit", args: [3] });
    expect(mocks.calls.some((call) => call.op === "lt")).toBe(false);
  });

  it("passes beforeSequence as a strict less-than on sequence, in the same newest-first order", async () => {
    await GET(request(`?groupId=${groupId}&beforeSequence=20`));
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "lt", args: ["sequence", "20"] });
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "order", args: ["sequence", { ascending: false }] });
  });

  it("marks the last page: a page filled exactly to the limit with nothing older has hasMore false", async () => {
    mocks.results.ledger_entries = { data: [entryRow({ id: ids[1], sequence: 20 }), entryRow({ id: ids[0], sequence: 10 })], error: null };
    mocks.results.ledger_entry_postings = { data: [...postingRows(ids[1]), ...postingRows(ids[0])], error: null };
    const body = await (await GET(request(`?groupId=${groupId}&limit=2&beforeSequence=30`))).json();
    expect(body.entries).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("returns an empty last page when the cursor is at or before the first entry", async () => {
    mocks.results.ledger_entries = { data: [], error: null };
    const response = await GET(request(`?groupId=${groupId}&beforeSequence=1`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], hasMore: false, nextCursor: null });
  });

  it("walks the whole chain by following nextCursor, without gaps or repeats", async () => {
    const all = [30, 20, 10];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 5; pages += 1) {
      const eligible = all.filter((sequence) => cursor === null || sequence < Number(cursor));
      const rows = eligible.slice(0, 2);
      mocks.results.ledger_entries = {
        data: rows.map((sequence) => entryRow({ id: ids[sequence / 10 - 1], sequence })),
        error: null
      };
      mocks.results.ledger_entry_postings = { data: rows.flatMap((sequence) => postingRows(ids[sequence / 10 - 1])), error: null };
      // limit=1 => the route reads limit + 1 = 2 rows, which is what `rows` models.
      const body: { entries: Array<{ sequence: string }>; hasMore: boolean; nextCursor: string | null } = await (
        await GET(request(`?groupId=${groupId}&limit=1${cursor ? `&beforeSequence=${cursor}` : ""}`))
      ).json();
      seen.push(...body.entries.map((entry) => entry.sequence));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(["30", "20", "10"]);
  });
});

const verificationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const payerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherEntryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function provenanceRow(overrides: Record<string, unknown> = {}) {
  return {
    entryId: entryId,
    verificationId,
    provider: "telebirr",
    verifiedAt: "2026-09-25T10:30:05.123Z",
    memberUserId: payerId,
    ...overrides
  };
}

describe("GET /api/ledger/entries provenance", () => {
  it("returns provenance for an entry the bank-verification sink posted, and null for the rest", async () => {
    mocks.results.ledger_entries = {
      data: [entryRow({ id: otherEntryId, sequence: 8 }), entryRow()],
      error: null
    };
    mocks.results.ledger_entry_postings = { data: [...postingRows(otherEntryId), ...postingRows()], error: null };
    mocks.rpc.mockResolvedValue({ data: [provenanceRow()], error: null });

    const body = await (await GET(request(`?groupId=${groupId}`))).json();

    expect(body.entries[0].id).toBe(otherEntryId);
    expect(body.entries[0].provenance).toBeNull();
    expect(body.entries[1].id).toBe(entryId);
    expect(body.entries[1].provenance).toEqual({
      kind: "bank_verification",
      provider: "telebirr",
      verifiedAt: "2026-09-25T10:30:05.123Z",
      verificationId,
      memberUserId: payerId
    });
    // The group is passed so the function can scope to membership; only the
    // entries on this page are asked about.
    expect(mocks.rpc).toHaveBeenCalledWith("get_ledger_entry_provenance_v1", {
      p_group_id: groupId,
      p_entry_ids: [otherEntryId, entryId]
    });
  });

  it("returns provenance: null on every entry when nothing was bank-verified", async () => {
    const body = await (await GET(request(`?groupId=${groupId}`))).json();
    expect(body.entries[0].provenance).toBeNull();
  });

  it("does not ask about entry types the sink never posts", async () => {
    mocks.results.ledger_entries = { data: [entryRow({ entry_type: "correction" })], error: null };
    const body = await (await GET(request(`?groupId=${groupId}`))).json();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(body.entries[0].provenance).toBeNull();
  });

  it("never reaches the provenance function for a group RLS hides (cross-group isolation)", async () => {
    mocks.results.ledger_groups = { data: null, error: null };
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses (502) when the database says the caller is not a member, rather than showing unverified rows", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ledger_forbidden" } });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("refuses provenance for an entry that was not asked about", async () => {
    mocks.rpc.mockResolvedValue({ data: [provenanceRow({ entryId: otherEntryId })], error: null });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("refuses a malformed provenance row", async () => {
    mocks.rpc.mockResolvedValue({ data: [provenanceRow({ provider: "paypal" })], error: null });
    expect((await GET(request(`?groupId=${groupId}`))).status).toBe(502);
  });

  it("never exposes a stored reference, its HMAC, its ciphertext or the intent's other columns", async () => {
    const reference = "FT26268ABCD1234";
    const hmac = "d".repeat(64);
    const ciphertext = "Y2lwaGVydGV4dC1vZi10aGUtcmVmZXJlbmNl";
    // Even if the database function ever returned more than it should, the
    // reader copies only the named fields.
    mocks.rpc.mockResolvedValue({
      data: [
        provenanceRow({
          providerReference: reference,
          providerReferenceHmac: hmac,
          provider_reference_ciphertext: ciphertext,
          providerTransactionIdentityHmac: hmac,
          evidenceFingerprint: "e".repeat(64),
          idempotencyKey: "bank-intent-secret",
          referenceMasked: reference
        })
      ],
      error: null
    });
    const response = await GET(request(`?groupId=${groupId}`));
    const text = JSON.stringify(await response.json());
    expect(text).toContain(verificationId);
    for (const secret of [reference, hmac, ciphertext, "e".repeat(64), "bank-intent-secret", "referenceMasked", "Hmac", "ciphertext"]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(text).entries[0].provenance).sort()).toEqual([
      "kind",
      "memberUserId",
      "provider",
      "verificationId",
      "verifiedAt"
    ]);
  });
});

describe("GET /api/ledger/entries query contract", () => {
  const rejects: Array<[string, string]> = [
    ["REJECTS (400) a missing groupId", ""],
    ["REJECTS (400) a non-uuid groupId", "?groupId=not-a-uuid"],
    ["REJECTS (400) an unknown parameter such as tenantId", `?groupId=${groupId}&tenantId=${tenantId}`],
    ["REJECTS (400) a smuggled user_id", `?groupId=${groupId}&user_id=${userId}`],
    ["REJECTS (400) a repeated groupId", `?groupId=${groupId}&groupId=${groupId}`],
    ["REJECTS (400) limit=0", `?groupId=${groupId}&limit=0`],
    ["REJECTS (400) limit above the maximum", `?groupId=${groupId}&limit=101`],
    ["REJECTS (400) a non-numeric limit", `?groupId=${groupId}&limit=abc`],
    ["REJECTS (400) a negative limit", `?groupId=${groupId}&limit=-1`],
    ["REJECTS (400) a fractional limit", `?groupId=${groupId}&limit=1.5`],
    ["REJECTS (400) beforeSequence=0", `?groupId=${groupId}&beforeSequence=0`],
    ["REJECTS (400) a negative beforeSequence", `?groupId=${groupId}&beforeSequence=-5`],
    ["REJECTS (400) a non-numeric beforeSequence", `?groupId=${groupId}&beforeSequence=abc`],
    ["REJECTS (400) a fractional beforeSequence", `?groupId=${groupId}&beforeSequence=1.5`],
    ["REJECTS (400) a zero-padded beforeSequence", `?groupId=${groupId}&beforeSequence=007`],
    ["REJECTS (400) an exponent beforeSequence", `?groupId=${groupId}&beforeSequence=1e3`],
    ["REJECTS (400) a beforeSequence past bigint", `?groupId=${groupId}&beforeSequence=9223372036854775808`],
    ["REJECTS (400) a repeated beforeSequence", `?groupId=${groupId}&beforeSequence=5&beforeSequence=6`]
  ];

  it.each(rejects)("%s", async (_name, query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not reflect the offending value in the 400 message", async () => {
    const response = await GET(request(`?groupId=${groupId}&secret=hunter2`));
    const text = JSON.stringify(await response.json());
    expect(text).toContain("secret");
    expect(text).not.toContain("hunter2");
  });
});

describe("GET /api/ledger/entries is metered and does not disturb POST", () => {
  it("shares the registered, rate-limited path", () => {
    expect(RATE_LIMITED.has("/api/ledger/entries")).toBe(true);
    expect(isRateLimitedPath("/api/ledger/entries")).toBe(true);
  });

  it("leaves POST refusing an unauthenticated write", async () => {
    const response = await POST(
      new Request("http://localhost/api/ledger/entries", { method: "POST", body: "{}" })
    );
    expect(response.status).toBe(401);
  });
});
