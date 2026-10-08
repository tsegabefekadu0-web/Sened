import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSenedDatabase, DATABASE_SCHEMA_VERSION, type SenedDatabase } from "@/lib/db/schema";
import { deleteSenedDatabase, resetSenedDatabase } from "@/lib/db/database";
import { getDraft, queueDraft, saveDraft } from "@/lib/db/drafts";
import { attributionFromPayload, normalizeDraftAttribution } from "@/lib/db/attribution";
import { getOutboxRow, recordAttributionOutcome, requeueTerminal } from "@/lib/db/outbox";
import { OfflineSyncEngine } from "@/lib/offline/engine";
import { retryDraftAttribution, attributionRefusalCode } from "@/lib/offline/attributionRetry";
import { SyncError, type SyncPushResult, type SyncTransport } from "@/lib/offline/contract";

const groupId = "22222222-2222-4222-8222-222222222222";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";
const actorId = "11111111-1111-4111-8111-111111111111";
const payer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cycle = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let db: SenedDatabase;
let dbName: string;

function contribution(key: string, entryType: "contribution" | "journal" = "contribution") {
  return {
    groupId,
    idempotencyKey: key,
    occurredAt: "2026-09-20T09:00:00.000Z",
    entryType,
    postings: [
      { accountId: cashAccount, direction: "debit" as const, amount: "500.00" },
      { accountId: incomeAccount, direction: "credit" as const, amount: "500.00" }
    ]
  };
}

