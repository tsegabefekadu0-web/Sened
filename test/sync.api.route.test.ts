import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  calls: [] as { table: string; op: string; args: unknown[] }[],
  results: {} as Record<string, Result>
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.from
  }))
}));

import { POST as POST_SYNC } from "@/app/api/sync/route";
import { buildLedgerEntry, type LedgerEntryRequest } from "@/lib/ledger";
import { HttpSyncTransport } from "@/lib/offline/transport";
import type { SyncPushEnvelope } from "@/lib/offline/contract";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const otherGroupId = "77777777-7777-4777-8777-777777777777";
const tenantId = "99999999-9999-4999-8999-999999999999";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";
const zeros = "0".repeat(64);

function draft(key: string, overrides: Partial<LedgerEntryRequest> = {}): LedgerEntryRequest {
  return {
    groupId,
    idempotencyKey: key,
    occurredAt: "2026-09-25T10:30:00.000Z",
    entryType: "contribution",
    postings: [
      { accountId: cashAccount, direction: "debit", amount: "25.00" },
      { accountId: incomeAccount, direction: "credit", amount: "25.00" }
    ],
    ...overrides
  };
}

function envelope(mutationId: string, request: LedgerEntryRequest, kind: SyncPushEnvelope["kind"] = "ledger-draft") {
  return {
    mutationId,
    idempotencyKey: request.idempotencyKey,
    kind,
    groupId: request.groupId,
    payload: request,
    clientRecordedAt: "2026-09-25T10:30:00.000Z"
  };
}

function post(handler: typeof POST_SYNC, body: unknown, bearer = "token"): Request {
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

/** A tiny stand-in for post_ledger_entry_v1: idempotent per (group, key), role-gated per group. */
function installFakeLedger() {
  const store = new Map<string, ReturnType<typeof buildLedgerEntry>>();
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "get_ledger_entry_provenance_v1" || name === "get_ledger_entry_attributions_v1") {
      return { data: [], error: null };
    }
    expect(name).toBe("post_ledger_entry_v1");
    const group = args.requested_group_id as string;
    if (group === otherGroupId) {
      return { data: null, error: { code: "42501", message: "ledger_forbidden" } };
    }
    const key = `${group}:${args.requested_idempotency_key as string}`;
    const existing = store.get(key);
    if (existing) {
      return { data: { entry: existing, replayed: true }, error: null };
    }
    const sequence = String(store.size + 1);
    const request: LedgerEntryRequest = {
      groupId: group,
      idempotencyKey: args.requested_idempotency_key as string,
      occurredAt: args.requested_occurred_at as string,
      entryType: args.requested_entry_type as LedgerEntryRequest["entryType"],
      postings: args.requested_postings as LedgerEntryRequest["postings"]
    };
    const entry = buildLedgerEntry({
      request,
      actorId,
      tenantId,
      entryId: `5555555${sequence}-5555-4555-8555-555555555555`,
      nonce: `6666666${sequence}-6666-4666-8666-666666666666`,
      sequence,
      previousHash: zeros,
      recordedAt: "2026-09-25T10:30:01.000Z",
      postingIds: [
        `aaaaaaa${sequence}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `bbbbbbb${sequence}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
      ]
    });
    store.set(key, entry);
    return { data: { entry, replayed: false }, error: null };
  });
  return store;
}

function builder(table: string) {
  const self: Record<string, unknown> = {};
  for (const op of ["select", "eq", "gt", "lte", "in", "order", "limit"]) {
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

const entryId = (n: number) => `5555555${n}-5555-4555-8555-555555555555`;
const hashOf = (n: number) => String(n).repeat(64);

function entryRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: entryId(n),
    group_id: groupId,
    sequence: n,
    occurred_at: "2026-09-25T10:30:00+00:00",
    recorded_at: "2026-09-25T10:30:01+00:00",
    entry_type: "contribution",
    corrects_entry_id: null,
    rationale: null,
    actor_id: actorId,
    nonce: `6666666${n}-6666-4666-8666-666666666666`,
    previous_hash: n === 1 ? zeros : hashOf(n - 1),
    entry_hash: hashOf(n),
    ...overrides
  };
}

function postingRows(ns: number[]) {
  return ns.flatMap((n) => [
    { id: `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, entry_id: entryId(n), account_id: cashAccount, direction: "debit", amount: 25, ordinal: 1 },
    { id: `bbbbbbb${n}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, entry_id: entryId(n), account_id: incomeAccount, direction: "credit", amount: 25, ordinal: 2 }
  ]);
}

