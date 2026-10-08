// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: serverMocks.getUser }, rpc: serverMocks.rpc }))
}));

import { createSenedDatabase, deleteSenedDatabase, resetSenedDatabase, type SenedDatabase } from "@/lib/db";
import { saveDraft, queueDraft } from "@/lib/db/drafts";
import { readDivergence, resolveDivergence } from "@/lib/db/meta";
import { storeMirrorEntries } from "@/lib/db/mirror";
import { saveSpokenNote } from "@/lib/db/notes";
import { listOutbox, requeueTerminal, settleTerminal } from "@/lib/db/outbox";
import { saveRosterMember } from "@/lib/db/roster";
import { OfflineSyncEngine } from "@/lib/offline/engine";
import {
  SyncError,
  type SyncPullQuery,
  type SyncPullResult,
  type SyncPushEnvelope,
  type SyncPushResult,
  type SyncTransport
} from "@/lib/offline/contract";
import { HttpSyncTransport, UnconfiguredSyncTransport } from "@/lib/offline/transport";
import { computeBackoffMs, parseRetryAfterMs } from "@/lib/offline/backoff";
import type { LedgerEntryLike } from "@/lib/offline/contract";
import { POST as syncRoute } from "@/app/api/sync/route";
import { buildLedgerEntry, type LedgerEntryRequest } from "@/lib/ledger";

const groupId = "22222222-2222-4222-8222-222222222222";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";
const actorId = "11111111-1111-4111-8111-111111111111";
const token = "Bearer test-token";

let db: SenedDatabase;
let dbName: string;
let clockAt: Date;

function entry(sequence: number, hash: string, previousHash: string, overrides: Partial<LedgerEntryLike> = {}): LedgerEntryLike {
  return {
    id: `entry-${sequence}-${hash.slice(0, 4)}`,
    groupId,
    sequence: String(sequence),
    occurredAt: "2026-09-20T09:00:00.000Z",
    recordedAt: "2026-09-20T09:00:01.000Z",
    entryHash: hash,
    previousHash,
    entryType: "contribution",
    actorId,
    nonce: `nonce-${sequence}`,
    correctsEntryId: null,
    rationale: null,
    postings: [
      { id: `p-${sequence}-a`, ordinal: 0, accountId: cashAccount, direction: "debit", amount: "500.00" },
      { id: `p-${sequence}-b`, ordinal: 1, accountId: incomeAccount, direction: "credit", amount: "500.00" }
    ],
    ...overrides
  };
}

function contributionRequest(idempotencyKey: string, amount = "500.00") {
  return {
    groupId,
    idempotencyKey,
    occurredAt: "2026-09-20T09:00:00.000Z",
    entryType: "contribution" as const,
    postings: [
      { accountId: cashAccount, direction: "debit" as const, amount },
      { accountId: incomeAccount, direction: "credit" as const, amount }
    ]
  };
}

interface TransportScriptOptions {
  push?: (authorization: string, envelopes: readonly SyncPushEnvelope[]) => Promise<readonly SyncPushResult[]>;
  pull?: (authorization: string, query: SyncPullQuery) => Promise<SyncPullResult>;
}

interface ScriptedTransport extends SyncTransport {
  readonly pushCalls: SyncPushEnvelope[][];
  readonly pullQueries: SyncPullQuery[];
}

function scriptedTransport(script: TransportScriptOptions): ScriptedTransport {
  const pushCalls: SyncPushEnvelope[][] = [];
  const pullQueries: SyncPullQuery[] = [];
  return {
    pushCalls,
    pullQueries,
    async push(authorization: string, envelopes: readonly SyncPushEnvelope[]) {
      pushCalls.push([...envelopes]);
      if (!script.push) {
        throw new SyncError("SYNC_NOT_CONFIGURED", "no push script");
      }
      return script.push(authorization, envelopes);
    },
    async pull(authorization: string, query: SyncPullQuery) {
      pullQueries.push(query);
      if (!script.pull) {
        throw new SyncError("SYNC_NOT_CONFIGURED", "no pull script");
      }
      return script.pull(authorization, query);
    }
  };
}

function acceptAll() {
  return async (_authorization: string, envelopes: readonly SyncPushEnvelope[]) =>
    envelopes.map((envelope, index) => ({
      mutationId: envelope.mutationId,
      outcome: "ACCEPTED" as const,
      serverEntryId: `server-entry-${index + 1}`,
      serverEntryHash: `${(index + 1).toString(16).repeat(2)}`.padEnd(64, "0"),
      serverSequence: String(index + 1)
    }));
}