beforeEach(() => {
  dbName = `sened-test-attr-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
});

afterEach(async () => {
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
  vi.unstubAllGlobals();
});

describe("Dexie upgrade to schema version 3 (payer in v2, channel/note and retry bookkeeping in v3)", () => {
  const V1_STORES = {
    roster: "id, groupId, [groupId+displayName], updatedAt",
    spokenNotes: "id, groupId, memberId, [groupId+occurredAt], createdAt",
    drafts: "id, groupId, [groupId+status], idempotencyKey, updatedAt",
    outbox: "id, [state+nextAttemptAt], [groupId+state], kind, createdAt, idempotencyKey",
    ledgerMirror: "id, groupId, [groupId+sequenceNumber], [groupId+entryHash]",
    syncMeta: "key, groupId"
  };

  it("is version 3", () => {
    expect(DATABASE_SCHEMA_VERSION).toBe(3);
    expect(db.verno).toBe(3);
  });

  it("keeps a draft and an outbox row written under version 1 valid, with no payer", async () => {
    const name = `sened-test-v1-${Math.random().toString(36).slice(2, 10)}`;
    const request = contribution("old-key");
    const old = new Dexie(name);
    old.version(1).stores(V1_STORES);
    await old.table("drafts").put({
      id: "draft-old",
      groupId,
      request,
      status: "queued",
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      updatedBy: actorId,
      outboxId: "outbox-old"
    });
    await old.table("drafts").put({
      id: "draft-unqueued",
      groupId,
      request: contribution("old-key-2"),
      status: "draft",
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      updatedBy: actorId,
      outboxId: null
    });
    await old.table("outbox").put({
      id: "outbox-old",
      kind: "ledger-draft",
      groupId,
      subjectId: "draft-old",
      idempotencyKey: "sened-offline:ledger-draft:old",
      state: "queued",
      attempts: 0,
      payload: request,
      nextAttemptAt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      serverEntryId: null,
      serverEntryHash: null,
      serverSequence: null,
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      settledAt: null
    });
    old.close();

    const upgraded = createSenedDatabase(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(3);
      const draft = await getDraft(upgraded, "draft-old");
      expect(draft).toMatchObject({ id: "draft-old", status: "queued", request, attribution: null });
      expect(await upgraded.outbox.get("outbox-old")).toMatchObject({
        state: "queued",
        payload: request,
        attributionOutcome: null,
        attributionError: null
      });
      // Still queueable as before: an unqueued old draft goes out as a plain entry.
      const queued = await queueDraft(upgraded, "draft-unqueued");
      expect(queued.outbox.payload).toEqual(contribution("old-key-2"));
      expect("attribution" in (queued.outbox.payload as object)).toBe(false);
    } finally {
      upgraded.close();
      await deleteSenedDatabase(name);
    }
  });

  it("treats a row that never had the fields (a stale in-memory shape) as having no payer", async () => {
    const row = {
      id: "d1",
      groupId,
      request: contribution("k"),
      status: "draft" as const,
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      updatedBy: actorId,
      outboxId: null
    };
    await db.drafts.put(row);
    const queued = await queueDraft(db, "d1");
    expect(queued.outbox.payload).toEqual(row.request);
    expect(attributionFromPayload(queued.outbox.payload)).toBeNull();
  });
});

describe("a draft that carries a payer", () => {
  it("saves it normalised and puts it in the outbox payload beside the request", async () => {
    const draft = await saveDraft(db, {
      request: contribution("k-1"),
      attribution: { memberUserId: payer.toUpperCase(), cycleId: cycle, round: 4 },
      updatedBy: actorId
    });
    expect(draft.attribution).toEqual({ memberUserId: payer, cycleId: cycle, round: 4 });
    expect(draft.request).not.toHaveProperty("attribution");

    const { outbox } = await queueDraft(db, draft.id);
    expect(outbox.payload).toEqual({ ...draft.request, attribution: { memberUserId: payer, cycleId: cycle, round: 4 } });
    expect(attributionFromPayload(outbox.payload)).toEqual({ memberUserId: payer, cycleId: cycle, round: 4 });
    expect(outbox.attributionOutcome).toBeNull();
  });

  it("a draft with no payer queues the bare request, as it always did", async () => {
    const draft = await saveDraft(db, { request: contribution("k-2"), updatedBy: actorId });
    expect(draft.attribution).toBeNull();
    const { outbox } = await queueDraft(db, draft.id);
    expect(outbox.payload).toEqual(draft.request);
  });

  it.each([
    ["a non-uuid member", { memberUserId: "nope" }],
    ["a non-uuid cycle", { memberUserId: payer, cycleId: "nope" }],
    ["a round with no cycle", { memberUserId: payer, round: 2 }],
    ["round 0", { memberUserId: payer, cycleId: cycle, round: 0 }],
    ["round 1001", { memberUserId: payer, cycleId: cycle, round: 1001 }],
    ["a fractional round", { memberUserId: payer, cycleId: cycle, round: 1.5 }],
    ["an unknown field", { memberUserId: payer, role: "owner" }],
    ["a non-object", "payer"]
  ])("refuses %s before it touches the device", async (_label, attribution) => {
    await expect(saveDraft(db, { request: contribution("k-3"), attribution, updatedBy: actorId })).rejects.toMatchObject({
      code: "INVALID_DRAFT"
    });
    expect(await db.drafts.count()).toBe(0);
  });

  it("refuses a payer on anything but a contribution", async () => {
    await expect(
      saveDraft(db, {
        request: contribution("k-4", "journal"),
        attribution: { memberUserId: payer },
        updatedBy: actorId
      })
    ).rejects.toBeInstanceOf(SyncError);
  });

  it("normalizeDraftAttribution treats null and undefined as no payer", () => {
    expect(normalizeDraftAttribution(undefined)).toBeNull();
    expect(normalizeDraftAttribution(null)).toBeNull();
  });
});

describe("the engine settles from the extended result", () => {
  function transport(result: (id: string) => Omit<SyncPushResult, "mutationId">): SyncTransport {
    return {
      async push(_authorization, envelopes) {
        return envelopes.map((envelope) => ({ mutationId: envelope.mutationId, ...result(envelope.mutationId) }));
      },
      async pull() {
        throw new SyncError("SYNC_NOT_CONFIGURED", "no pull");
      }
    };
  }
  const accepted = (extra: Partial<SyncPushResult> = {}) => ({
    outcome: "ACCEPTED" as const,
    serverEntryId: "server-entry-1",
    serverEntryHash: "a".repeat(64),
    serverSequence: "1",
    ...extra
  });

  async function queued(key: string, attribution?: object) {
    const draft = await saveDraft(db, { request: contribution(key), attribution, updatedBy: actorId });
    return (await queueDraft(db, draft.id)).outbox;
  }

  it.each([
    ["RECORDED", { outcome: "RECORDED" as const }, null],
    ["REFUSED", { outcome: "REFUSED" as const, error: "attribution_bank_verified" }, "attribution_bank_verified"]
  ])("stores a %s attribution beside a synced entry, which is synced either way", async (outcome, attribution, error) => {
    const row = await queued(`k-${outcome}`, { memberUserId: payer });
    const engine = new OfflineSyncEngine({ db, transport: transport(() => accepted({ attribution })) });
    const report = await engine.drain("Bearer t");

    expect(report.synced).toBe(1);
    expect(report.rejected).toBe(0);
    expect(await getOutboxRow(db, row.id)).toMatchObject({
      state: "synced",
      serverEntryId: "server-entry-1",
      attributionOutcome: outcome,
      attributionError: error
    });
  });

  it("stores no attribution result for a plain entry, and for a REPLAYED one carries the result through", async () => {
    const plain = await queued("k-plain");
    const withPayer = await queued("k-payer", { memberUserId: payer });
    const engine = new OfflineSyncEngine({
      db,
      transport: transport((id) =>
        id === withPayer.id
          ? accepted({ outcome: "REPLAYED", attribution: { outcome: "RECORDED" } })
          : accepted({ serverEntryId: "server-entry-2" })
      )
    });
    await engine.drain("Bearer t");
    expect(await getOutboxRow(db, plain.id)).toMatchObject({ state: "synced", attributionOutcome: null, attributionError: null });
    expect(await getOutboxRow(db, withPayer.id)).toMatchObject({ state: "synced", attributionOutcome: "RECORDED" });
  });

  it("a rejected entry carries no attribution result", async () => {
    const row = await queued("k-rej", { memberUserId: payer });
    const engine = new OfflineSyncEngine({
      db,
      transport: transport(() => ({ outcome: "REJECTED", error: "unprocessable_ledger_entry" }))
    });
    await engine.drain("Bearer t");
    expect(await getOutboxRow(db, row.id)).toMatchObject({ state: "rejected", attributionOutcome: null });
  });

  it("requeueing a settled row forgets its attribution result along with its server ids", async () => {
    const row = await queued("k-requeue", { memberUserId: payer });
    const engine = new OfflineSyncEngine({
      db,
      transport: transport(() => accepted({ attribution: { outcome: "REFUSED", error: "attribution_exists" } }))
    });
    await engine.drain("Bearer t");
    const requeued = await requeueTerminal(db, row.id, { now: new Date(), reason: "test" });
    expect(requeued).toMatchObject({ state: "queued", attributionOutcome: null, attributionError: null });
  });
});

describe("retrying a refused attribution", () => {
  async function syncedWithRefusal(attribution?: object) {
    const draft = await saveDraft(db, { request: contribution("k-retry"), attribution, updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id);
    const engine = new OfflineSyncEngine({
      db,
      transport: {
        async push(_a, envelopes) {
          return envelopes.map((envelope) => ({
            mutationId: envelope.mutationId,
            outcome: "ACCEPTED" as const,
            serverEntryId: "77777777-7777-4777-8777-777777777777",
            serverEntryHash: "b".repeat(64),
            serverSequence: "1",
            ...(attribution ? { attribution: { outcome: "REFUSED" as const, error: "attribution_failed" } } : {})
          }));
        },
        async pull() {
          throw new SyncError("SYNC_NOT_CONFIGURED", "no pull");
        }
      }
    });
    await engine.drain("Bearer t");
    return outbox.id;
  }

  const deps = (fetchImpl: typeof fetch) => ({ getToken: async () => "tok", fetchImpl });

  it("sends only the attribution, against the server's entry id, and records the outcome", async () => {
    const id = await syncedWithRefusal({ memberUserId: payer, cycleId: cycle, round: 2 });
    const fetchImpl = vi.fn(async () => Response.json({ attribution: { revision: 1 }, replayed: false }, { status: 201 }));
    const result = await retryDraftAttribution(db, id, { deps: deps(fetchImpl as never) });

    expect(result).toEqual({ status: "recorded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ledger/attributions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      groupId,
      entryId: "77777777-7777-4777-8777-777777777777",
      memberUserId: payer,
      cycleId: cycle,
      round: 2
    });
    expect(await getOutboxRow(db, id)).toMatchObject({ state: "synced", attributionOutcome: "RECORDED", attributionError: null });
  });

  it("a refusal is stored with its reason and the entry stays synced", async () => {
    const id = await syncedWithRefusal({ memberUserId: payer });
    const fetchImpl = vi.fn(async () => Response.json({ error: "attribution_bank_verified" }, { status: 409 }));
    const result = await retryDraftAttribution(db, id, { deps: deps(fetchImpl as never) });
    expect(result).toEqual({ status: "refused", code: "bank_verified" });
    expect(await getOutboxRow(db, id)).toMatchObject({
      state: "synced",
      attributionOutcome: "REFUSED",
      attributionError: "bank_verified"
    });
    expect(attributionRefusalCode("bank_verified")).toBe("bank_verified");
    expect(attributionRefusalCode("attribution_bank_verified")).toBe("bank_verified");
    expect(attributionRefusalCode("attribution_failed")).toBe("other");
  });

  it("changes nothing when it cannot reach a verdict", async () => {
    const id = await syncedWithRefusal({ memberUserId: payer });
    const before = await getOutboxRow(db, id);
    const down = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const result = await retryDraftAttribution(db, id, { deps: deps(down as never) });
    expect(result).toEqual({ status: "unavailable", cause: "error" });
    expect(await getOutboxRow(db, id)).toEqual(before);

    const signedOut = await retryDraftAttribution(db, id, { deps: { getToken: async () => null } });
    expect(signedOut).toEqual({ status: "unavailable", cause: "unauthorized" });
  });

  it("has nothing to retry for a plain entry, an unsynced draft, or an unknown row", async () => {
    const plainId = await syncedWithRefusal();
    const unsynced = await queueDraft(
      db,
      (await saveDraft(db, { request: contribution("k-u"), attribution: { memberUserId: payer }, updatedBy: actorId })).id
    );
    const fetchImpl = vi.fn();
    for (const id of [plainId, unsynced.outbox.id, "missing"]) {
      expect(await retryDraftAttribution(db, id, { deps: deps(fetchImpl as never) })).toEqual({ status: "nothing-to-retry" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recordAttributionOutcome refuses a row the server does not hold yet", async () => {
    const draft = await saveDraft(db, { request: contribution("k-p"), attribution: { memberUserId: payer }, updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id);
    await expect(recordAttributionOutcome(db, outbox.id, "RECORDED", null, new Date())).rejects.toMatchObject({
      code: "SYNC_PROTECTED_ROW"
    });
  });
});