function setChain(sequences: number[], headSequence = Math.max(0, ...sequences)) {
  mocks.results = {
    ledger_group_heads: {
      data: { group_id: groupId, tenant_id: tenantId, last_sequence: headSequence, last_hash: headSequence === 0 ? zeros : hashOf(headSequence) },
      error: null
    },
    ledger_entries: { data: sequences.map((n) => entryRow(n)), error: null },
    ledger_entry_postings: { data: postingRows(sequences), error: null }
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: actorId } }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  mocks.calls.length = 0;
  mocks.from.mockReset().mockImplementation((table: string) => builder(table));
  setChain([1, 2, 3]);
});

describe("POST /api/sync — push", () => {
  it("401s without a token and 400s on a bad body, before touching the ledger", async () => {
    installFakeLedger();
    expect((await POST_SYNC(post(POST_SYNC, { mutations: [] }, ""))).status).toBe(401);
    for (const body of [
      { mutations: [] },
      { mutations: [envelope("m1", draft("k-1"))], extra: 1 },
      { mutations: [{ ...envelope("m1", draft("k-1")), actorId }] },
      { mutations: [envelope("m1", draft("k-1")), envelope("m1", draft("k-2"))] },
      { mutations: [{ ...envelope("m1", draft("k-1")), idempotencyKey: "bad key!" }] },
      [] as unknown
    ]) {
      const response = await POST_SYNC(post(POST_SYNC, body));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON content type and an oversized body", async () => {
    const wrongType = new Request("http://localhost/api/sync", {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: "Bearer token" },
      body: "{}"
    });
    expect((await POST_SYNC(wrongType)).status).toBe(400);
    const huge = post(POST_SYNC, { mutations: [], pad: "x".repeat(300_000) });
    expect((await POST_SYNC(huge)).status).toBe(400);
  });

  it("503s when auth is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("down"));
    expect((await POST_SYNC(post(POST_SYNC, { mutations: [envelope("m1", draft("k-1"))] }))).status).toBe(503);
  });

  it("accepts a draft and answers in the shape the client parses", async () => {
    installFakeLedger();
    const response = await POST_SYNC(post(POST_SYNC, { mutations: [envelope("m1", draft("k-1"))] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.results).toEqual([
      {
        mutationId: "m1",
        outcome: "ACCEPTED",
        serverEntryId: entryId(1),
        serverEntryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        serverSequence: "1"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("tenant");
  });

  it("replays idempotently: the second send is REPLAYED with the original ids, never a second entry", async () => {
    const store = installFakeLedger();
    const send = () => POST_SYNC(post(POST_SYNC, { mutations: [envelope("m1", draft("k-1"))] }));
    const first = (await (await send()).json()).results[0];
    const second = (await (await send()).json()).results[0];

    expect(first.outcome).toBe("ACCEPTED");
    expect(second).toMatchObject({
      outcome: "REPLAYED",
      serverEntryId: first.serverEntryId,
      serverEntryHash: first.serverEntryHash,
      serverSequence: first.serverSequence
    });
    expect(store.size).toBe(1);
    // Both calls carried the same key to the RPC, which is what dedupes.
    expect(mocks.rpc.mock.calls.map(([, args]) => args.requested_idempotency_key)).toEqual(["k-1", "k-1"]);
  });

  it("settles a mixed batch per item: one bad draft does not poison the rest", async () => {
    installFakeLedger();
    const unbalanced = draft("k-bad", {
      postings: [
        { accountId: cashAccount, direction: "debit", amount: "25.00" },
        { accountId: incomeAccount, direction: "credit", amount: "20.00" }
      ]
    });
    const mutations = [
      envelope("m1", draft("k-1")),
      envelope("m2", unbalanced),
      envelope("m3", draft("k-3", { groupId: otherGroupId })),
      envelope("m4", draft("k-4"), "spoken-note"),
      { ...envelope("m5", draft("k-5")), groupId: tenantId },
      envelope("m6", draft("k-6"))
    ];
    const response = await POST_SYNC(post(POST_SYNC, { mutations }));
    const { results } = await response.json();

    expect(response.status).toBe(200);
    expect(results.map((r: { mutationId: string }) => r.mutationId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "ACCEPTED",
      "REJECTED",
      "REJECTED",
      "REJECTED",
      "REJECTED",
      "ACCEPTED"
    ]);
    expect(results[1].error).toBe("invalid_request"); // unbalanced fails the shared schema
    expect(results[2].error).toBe("forbidden"); // role refusal from the RPC
    expect(results[3].error).toBe("unsupported_mutation_kind");
    expect(results[4].error).toBe("envelope_mismatch");
    // Only the three drafts that passed local validation reached the RPC.
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("uses the envelope's key as the ledger idempotency key, as the outbox derives it", async () => {
    const store = installFakeLedger();
    const outboxKey = `sened-offline:ledger-draft:${groupId}:5a1c2f0e-1111-4222-8333-444455556666`;
    const mutation = { ...envelope("m1", draft("offline-local-label")), idempotencyKey: outboxKey };
    const first = (await (await POST_SYNC(post(POST_SYNC, { mutations: [mutation] }))).json()).results[0];
    const second = (await (await POST_SYNC(post(POST_SYNC, { mutations: [mutation] }))).json()).results[0];

    expect(first.outcome).toBe("ACCEPTED");
    expect(second).toMatchObject({ outcome: "REPLAYED", serverEntryId: first.serverEntryId });
    expect(store.size).toBe(1);
    expect(mocks.rpc.mock.calls.map(([, args]) => args.requested_idempotency_key)).toEqual([outboxKey, outboxKey]);
  });

  it("maps ledger errors as the entries route does, and keeps transient ones retryable", async () => {
    const cases: [{ code: string; message: string }, string, boolean][] = [
      [{ code: "P0002", message: "ledger_group_not_found" }, "not_found", false],
      [{ code: "23505", message: "ledger_idempotency_conflict" }, "idempotency_conflict", false],
      [{ code: "PGRST202", message: "missing" }, "ledger_unavailable", true],
      [{ code: "XX000", message: "boom" }, "ledger_write_failed", true]
    ];
    for (const [error, expected, retryable] of cases) {
      mocks.rpc.mockReset().mockResolvedValue({ data: null, error });
      const { results } = await (await POST_SYNC(post(POST_SYNC, { mutations: [envelope("m1", draft("k-1"))] }))).json();
      expect(results[0].outcome).toBe("REJECTED");
      expect(results[0].error).toBe(expected);
      expect(results[0].retryAfterMs !== undefined).toBe(retryable);
    }
  });
});

describe("POST /api/sync — pull", () => {
  const pullBody = { groupId, sinceSequence: "0", limit: 200 };

  it("401s without a token and 400s on a bad body", async () => {
    expect((await POST_SYNC(post(POST_SYNC, pullBody, ""))).status).toBe(401);
    for (const body of [
      { ...pullBody, sinceSequence: "-1" },
      { ...pullBody, sinceSequence: 0 },
      { ...pullBody, limit: 0 },
      { ...pullBody, limit: 501 },
      { ...pullBody, extra: true },
      { groupId: "nope", sinceSequence: "0", limit: 1 },
      { sinceSequence: "0", limit: 1 }
    ]) {
      expect((await POST_SYNC(post(POST_SYNC, body))).status).toBe(400);
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns the head and the ascending slice under the caller's own client", async () => {
    const response = await POST_SYNC(post(POST_SYNC, pullBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({
      groupId,
      head: { groupId, tenantId, lastSequence: "3", lastHash: hashOf(3) },
      hasMore: false
    });
    expect(body.entries.map((e: { sequence: string }) => e.sequence)).toEqual(["1", "2", "3"]);
    expect(body.entries[1]).toMatchObject({ previousHash: hashOf(1), entryHash: hashOf(2), actorId });
    expect(body.entries[0].postings).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/idempotency|fingerprint/i);
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "gt", args: ["sequence", "0"] });
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "lte", args: ["sequence", "3"] });
    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "order", args: ["sequence", { ascending: true }] });
    // The only RPCs a pull makes are the read-only provenance and attribution
    // lookups; none of these entries was bank-verified or attributed, so each
    // carries `provenance: null` and `attribution: null`.
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_ledger_entry_provenance_v1",
      "get_ledger_entry_attributions_v1"
    ]);
    expect(body.entries.map((e: { provenance: unknown }) => e.provenance)).toEqual([null, null, null]);
    expect(body.entries.map((e: { attribution: unknown }) => e.attribution)).toEqual([null, null, null]);
  });

  it("carries bank-verification provenance on a pulled entry, and never a reference", async () => {
    const verificationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const payerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mocks.rpc.mockImplementation(async (name: string) => ({
      data:
        name === "get_ledger_entry_attributions_v1"
          ? []
          : [
              {
                entryId: "55555552-5555-4555-8555-555555555555",
                verificationId,
                provider: "cbe",
                verifiedAt: "2026-09-25T10:30:05.000Z",
                memberUserId: payerId,
                providerReferenceHmac: "d".repeat(64)
              }
            ],
      error: null
    }));
    const body = await (await POST_SYNC(post(POST_SYNC, pullBody))).json();
    expect(body.entries[1].provenance).toEqual({
      kind: "bank_verification",
      provider: "cbe",
      verifiedAt: "2026-09-25T10:30:05.000Z",
      verificationId,
      memberUserId: payerId,
      referenceMasked: null
    });
    expect(body.entries[0].provenance).toBeNull();
    expect(JSON.stringify(body)).not.toContain("d".repeat(64));
  });

  it("pages: asks for limit+1, trims, and reports hasMore", async () => {
    setChain([1, 2, 3]);
    const body = await (await POST_SYNC(post(POST_SYNC, { ...pullBody, limit: 2 }))).json();

    expect(mocks.calls).toContainEqual({ table: "ledger_entries", op: "limit", args: [3] });
    expect(body.entries.map((e: { sequence: string }) => e.sequence)).toEqual(["1", "2"]);
    expect(body.hasMore).toBe(true);
    expect(body.head.lastSequence).toBe("3");
  });

  it("returns a head and no entries for an empty or caught-up chain", async () => {
    setChain([], 0);
    const body = await (await POST_SYNC(post(POST_SYNC, pullBody))).json();
    expect(body).toMatchObject({ head: { lastSequence: "0", lastHash: zeros }, entries: [], hasMore: false });
  });

  it("404s a group the caller cannot see (RLS returns no head)", async () => {
    mocks.results.ledger_group_heads = { data: null, error: null };
    expect((await POST_SYNC(post(POST_SYNC, pullBody))).status).toBe(404);
  });

  it("refuses to serve a chain it cannot vouch for", async () => {
    mocks.results.ledger_entries = { data: [entryRow(1), entryRow(3)], error: null };
    mocks.results.ledger_entry_postings = { data: postingRows([1, 3]), error: null };
    expect((await POST_SYNC(post(POST_SYNC, pullBody))).status).toBe(502); // gap

    mocks.results.ledger_entries = { data: [entryRow(1), entryRow(2, { previous_hash: "f".repeat(64) })], error: null };
    mocks.results.ledger_entry_postings = { data: postingRows([1, 2]), error: null };
    expect((await POST_SYNC(post(POST_SYNC, pullBody))).status).toBe(502); // broken link

    setChain([1, 2, 3]);
    mocks.results.ledger_group_heads = {
      data: { group_id: groupId, tenant_id: tenantId, last_sequence: 3, last_hash: "e".repeat(64) },
      error: null
    };
    expect((await POST_SYNC(post(POST_SYNC, pullBody))).status).toBe(502); // head disagrees
  });

  it("502s on a storage error", async () => {
    mocks.results.ledger_group_heads = { data: null, error: { message: "boom" } };
    expect((await POST_SYNC(post(POST_SYNC, pullBody))).status).toBe(502);
  });
});