function engine(transport?: SyncTransport, overrides: Partial<ConstructorParameters<typeof OfflineSyncEngine>[0]> = {}) {
  return new OfflineSyncEngine({
    db,
    transport: transport ?? new UnconfiguredSyncTransport(),
    clock: () => clockAt,
    random: () => 0.5,
    leaseOwner: "device-a",
    backoff: { baseMs: 1_000, maxMs: 60_000, random: () => 0.5 },
    ...overrides
  });
}

beforeEach(() => {
  dbName = `sened-test-sync-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
  clockAt = new Date("2026-09-20T09:00:00.000Z");
});

afterEach(async () => {
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
});

describe("outbox drain — a queued draft only becomes synced on a real acceptance", () => {
  it("settles a draft as synced only when the server returns an id and a hash", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-1"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });

    const transport = scriptedTransport({ push: acceptAll() });
    const report = await engine(transport).drain(token, { groupId });

    expect(report).toMatchObject({ attempted: 1, synced: 1, notConfigured: false });
    const settled = await db.outbox.get(outbox.id);
    expect(settled?.state).toBe("synced");
    expect(settled?.serverEntryId).toBe("server-entry-1");
    expect(settled?.serverEntryHash).toHaveLength(64);
    expect(settled?.settledAt).not.toBeNull();
    expect(settled?.leaseOwner).toBeNull();
  });

  it("leaves the draft visibly queued when the transport is not configured, and spends no attempt", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-2"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });

    const report = await engine().drain(token, { groupId });

    expect(report.notConfigured).toBe(true);
    expect(report.attempted).toBe(0);
    expect(report.synced).toBe(0);
    const row = await db.outbox.get(outbox.id);
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.lastErrorCode).toBe("SYNC_NOT_CONFIGURED");
    expect(row?.serverEntryId).toBeNull();
  });

  it("retries a transient network failure with backoff and honours Retry-After", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-3"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });

    const limited = scriptedTransport({
      push: async () => {
        throw new SyncError("SYNC_RATE_LIMITED", "slow down", { retryAfterMs: 45_000 });
      }
    });
    const report = await engine(limited).drain(token, { groupId });

    expect(report.retried).toBe(1);
    const row = await db.outbox.get(outbox.id);
    expect(row?.state).toBe("retry-scheduled");
    expect(row?.attempts).toBe(1);
    // The server's own wait wins over the computed curve.
    expect(row?.nextAttemptAt).toBe(clockAt.getTime() + 45_000);
  });

  it("does not retry before nextAttemptAt, then does", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-4"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async () => {
        throw new SyncError("SYNC_UNAVAILABLE", "server down");
      }
    });
    const sync = engine(transport);
    await sync.drain(token, { groupId });

    const tooSoon = await sync.drain(token, { groupId });
    expect(tooSoon.attempted).toBe(0);
    expect(transport.pushCalls).toHaveLength(1);

    clockAt = new Date(clockAt.getTime() + 60_000);
    const later = await sync.drain(token, { groupId });
    expect(later.attempted).toBe(1);
    expect(transport.pushCalls).toHaveLength(2);
  });

  it("blocks a mutation after the attempt budget instead of retrying forever", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-5"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async () => {
        throw new SyncError("SYNC_UNAVAILABLE", "server down");
      }
    });
    const sync = engine(transport, { maxAttempts: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sync.drain(token, { groupId });
      clockAt = new Date(clockAt.getTime() + 10 * 60_000);
    }
    const final = await sync.drain(token, { groupId });
    expect(final.blocked).toBe(1);

    const row = await db.outbox.get(outbox.id);
    expect(row?.state).toBe("blocked");
    expect(row?.lastErrorMessage).toContain("Gave up after 4 attempts");
    // The row is still on disk. Nothing is quietly deleted.
    expect(await listOutbox(db, { groupId })).toHaveLength(1);
  });

  it("blocks immediately on a credential problem instead of burning retries", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-6"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async () => {
        throw new SyncError("SYNC_UNAUTHENTICATED", "sign in again");
      }
    });

    const report = await engine(transport).drain(token, { groupId });
    expect(report.blocked).toBe(1);
    const row = await db.outbox.get(outbox.id);
    expect(row?.state).toBe("blocked");
    expect(row?.attempts).toBe(0);
    expect(row?.lastErrorCode).toBe("SYNC_UNAUTHENTICATED");
  });

  it("treats a server rejection as terminal and keeps the reason", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-7"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async (_authorization, envelopes) =>
        envelopes.map((envelope) => ({
          mutationId: envelope.mutationId,
          outcome: "REJECTED" as const,
          error: "unprocessable_ledger_entry"
        }))
    });

    const report = await engine(transport).drain(token, { groupId });
    expect(report.rejected).toBe(1);
    const row = await db.outbox.get(outbox.id);
    expect(row?.state).toBe("rejected");
    expect(row?.lastErrorCode).toBe("unprocessable_ledger_entry");
  });

  it("retries rather than settling when the server omits a result for a row", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-8"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({ push: async () => [] });

    const report = await engine(transport).drain(token, { groupId });
    expect(report.retried).toBe(1);
    expect(report.synced).toBe(0);
    expect((await db.outbox.get(outbox.id))?.state).toBe("retry-scheduled");
  });

  it("refuses to present an acceptance that carries no entry id or hash", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("sync-9"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async (_authorization, envelopes) =>
        envelopes.map((envelope) => ({ mutationId: envelope.mutationId, outcome: "ACCEPTED" as const }))
    });

    // `settleSynced` throws, so the lease is released by the caller; the row
    // must not have been marked synced.
    await expect(engine(transport).drain(token, { groupId })).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });
    expect((await db.outbox.get(outbox.id))?.state).not.toBe("synced");
  });

  it("drains a spoken note and a roster change through the same queue", async () => {
    const note = await saveSpokenNote(db, { groupId, transcript: "500 birr by telebirr" });
    const member = await saveRosterMember(db, { groupId, displayName: "Selam", updatedBy: actorId });
    const { enqueue } = await import("@/lib/db/outbox");
    await enqueue(db, { kind: "spoken-note", groupId, subjectId: note.id, payload: { transcript: note.transcript }, now: clockAt });
    await enqueue(db, { kind: "roster-member", groupId, subjectId: member.id, payload: { displayName: member.displayName }, now: clockAt });

    const transport = scriptedTransport({ push: acceptAll() });
    const report = await engine(transport).drain(token, { groupId });

    expect(report.synced).toBe(2);
    expect(transport.pushCalls[0]?.map((envelope) => envelope.kind).sort()).toEqual([
      "roster-member",
      "spoken-note"
    ]);
  });

  it("sends the same idempotency key on every retry, so a reload cannot double-post", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("stable"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({
      push: async () => {
        throw new SyncError("SYNC_UNAVAILABLE", "down");
      }
    });
    const sync = engine(transport);
    await sync.drain(token, { groupId });
    clockAt = new Date(clockAt.getTime() + 10 * 60_000);
    await sync.drain(token, { groupId });

    const keys = transport.pushCalls.map((call) => call[0]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(`sened-offline:ledger-draft:${groupId}:${draft.id}`);
    expect((await db.outbox.get(outbox.id))?.attempts).toBe(2);
  });

  it("never writes the bearer token to the device", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("secret"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });
    await engine(scriptedTransport({ push: acceptAll() })).drain(token, { groupId });

    const dump = JSON.stringify([
      ...(await db.outbox.toArray()),
      ...(await db.drafts.toArray()),
      ...(await db.roster.toArray()),
      ...(await db.spokenNotes.toArray()),
      ...(await db.ledgerMirror.toArray()),
      ...(await db.syncMeta.toArray())
    ]);
    expect(dump).not.toContain("test-token");
  });

  it("refuses to push while a fork is unresolved, and pushes again once a person decides", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("forked"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({ push: acceptAll() });
    const sync = engine(transport);

    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), "0".repeat(64))]
    });
    const service = await import("@/lib/db/meta");
    await service.recordDivergence(db, {
      kind: "hash-mismatch",
      detectedAt: clockAt.toISOString(),
      groupId,
      commonPrefixLength: 0,
      forkSequence: "1",
      localLastSequence: "1",
      serverLastSequence: "1",
      localLastHash: "a".repeat(64),
      serverLastHash: "b".repeat(64),
      detail: "the group recorded two different contributions for the same slot",
      resolution: null,
      resolvedAt: null
    });

    const blocked = await sync.drain(token, { groupId });
    expect(blocked.attempted).toBe(0);
    expect(blocked.skippedReason).toContain("unresolved ledger fork");
    expect(transport.pushCalls).toHaveLength(0);

    await resolveDivergence(db, groupId, "escalate-to-review", clockAt);
    const allowed = await sync.drain(token, { groupId });
    expect(allowed.attempted).toBe(1);
    expect(allowed.synced).toBe(1);
  });

  it("re-arms a fork that recurs after a person already resolved it", async () => {
    // Regression guard. recordDivergence deduped on forkSequence + kind without
    // checking `resolution`, so the same fork recurring after a human had
    // accepted the server returned the RESOLVED record. blocksPush then went
    // back to false and pushes resumed onto a contested head, with no banner
    // left to explain why. That is a fail-open on the one guard the whole
    // append-only design rests on.
    const draft = await saveDraft(db, { request: contributionRequest("refork"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });
    const transport = scriptedTransport({ push: acceptAll() });
    const sync = engine(transport);

    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), "0".repeat(64))]
    });

    const fork = {
      kind: "hash-mismatch" as const,
      detectedAt: clockAt.toISOString(),
      groupId,
      commonPrefixLength: 0,
      forkSequence: "1",
      localLastSequence: "1",
      serverLastSequence: "1",
      localLastHash: "a".repeat(64),
      serverLastHash: "b".repeat(64),
      detail: "the group recorded two different contributions for the same slot"
    };

    const service = await import("@/lib/db/meta");
    await service.recordDivergence(db, { ...fork, resolution: null, resolvedAt: null });
    await resolveDivergence(db, groupId, "accept-server-as-truth", clockAt);

    // A person has decided, so pushing is permitted.
    expect((await sync.drain(token, { groupId })).attempted).toBe(1);

    // The same disagreement shows up again. It must return as UNRESOLVED.
    const rearmed = await service.recordDivergence(db, {
      ...fork,
      detectedAt: new Date(clockAt.getTime() + 60_000).toISOString(),
      resolution: null,
      resolvedAt: null
    });

    expect(rearmed.divergence?.resolution).toBeNull();
    expect(rearmed.divergence?.resolvedAt).toBeNull();

    // And pushing must be refused again, rather than quietly resuming.
    await queueDraft(db, draft.id, { now: clockAt });
    const blocked = await sync.drain(token, { groupId });
    expect(blocked.attempted).toBe(0);
    expect(transport.pushCalls).toHaveLength(1);
  });

  it("lets a person requeue a settled mutation with a written reason", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("requeue"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    await settleTerminal(db, outbox.id, {
      now: clockAt,
      state: "blocked",
      errorCode: "SYNC_UNAVAILABLE",
      errorMessage: "gave up"
    });

    await expect(requeueTerminal(db, outbox.id, { now: clockAt, reason: "  " })).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });

    const requeued = await requeueTerminal(db, outbox.id, {
      now: clockAt,
      reason: "Checked with the group; the amount was right after all."
    });
    expect(requeued.state).toBe("queued");
    expect(requeued.attempts).toBe(0);
    expect(requeued.serverEntryId).toBeNull();
  });

  it("refuses to requeue something that is still in flight", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("in-flight"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id, { now: clockAt });
    await expect(
      requeueTerminal(db, outbox.id, { now: clockAt, reason: "because" })
    ).rejects.toMatchObject({ code: "SYNC_PROTECTED_ROW" });
  });
});

describe("pull and divergence detection", () => {
  const zero = "0".repeat(64);

  it("reports nothing to do when the transport is not configured", async () => {
    const report = await engine().pull(token, { groupId });
    expect(report).toMatchObject({ notConfigured: true, fetched: 0, stored: 0, divergence: null });
  });

  it("mirrors the whole chain on a first sync and calls it identical", async () => {
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "2", lastHash: "b".repeat(64) },
        entries: [entry(1, "a".repeat(64), zero), entry(2, "b".repeat(64), "a".repeat(64))],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report).toMatchObject({ fetched: 2, stored: 2, relation: "identical", notConfigured: false });
    expect(report.divergence).toBeNull();
  });

  it("calls an ordinary fast-forward 'server-ahead', not a conflict", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero)]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "2", lastHash: "b".repeat(64) },
        entries: [entry(2, "b".repeat(64), "a".repeat(64))],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("server-ahead");
    expect(report.divergence).toBeNull();
    expect(await readDivergence(db, groupId)).toBeNull();
  });

  it("DETECTS a fork when the server rewrites a sequence this device already holds", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero), entry(2, "b".repeat(64), "a".repeat(64))]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "2", lastHash: "f".repeat(64) },
        // Same sequence, brand new id, different hash: a rewritten history.
        entries: [entry(1, "f".repeat(64), zero, { id: "rewritten-1" })],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("diverged");
    expect(report.divergence).toMatchObject({
      kind: "hash-mismatch",
      forkSequence: "1",
      localLastHash: "a".repeat(64),
      serverLastHash: "f".repeat(64),
      resolution: null
    });
    // The local copy is intact. Nothing was overwritten.
    const chain = await db.ledgerMirror.toArray();
    expect(chain).toHaveLength(2);
    expect(chain.find((row) => row.sequence === "1")?.entryHash).toBe("a".repeat(64));
  });

  it("DETECTS a fork when the server is at the same height with a different head", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero), entry(2, "b".repeat(64), "a".repeat(64))]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "2", lastHash: "d".repeat(64) },
        entries: [],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("diverged");
    expect(report.divergence?.forkSequence).toBe("2");
    expect(report.divergence?.detail).toContain("hash differently");
  });

  it("DETECTS a fork when new server entries do not link onto our head", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero)]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "2", lastHash: "b".repeat(64) },
        // Links to something we have never seen.
        entries: [entry(2, "b".repeat(64), "9".repeat(64))],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("diverged");
    expect(report.divergence?.kind).toBe("height-mismatch");
    expect(report.divergence?.detail).toContain("It was not stored");
    // The mirror was not extended with an entry that does not belong to it.
    expect(await db.ledgerMirror.count()).toBe(1);
  });

  it("DETECTS a fork when the server is behind an append-only chain", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero), entry(2, "b".repeat(64), "a".repeat(64))]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "1", lastHash: "a".repeat(64) },
        entries: [],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("diverged");
    expect(report.divergence?.kind).toBe("height-mismatch");
    expect(report.divergence?.detail).toContain("behind a chain");
  });

  it("refuses to call an unverifiable gap 'no change'", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero)]
    });
    const transport = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "5", lastHash: "e".repeat(64) },
        entries: [],
        hasMore: false
      })
    });

    const report = await engine(transport).pull(token, { groupId });
    expect(report.relation).toBe("diverged");
    expect(report.divergence?.detail).toContain("cannot be checked");
  });

  it("pages through a long chain before judging it", async () => {
    const all = [
      entry(1, "a".repeat(64), zero),
      entry(2, "b".repeat(64), "a".repeat(64)),
      entry(3, "c".repeat(64), "b".repeat(64))
    ];
    const transport = scriptedTransport({
      pull: async (_authorization, query) => {
        const start = Number(query.sinceSequence) + 1;
        const page = all.filter((item) => Number(item.sequence) >= start).slice(0, 1);
        return {
          groupId,
          head: { groupId, tenantId: actorId, lastSequence: "3", lastHash: "c".repeat(64) },
          entries: page,
          hasMore: Number(all[all.length - 1]?.sequence) > Number(page[page.length - 1]?.sequence ?? 0)
        };
      }
    });

    const report = await engine(transport).pull(token, { groupId, limit: 1 });
    expect(report.fetched).toBe(3);
    expect(transport.pullQueries.map((query) => query.sinceSequence)).toEqual(["0", "1", "2"]);
    expect(report.relation).toBe("identical");
  });

  it("refuses a page that answers about a different group", async () => {
    const transport = scriptedTransport({
      pull: async () => ({
        groupId: "99999999-9999-4999-8999-999999999999",
        head: { groupId: "99999999-9999-4999-8999-999999999999", tenantId: actorId, lastSequence: "0", lastHash: zero },
        entries: [],
        hasMore: false
      })
    });
    await expect(engine(transport).pull(token, { groupId })).rejects.toBeInstanceOf(SyncError);
  });

  it("keeps a recorded fork across a later clean sync and only closes it on a human decision", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: clockAt,
      entries: [entry(1, "a".repeat(64), zero)]
    });
    const forked = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "1", lastHash: "d".repeat(64) },
        entries: [],
        hasMore: false
      })
    });
    await engine(forked).pull(token, { groupId });
    expect(await readDivergence(db, groupId)).not.toBeNull();

    // A later pull that agrees again does not silently erase the record.
    const clean = scriptedTransport({
      pull: async () => ({
        groupId,
        head: { groupId, tenantId: actorId, lastSequence: "1", lastHash: "a".repeat(64) },
        entries: [],
        hasMore: false
      })
    });
    const later = await engine(clean).pull(token, { groupId });
    expect(later.divergence).toBeNull();
    const still = await readDivergence(db, groupId);
    expect(still).not.toBeNull();
    expect(still?.resolution).toBeNull();

    const resolved = await resolveDivergence(db, groupId, "escalate-to-review", clockAt, {
      note: "Asked the group on Sunday."
    });
    expect(resolved.divergence?.resolution).toBe("escalate-to-review");
    expect(resolved.divergence?.detail).toContain("Asked the group on Sunday.");
    // Resolution is bookkeeping. No mirror row was touched.
    expect(await db.ledgerMirror.count()).toBe(1);
  });
});

describe("backoff", () => {
  it("grows exponentially, stays inside the ceiling, and is jittered", () => {
    const floorOf = (attempt: number) =>
      computeBackoffMs(attempt, { baseMs: 1_000, maxMs: 60_000, random: () => 0 });
    // Window is [ceiling/4, ceiling].
    expect(floorOf(1)).toBe(250);
    expect(floorOf(2)).toBe(500);
    expect(floorOf(3)).toBe(1_000);
    expect(floorOf(5)).toBe(4_000);
    expect(floorOf(20)).toBe(15_000);
    expect(computeBackoffMs(1, { baseMs: 1_000, maxMs: 60_000, random: () => 1 })).toBe(1_000);
    expect(computeBackoffMs(5, { baseMs: 1_000, maxMs: 60_000, random: () => 1 })).toBe(16_000);
  });

  it("never returns a zero delay, so a failing server is not hammered", () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(
        computeBackoffMs(attempt, { baseMs: 1_000, maxMs: 60_000, random: () => 0 })
      ).toBeGreaterThan(0);
    }
  });

  it("stays finite for an absurd attempt count", () => {
    expect(Number.isFinite(computeBackoffMs(9_999, { baseMs: 1_000, maxMs: 60_000 }))).toBe(true);
  });

  it("reads Retry-After in both RFC 9110 forms", () => {
    const now = Date.parse("2026-09-20T09:00:00.000Z");
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs("Sun, 20 Sep 2026 09:00:20 GMT", now)).toBe(20_000);
    expect(parseRetryAfterMs("Sun, 20 Sep 2026 08:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("not-a-date", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("99999", now)).toBe(300_000);
  });
});

describe("HttpSyncTransport", () => {
  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
  }

  it("calls fetch as a plain function, not as a method of the transport (a browser's fetch throws Illegal invocation otherwise)", async () => {
    // A real browser's window.fetch throws when it is called with any `this` but the window.
    // Test doubles never do, which is how the transport once shipped calling `this.fetchImpl(...)`
    // and could not send a single request outside the tests.
    const browserLikeFetch = function (this: unknown): Promise<Response> {
      return Promise.resolve(jsonResponse({ results: [] }));
    } as unknown as typeof fetch;
    const viaDefault = vi.fn(browserLikeFetch);
    vi.stubGlobal("fetch", function (this: unknown, ...args: unknown[]) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError("Illegal invocation"));
      }
      return viaDefault(...(args as Parameters<typeof fetch>));
    });
    const defaultTransport = new HttpSyncTransport();
    await expect(
      defaultTransport.pull(token, { groupId, sinceSequence: "0", limit: 10 })
    ).rejects.not.toMatchObject({ code: "SYNC_NETWORK" });
  });

  it("maps a 404 to SYNC_NOT_CONFIGURED, because a missing route is not an outage", async () => {
    const transport = new HttpSyncTransport({
      fetchImpl: async () => new Response("not found", { status: 404 })
    });
    await expect(transport.pull(token, { groupId, sinceSequence: "0", limit: 10 })).rejects.toMatchObject({
      code: "SYNC_NOT_CONFIGURED"
    });
  });

  it("sends the bearer token and the JSON body it was given", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const transport = new HttpSyncTransport({
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenInit = init;
        return jsonResponse({
          results: [{ mutationId: "m1", outcome: "ACCEPTED", serverEntryId: "e1", serverEntryHash: "f".repeat(64) }]
        });
      }
    });

    const results = await transport.push(token, [
      {
        mutationId: "m1",
        idempotencyKey: "key-1",
        kind: "ledger-draft",
        groupId,
        payload: { a: 1 },
        clientRecordedAt: "2026-09-20T09:00:00.000Z"
      }
    ]);

    expect(seenUrl).toBe("/api/sync");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe(token);
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      mutations: [
        {
          mutationId: "m1",
          idempotencyKey: "key-1",
          kind: "ledger-draft",
          groupId,
          payload: { a: 1 },
          clientRecordedAt: "2026-09-20T09:00:00.000Z"
        }
      ]
    });
    expect(results[0]?.serverEntryId).toBe("e1");
  });

  it("refuses to send anything without a bearer token", async () => {
    const transport = new HttpSyncTransport({ fetchImpl: async () => jsonResponse({ results: [] }) });
    await expect(transport.push("", [])).rejects.toMatchObject({ code: "SYNC_UNAUTHENTICATED" });
  });

  it("rejects an acceptance that arrives without an id and hash", async () => {
    const transport = new HttpSyncTransport({
      fetchImpl: async () => jsonResponse({ results: [{ mutationId: "m1", outcome: "ACCEPTED" }] })
    });
    await expect(
      transport.push(token, [
        {
          mutationId: "m1",
          idempotencyKey: "key-1",
          kind: "ledger-draft",
          groupId,
          payload: {},
          clientRecordedAt: "2026-09-20T09:00:00.000Z"
        }
      ])
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });

  it("rejects a result for a mutation it never sent", async () => {
    const transport = new HttpSyncTransport({
      fetchImpl: async () => jsonResponse({ results: [{ mutationId: "someone-elses", outcome: "REJECTED" }] })
    });
    await expect(
      transport.push(token, [
        {
          mutationId: "m1",
          idempotencyKey: "key-1",
          kind: "ledger-draft",
          groupId,
          payload: {},
          clientRecordedAt: "2026-09-20T09:00:00.000Z"
        }
      ])
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });

  it("maps the status codes a Wave 2 route will actually return", async () => {
    const cases: readonly [number, string, string | null][] = [
      [401, "SYNC_UNAUTHENTICATED", null],
      [403, "SYNC_FORBIDDEN", null],
      [409, "SYNC_IDEMPOTENCY_CONFLICT", null],
      [422, "SYNC_REJECTED", null],
      [429, "SYNC_RATE_LIMITED", "12"],
      [503, "SYNC_UNAVAILABLE", null]
    ];
    for (const [status, code, retryAfter] of cases) {
      const transport = new HttpSyncTransport({
        fetchImpl: async () =>
          new Response("{}", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} })
      });
      await expect(transport.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
        code,
        ...(retryAfter ? { retryAfterMs: 12_000 } : {})
      });
    }
  });

  it("reports a timeout as SYNC_TIMEOUT rather than a generic network fault", async () => {
    const transport = new HttpSyncTransport({
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    });
    await expect(transport.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
      code: "SYNC_TIMEOUT"
    });
  });

  it("reports an unreachable service as SYNC_NETWORK", async () => {
    const transport = new HttpSyncTransport({
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      }
    });
    await expect(transport.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
      code: "SYNC_NETWORK"
    });
  });

  it("rejects a 200 that is not JSON, and a pull about the wrong group", async () => {
    const notJson = new HttpSyncTransport({ fetchImpl: async () => new Response("<html>nope</html>", { status: 200 }) });
    await expect(notJson.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });

    const wrongGroup = new HttpSyncTransport({
      fetchImpl: async () =>
        jsonResponse({
          head: { groupId: "other", tenantId: actorId, lastSequence: "0", lastHash: "0".repeat(64) },
          entries: [],
          hasMore: false
        })
    });
    await expect(wrongGroup.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });
  });

  it("refuses to send a batch larger than it agreed to", async () => {
    const transport = new HttpSyncTransport({
      maxBatchSize: 1,
      fetchImpl: async () => jsonResponse({ results: [] })
    });
    const envelope = (n: number) => ({
      mutationId: `m${n}`,
      idempotencyKey: `k${n}`,
      kind: "ledger-draft" as const,
      groupId,
      payload: {},
      clientRecordedAt: "2026-09-20T09:00:00.000Z"
    });
    await expect(transport.push(token, [envelope(1), envelope(2)])).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });
  });

  it("defaults to the unconfigured transport's fail-closed behaviour", async () => {
    const transport = new UnconfiguredSyncTransport();
    await expect(transport.push(token, [])).rejects.toMatchObject({ code: "SYNC_NOT_CONFIGURED" });
    await expect(transport.pull(token, { groupId, sinceSequence: "0", limit: 1 })).rejects.toMatchObject({
      code: "SYNC_NOT_CONFIGURED"
    });
  });
});

describe("the offline engine against the real /api/sync handler", () => {
  const tenantId = "99999999-9999-4999-8999-999999999999";

  function fakeLedger() {
    const store = new Map<string, ReturnType<typeof buildLedgerEntry>>();
    serverMocks.rpc.mockReset().mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const key = args.requested_idempotency_key as string;
      const existing = store.get(key);
      if (existing) {
        return { data: { entry: existing, replayed: true }, error: null };
      }
      const sequence = String(store.size + 1);
      const request: LedgerEntryRequest = {
        groupId: args.requested_group_id as string,
        idempotencyKey: key,
        occurredAt: args.requested_occurred_at as string,
        entryType: args.requested_entry_type as LedgerEntryRequest["entryType"],
        postings: args.requested_postings as LedgerEntryRequest["postings"]
      };
      const built = buildLedgerEntry({
        request,
        actorId,
        tenantId,
        entryId: `5555555${sequence}-5555-4555-8555-555555555555`,
        nonce: `6666666${sequence}-6666-4666-8666-666666666666`,
        sequence,
        previousHash: "0".repeat(64),
        recordedAt: "2026-09-20T09:00:01.000Z",
        postingIds: [`aaaaaaa${sequence}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, `bbbbbbb${sequence}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`]
      });
      store.set(key, built);
      return { data: { entry: built, replayed: false }, error: null };
    });
    return store;
  }

  function realTransport() {
    const fetchImpl = (async (url: string, init: RequestInit) =>
      syncRoute(new Request(`http://localhost${url}`, init))) as unknown as typeof fetch;
    return new HttpSyncTransport({ fetchImpl });
  }

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    serverMocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: actorId } }, error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("settles a queued draft synced from the server's own entry id and hash", async () => {
    const store = fakeLedger();
    const draft = await saveDraft(db, { request: contributionRequest("local-label-1"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });

    const report = await engine(realTransport()).drain(token, { groupId });

    expect(report).toMatchObject({ attempted: 1, synced: 1, rejected: 0, blocked: 0 });
    const row = (await db.outbox.toArray())[0]!;
    expect(row.state).toBe("synced");
    expect(row.serverEntryId).toBe([...store.values()][0]!.id);
    expect(row.serverEntryHash).toBe([...store.values()][0]!.entryHash);
    // The ledger saw the outbox's derived key, not the draft's local label.
    expect(serverMocks.rpc.mock.calls[0]![1].requested_idempotency_key).toBe(row.idempotencyKey);
  });

  it("never duplicates an entry when the response is lost and the drain is retried", async () => {
    const store = fakeLedger();
    const draft = await saveDraft(db, { request: contributionRequest("local-label-2"), updatedBy: actorId });
    await queueDraft(db, draft.id, { now: clockAt });

    const real = realTransport();
    const lossy: SyncTransport = {
      async push(authorization, envelopes) {
        await real.push(authorization, envelopes); // the server accepted...
        throw new SyncError("SYNC_NETWORK", "response lost"); // ...but the device never heard
      },
      pull: (authorization, query) => real.pull(authorization, query)
    };
    const first = await engine(lossy).drain(token, { groupId });
    expect(first.retried).toBe(1);
    expect(store.size).toBe(1);

    clockAt = new Date(clockAt.getTime() + 10 * 60_000);
    const second = await engine(real).drain(token, { groupId });

    expect(second.synced).toBe(1);
    expect(store.size).toBe(1);
    const row = (await db.outbox.toArray())[0]!;
    expect(row.state).toBe("synced");
    expect(row.serverEntryId).toBe([...store.values()][0]!.id);
  });

  it("settles a refused draft as rejected without touching its neighbour", async () => {
    fakeLedger();
    const good = await saveDraft(db, { request: contributionRequest("local-label-3"), updatedBy: actorId });
    await queueDraft(db, good.id, { now: clockAt });
    const bad = await saveDraft(db, { request: contributionRequest("local-label-4", "10.00"), updatedBy: actorId });
    await queueDraft(db, bad.id, { now: clockAt });
    serverMocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "42501", message: "ledger_forbidden" } }));

    const report = await engine(realTransport()).drain(token, { groupId });

    expect(report).toMatchObject({ attempted: 2, synced: 1, rejected: 1 });
    const states = (await db.outbox.toArray()).map((row) => row.state).sort();
    expect(states).toEqual(["rejected", "synced"]);
  });
});
