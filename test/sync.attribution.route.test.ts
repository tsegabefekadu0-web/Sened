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

import { POST as POST_SYNC } from "@/app/api/sync/route";
import { buildLedgerEntry, type LedgerEntryRequest } from "@/lib/ledger";
import { HttpSyncTransport } from "@/lib/offline/transport";
import type { SyncPushEnvelope } from "@/lib/offline/contract";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";
const payer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPayer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const cycle = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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

function envelope(mutationId: string, payload: unknown, key = "k-1"): SyncPushEnvelope {
  return {
    mutationId,
    idempotencyKey: key,
    kind: "ledger-draft",
    groupId,
    payload,
    clientRecordedAt: "2026-09-25T10:30:00.000Z"
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer token" },
    body: JSON.stringify(body)
  });
}

interface AttributionRow {
  entryId: string;
  memberUserId: string;
  cycleId: string | null;
  round: number | null;
  channel: string | null;
  note: string | null;
}

/**
 * A stand-in for post_ledger_entry_v1 (idempotent per group + key) and for
 * record_ledger_entry_attribution_v1 with its real replay rule: the first record
 * of an entry is written, an identical one is answered with the existing record
 * (`replayed: true`), a different one is `attribution_exists`.
 */
function installFakeLedger(options: { attributionError?: { code?: string; message: string } } = {}) {
  const entries = new Map<string, ReturnType<typeof buildLedgerEntry>>();
  const attributions = new Map<string, AttributionRow>();
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "record_ledger_entry_attribution_v1") {
      if (options.attributionError) {
        return { data: null, error: options.attributionError };
      }
      const entryId = args.p_entry_id as string;
      const next: AttributionRow = {
        entryId,
        memberUserId: args.p_member_user_id as string,
        cycleId: (args.p_cycle_id as string | null) ?? null,
        round: (args.p_round as number | null) ?? null,
        channel: (args.p_channel as string | null) ?? null,
        note: (args.p_note as string | null) ?? null
      };
      const existing = attributions.get(entryId);
      if (existing) {
        const same =
          existing.memberUserId === next.memberUserId &&
          existing.cycleId === next.cycleId &&
          existing.round === next.round &&
          existing.channel === next.channel &&
          existing.note === next.note;
        return same
          ? { data: envelopeOf(existing, true), error: null }
          : { data: null, error: { code: "P0001", message: "attribution_exists" } };
      }
      attributions.set(entryId, next);
      return { data: envelopeOf(next, false), error: null };
    }
    expect(name).toBe("post_ledger_entry_v1");
    const key = `${args.requested_group_id as string}:${args.requested_idempotency_key as string}`;
    const existing = entries.get(key);
    if (existing) {
      return { data: { entry: existing, replayed: true }, error: null };
    }
    const sequence = String(entries.size + 1);
    const request: LedgerEntryRequest = {
      groupId: args.requested_group_id as string,
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
      postingIds: [`aaaaaaa${sequence}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, `bbbbbbb${sequence}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`]
    });
    entries.set(key, entry);
    return { data: { entry, replayed: false }, error: null };
  });
  return { entries, attributions };
}

function envelopeOf(row: AttributionRow, replayed: boolean) {
  return {
    attribution: {
      entryId: row.entryId,
      memberUserId: row.memberUserId,
      source: "treasurer",
      recordedBy: actorId,
      recordedAt: "2026-09-25T10:30:02.000Z",
      cycleId: row.cycleId,
      round: row.round,
      revision: 1,
      reason: null,
      channel: row.channel,
      note: row.note
    },
    replayed
  };
}

async function push(...mutations: SyncPushEnvelope[]) {
  const response = await POST_SYNC(post({ mutations }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { results: Record<string, unknown>[] }).results;
}

const attributionCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === "record_ledger_entry_attribution_v1");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: actorId } }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("POST /api/sync — push of a ledger draft that carries a payer", () => {
  it("accepts the entry and records the payer, and the attribution never reaches the entry's request", async () => {
    const { attributions } = installFakeLedger();
    const [result] = await push(
      envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer, cycleId: cycle, round: 3 } })
    );

    expect(result).toEqual({
      mutationId: "m1",
      outcome: "ACCEPTED",
      serverEntryId: expect.any(String),
      serverEntryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      serverSequence: "1",
      attribution: { outcome: "RECORDED" }
    });
    expect(attributions.size).toBe(1);
    expect(attributionCalls()[0][1]).toEqual({
      p_group_id: groupId,
      p_entry_id: result.serverEntryId,
      p_member_user_id: payer,
      p_cycle_id: cycle,
      p_round: 3,
      p_channel: null,
      p_note: null
    });
    // The entry RPC saw exactly the entry fields: no `attribution` anywhere.
    const entryCall = mocks.rpc.mock.calls.find(([name]) => name === "post_ledger_entry_v1")!;
    expect(JSON.stringify(entryCall[1])).not.toContain(payer);
  });

  it("records the payment channel and the note with the payer, and neither reaches the entry's request", async () => {
    const { attributions } = installFakeLedger();
    const [result] = await push(
      envelope("m1", {
        ...draft("k-1"),
        attribution: { memberUserId: payer, channel: "telebirr", note: "  Sent by his wife  " }
      })
    );
    expect(result).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "RECORDED" } });
    expect(attributionCalls()[0][1]).toMatchObject({ p_channel: "telebirr", p_note: "Sent by his wife" });
    expect([...attributions.values()][0]).toMatchObject({ channel: "telebirr", note: "Sent by his wife" });
    const entryCall = mocks.rpc.mock.calls.find(([name]) => name === "post_ledger_entry_v1")!;
    expect(JSON.stringify(entryCall[1])).not.toMatch(/telebirr|Sent by his wife|channel|note/);
  });

  it("a replay carrying the same channel and note is RECORDED once; a different channel or note is refused as exists", async () => {
    const { entries, attributions } = installFakeLedger();
    const same = envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer, channel: "cash", note: "Hand to hand" } });
    const [first] = await push(same);
    const [second] = await push(same);
    expect(first).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "RECORDED" } });
    expect(second).toMatchObject({ outcome: "REPLAYED", attribution: { outcome: "RECORDED" } });

    const [otherChannel] = await push(
      envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer, channel: "cbe", note: "Hand to hand" } })
    );
    const [otherNote] = await push(
      envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer, channel: "cash", note: "Another note" } })
    );
    expect(otherChannel).toMatchObject({ outcome: "REPLAYED", attribution: { outcome: "REFUSED", error: "attribution_exists" } });
    expect(otherNote).toMatchObject({ outcome: "REPLAYED", attribution: { outcome: "REFUSED", error: "attribution_exists" } });
    expect(entries.size).toBe(1);
    expect(attributions.size).toBe(1);
    expect([...attributions.values()][0]).toMatchObject({ channel: "cash", note: "Hand to hand" });
  });

  it("rejects a bad channel or note before anything is posted", async () => {
    installFakeLedger();
    const results = await push(
      envelope("bad-channel", { ...draft("k-1"), attribution: { memberUserId: payer, channel: "paypal" } }, "k-1"),
      envelope("blank-note", { ...draft("k-2"), attribution: { memberUserId: payer, note: "   " } }, "k-2"),
      envelope("long-note", { ...draft("k-3"), attribution: { memberUserId: payer, note: "z".repeat(281) } }, "k-3"),
      envelope("control", { ...draft("k-4"), attribution: { memberUserId: payer, note: "a\u0007b" } }, "k-4")
    );
    expect(results.map((result) => [result.outcome, result.error])).toEqual([
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"]
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps the entry ACCEPTED when the attribution is refused, and reports the database's reason", async () => {
    installFakeLedger({ attributionError: { code: "P0001", message: "attribution_bank_verified" } });
    const [result] = await push(envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer } }));

    expect(result).toMatchObject({
      mutationId: "m1",
      outcome: "ACCEPTED",
      serverEntryId: expect.any(String),
      attribution: { outcome: "REFUSED", error: "attribution_bank_verified" }
    });
  });

  it("reports a role refusal on the attribution as forbidden, not as a rejected entry", async () => {
    installFakeLedger({ attributionError: { code: "42501", message: "ledger_forbidden" } });
    const [result] = await push(envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer } }));
    expect(result).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "REFUSED", error: "forbidden" } });
  });

  it("reports an attribution write that blew up as a retryable refusal; the entry stays posted", async () => {
    installFakeLedger({ attributionError: { code: "XX000", message: "boom" } });
    const [result] = await push(envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer } }));
    expect(result).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "REFUSED", error: "attribution_failed" } });
  });

  it("does not double-record on a replay: REPLAYED with the same entry, one attribution, RECORDED", async () => {
    const { entries, attributions } = installFakeLedger();
    const mutation = envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer, cycleId: cycle, round: 2 } });
    const [first] = await push(mutation);
    const [second] = await push(mutation);

    expect(first).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "RECORDED" } });
    expect(second).toMatchObject({
      outcome: "REPLAYED",
      serverEntryId: first.serverEntryId,
      attribution: { outcome: "RECORDED" }
    });
    expect(entries.size).toBe(1);
    expect(attributions.size).toBe(1);
  });

  it("a replay whose payer differs from the recorded one is REPLAYED with a refused attribution, never a second record", async () => {
    const { attributions } = installFakeLedger();
    await push(envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer } }));
    const [replay] = await push(envelope("m1", { ...draft("k-1"), attribution: { memberUserId: otherPayer } }));

    expect(replay).toMatchObject({
      outcome: "REPLAYED",
      attribution: { outcome: "REFUSED", error: "attribution_exists" }
    });
    expect(attributions.size).toBe(1);
    expect([...attributions.values()][0].memberUserId).toBe(payer);
  });

  it("a replay of an entry whose first attribution never landed records it now", async () => {
    installFakeLedger({ attributionError: { code: "XX000", message: "boom" } });
    const mutation = envelope("m1", { ...draft("k-1"), attribution: { memberUserId: payer } });
    const [first] = await push(mutation);
    expect(first.attribution).toMatchObject({ outcome: "REFUSED" });

    const { attributions } = installFakeLedger();
    // Same ledger key: the fake above is replaced, so seed the entry first.
    await push(envelope("seed", draft("k-1")));
    const [again] = await push(mutation);
    expect(again).toMatchObject({ outcome: "REPLAYED", attribution: { outcome: "RECORDED" } });
    expect(attributions.size).toBe(1);
  });

  it("still accepts an old-shape draft: no attribution key, no attribution call, no attribution in the result", async () => {
    installFakeLedger();
    const [result] = await push(envelope("m1", draft("k-1")));

    expect(result).toEqual({
      mutationId: "m1",
      outcome: "ACCEPTED",
      serverEntryId: expect.any(String),
      serverEntryHash: expect.any(String),
      serverSequence: "1"
    });
    expect("attribution" in result).toBe(false);
    expect(attributionCalls()).toHaveLength(0);
  });

  it("rejects a malformed attribution, or one on a non-contribution, before anything is posted", async () => {
    installFakeLedger();
    const results = await push(
      envelope("bad-id", { ...draft("k-1"), attribution: { memberUserId: "not-a-uuid" } }, "k-1"),
      envelope("round-no-cycle", { ...draft("k-2"), attribution: { memberUserId: payer, round: 2 } }, "k-2"),
      envelope("extra", { ...draft("k-3"), attribution: { memberUserId: payer, role: "owner" } }, "k-3"),
      envelope(
        "journal",
        { ...draft("k-4", { entryType: "journal" }), attribution: { memberUserId: payer } },
        "k-4"
      )
    );

    expect(results.map((result) => [result.outcome, result.error])).toEqual([
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"],
      ["REJECTED", "invalid_request"]
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("settles a mixed batch per item: a refused payer on one draft does not touch the others", async () => {
    installFakeLedger();
    const results = await push(
      envelope("m1", draft("k-1"), "k-1"),
      envelope("m2", { ...draft("k-2"), attribution: { memberUserId: payer } }, "k-2"),
      envelope("m3", draft("k-3"), "k-3")
    );
    expect(results.map((result) => result.outcome)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED"]);
    expect(results.map((result) => "attribution" in result)).toEqual([false, true, false]);
  });
});

describe("HttpSyncTransport — the extended push result", () => {
  function transportReturning(results: unknown[]) {
    return new HttpSyncTransport({
      fetchImpl: vi.fn(async () => Response.json({ results })) as unknown as typeof fetch
    });
  }
  const accepted = (extra: Record<string, unknown> = {}) => ({
    mutationId: "m1",
    outcome: "ACCEPTED",
    serverEntryId: "entry-1",
    serverEntryHash: "a".repeat(64),
    serverSequence: "1",
    ...extra
  });
  const env = [envelope("m1", draft("k-1"))];

  it("parses RECORDED and REFUSED", async () => {
    const recorded = await transportReturning([accepted({ attribution: { outcome: "RECORDED" } })]).push("Bearer t", env);
    expect(recorded[0]).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "RECORDED" } });

    const refused = await transportReturning([
      accepted({ attribution: { outcome: "REFUSED", error: "attribution_exists" } })
    ]).push("Bearer t", env);
    expect(refused[0]).toMatchObject({ outcome: "ACCEPTED", attribution: { outcome: "REFUSED", error: "attribution_exists" } });
  });

  it("leaves a result with no attribution field (an old server) exactly as before", async () => {
    const [result] = await transportReturning([accepted()]).push("Bearer t", env);
    expect(result.outcome).toBe("ACCEPTED");
    expect("attribution" in result).toBe(false);
  });

  it("turns an unreadable attribution into a refusal with a reason, and never doubts the entry", async () => {
    for (const bad of [{ outcome: "MAYBE" }, "recorded", 7]) {
      const [result] = await transportReturning([accepted({ attribution: bad })]).push("Bearer t", env);
      expect(result).toMatchObject({
        outcome: "ACCEPTED",
        serverEntryId: "entry-1",
        attribution: { outcome: "REFUSED", error: "attribution_unreadable" }
      });
    }
    const [noReason] = await transportReturning([accepted({ attribution: { outcome: "REFUSED" } })]).push("Bearer t", env);
    expect(noReason.attribution).toEqual({ outcome: "REFUSED", error: "attribution_failed" });
  });

  it("still refuses an accepted result without an entry id and hash, attribution or not", async () => {
    await expect(
      transportReturning([{ mutationId: "m1", outcome: "ACCEPTED", attribution: { outcome: "RECORDED" } }]).push("Bearer t", env)
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });
});