describe("the real client transport against the real handler", () => {
  function transport() {
    const fetchImpl = (async (url: string, init: RequestInit) => POST_SYNC(new Request(`http://localhost${url}`, init))) as unknown as typeof fetch;
    return new HttpSyncTransport({ fetchImpl });
  }

  it("round-trips a mixed push, a replay, and a pull through the client's own parsing", async () => {
    installFakeLedger();
    const t = transport();
    const batch = [
      envelope("m1", draft("k-1")),
      envelope("m2", draft("k-2", { groupId: otherGroupId })),
      envelope("m3", draft("k-3"))
    ] as SyncPushEnvelope[];

    const first = await t.push("Bearer token", batch);
    expect(first.map((r) => [r.mutationId, r.outcome])).toEqual([
      ["m1", "ACCEPTED"],
      ["m2", "REJECTED"],
      ["m3", "ACCEPTED"]
    ]);
    expect(first[1]?.error).toBe("forbidden");

    const second = await t.push("Bearer token", [batch[0]!]);
    expect(second[0]).toMatchObject({ outcome: "REPLAYED", serverEntryId: first[0]?.serverEntryId });

    const pulled = await t.pull("Bearer token", { groupId, sinceSequence: "0", limit: 200 });
    expect(pulled.head).toEqual({ groupId, tenantId, lastSequence: "3", lastHash: hashOf(3) });
    expect(pulled.entries.map((e) => e.sequence)).toEqual(["1", "2", "3"]);
    expect(pulled.hasMore).toBe(false);
  });

  it("maps the handler's 401 to the client's unauthenticated code", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad jwt" } });
    await expect(transport().push("Bearer stale", [envelope("m1", draft("k-1")) as SyncPushEnvelope])).rejects.toMatchObject({
      code: "SYNC_UNAUTHENTICATED"
    });
  });
});
