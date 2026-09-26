import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSenedDatabase,
  DEFAULT_DATABASE_NAME,
  DATABASE_SCHEMA_VERSION
} from "@/lib/db/schema";
import {
  deleteSenedDatabase,
  isOfflineStorageAvailable,
  resetSenedDatabase
} from "@/lib/db/database";
import { addOnDeviceContribution, listRoster, rosterTotalsOnDevice, saveRosterMember } from "@/lib/db/roster";
import { listSpokenNotes, saveSpokenNote } from "@/lib/db/notes";
import { deleteDraft, getDraft, listDrafts, queueDraft, saveDraft } from "@/lib/db/drafts";
import { claimOutboxBatch, enqueue, findOutboxBySubject, listOutbox, summarizeQueue } from "@/lib/db/outbox";
import { getLocalChainHead, listMirrorChain, storeMirrorEntries } from "@/lib/db/mirror";
import { readSyncMeta } from "@/lib/db/meta";
import type { SenedDatabase } from "@/lib/db/schema";
import { SyncError } from "@/lib/offline/contract";
import type { LedgerEntryLike } from "@/lib/offline/contract";

const groupId = "22222222-2222-4222-8222-222222222222";
const otherGroupId = "33333333-3333-4333-8333-333333333333";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";
const actorId = "11111111-1111-4111-8111-111111111111";

let db: SenedDatabase;
let dbName: string;

function uniqueName(label: string): string {
  return `sened-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function contribution(idempotencyKey: string, amount = "500.00") {
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

function mirroredEntry(overrides: Partial<LedgerEntryLike> & Pick<LedgerEntryLike, "id" | "sequence" | "entryHash">): LedgerEntryLike {
  return {
    groupId,
    occurredAt: "2026-09-20T09:00:00.000Z",
    recordedAt: "2026-09-20T09:00:01.000Z",
    previousHash: "0".repeat(64),
    entryType: "contribution",
    actorId,
    nonce: `nonce-${overrides.sequence}`,
    correctsEntryId: null,
    rationale: null,
    postings: [
      { id: `posting-${overrides.sequence}-1`, ordinal: 0, accountId: cashAccount, direction: "debit", amount: "500.00" },
      { id: `posting-${overrides.sequence}-2`, ordinal: 1, accountId: incomeAccount, direction: "credit", amount: "500.00" }
    ],
    ...overrides
  };
}

beforeEach(() => {
  dbName = uniqueName("db");
  db = createSenedDatabase(dbName);
});

afterEach(async () => {
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
});

describe("offline store schema", () => {
  it("runs on the fake IndexedDB that test/setup.ts installs", () => {
    expect(isOfflineStorageAvailable()).toBe(true);
    expect(db.verno).toBe(DATABASE_SCHEMA_VERSION);
  });

  it("creates every table the treasurer needs", () => {
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "drafts",
      "ledgerMirror",
      "outbox",
      "roster",
      "spokenNotes",
      "syncMeta"
    ]);
  });

  it("keeps entries across a close and reopen, which is what a reload does", async () => {
    await saveRosterMember(db, { groupId, displayName: "Selam Bekele", updatedBy: actorId });
    await saveSpokenNote(db, { groupId, transcript: "ለመስከረም ወር 500 ብር በቴሌብር" });
    const draft = await saveDraft(db, { request: contribution("reload-1"), updatedBy: actorId });
    await queueDraft(db, draft.id);

    db.close();
    const reopened = createSenedDatabase(dbName);
    try {
      expect(await reopened.roster.count()).toBe(1);
      expect(await reopened.spokenNotes.count()).toBe(1);
      expect(await reopened.drafts.count()).toBe(1);
      const reloadedDraft = await reopened.drafts.get(draft.id);
      expect(reloadedDraft?.status).toBe("queued");
      expect(reloadedDraft?.outboxId).not.toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("defaults to the shared database name and can delete it", async () => {
    const shared = createSenedDatabase();
    expect(shared.name).toBe(DEFAULT_DATABASE_NAME);
    shared.close();
    await expect(deleteSenedDatabase(uniqueName("never-opened"))).resolves.toBeUndefined();
  });
});

describe("roster store", () => {
  it("stores a member with an explicit revision and canonical amount", async () => {
    const first = await saveRosterMember(db, {
      groupId,
      displayName: "  Marta Alemu  ",
      phone: "+251911000001",
      role: "treasurer",
      updatedBy: actorId
    });
    expect(first.displayName).toBe("Marta Alemu");
    expect(first.role).toBe("treasurer");
    expect(first.contributedEtbOnDevice).toBe("0.00");
    expect(first.revision).toBe(1);

    const second = await saveRosterMember(db, {
      id: first.id,
      groupId,
      displayName: "Marta Alemu",
      updatedBy: actorId
    });
    expect(second.revision).toBe(2);
    expect(second.phone).toBeNull();
  });

  it("rejects an empty name, an unknown role and a non-ETB amount", async () => {
    await expect(
      saveRosterMember(db, { groupId, displayName: "   ", updatedBy: actorId })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
    await expect(
      saveRosterMember(db, {
        groupId,
        displayName: "Dawit",
        role: "auditor" as never,
        updatedBy: actorId
      })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
    await expect(
      saveRosterMember(db, {
        groupId,
        displayName: "Dawit",
        contributedEtbOnDevice: "1,000",
        updatedBy: actorId
      })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });

  it("adds on-device contributions with bigint ETB arithmetic and no drift", async () => {
    const member = await saveRosterMember(db, { groupId, displayName: "Abebe", updatedBy: actorId });
    await addOnDeviceContribution(db, member.id, "0.1", { now: new Date("2026-09-20T09:00:00.000Z") });
    await addOnDeviceContribution(db, member.id, "0.2", { now: new Date("2026-09-20T09:05:00.000Z") });
    const after = await addOnDeviceContribution(db, member.id, "10000.15", {
      now: new Date("2026-09-20T09:10:00.000Z")
    });
    expect(after.contributedEtbOnDevice).toBe("10000.45");
  });

  it("refuses a contribution for a member that is not on this device", async () => {
    await expect(addOnDeviceContribution(db, "nobody", "10.00")).rejects.toMatchObject({
      code: "LOCAL_RECORD_NOT_FOUND"
    });
  });

  it("reports on-device totals separately from anything the server issued", async () => {
    const member = await saveRosterMember(db, {
      groupId,
      displayName: "Selam",
      contributedEtbOnDevice: "1200",
      updatedBy: actorId
    });
    await saveRosterMember(db, { groupId: otherGroupId, displayName: "Other", updatedBy: actorId });
    await addOnDeviceContribution(db, member.id, "300");

    const totals = await rosterTotalsOnDevice(db, groupId);
    expect(totals).toEqual({ memberCount: 1, activeMemberCount: 1, contributedEtbOnDevice: "1500.00" });
    expect(await rosterTotalsOnDevice(db, otherGroupId)).toEqual({
      memberCount: 1,
      activeMemberCount: 1,
      contributedEtbOnDevice: "0.00"
    });
  });

  it("scopes the roster to a group", async () => {
    await saveRosterMember(db, { groupId, displayName: "A", updatedBy: actorId });
    await saveRosterMember(db, { groupId, displayName: "B", updatedBy: actorId });
    await saveRosterMember(db, { groupId: otherGroupId, displayName: "C", updatedBy: actorId });
    expect((await listRoster(db, groupId)).map((row) => row.displayName)).toEqual(["A", "B"]);
  });
});

describe("spoken note store", () => {
  it("records provenance honestly and hashes the content", async () => {
    const note = await saveSpokenNote(db, {
      groupId,
      transcript: "ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው",
      amountEtb: "5000",
      channel: "telebirr",
      now: new Date("2026-09-20T09:00:00.000Z")
    });

    expect(note.transcriptSource).toBe("human-typed");
    expect(note.amountEtb).toBe("5000.00");
    expect(note.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(note.audioByteLength).toBeNull();
  });

  it("changes the hash when the substance changes, and not when only the save time moves", async () => {
    const base = {
      groupId,
      transcript: "500 birr",
      occurredAt: "2026-09-20T09:00:00.000Z",
      now: new Date("2026-09-20T09:00:00.000Z")
    };
    const first = await saveSpokenNote(db, { ...base, id: "note-1" });
    const sameAgain = await saveSpokenNote(db, {
      ...base,
      id: "note-1",
      now: new Date("2026-09-20T10:00:00.000Z")
    });
    const changed = await saveSpokenNote(db, { ...base, id: "note-1", transcript: "1500 birr" });

    expect(sameAgain.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("stores the note with no hash when WebCrypto is unavailable, rather than faking one", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: () => new Uint8Array(4) }, configurable: true });
    try {
      const note = await saveSpokenNote(db, { groupId, transcript: "no subtle crypto here" });
      expect(note.contentHash).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });

  it("rejects an unusable amount, locale or channel", async () => {
    await expect(
      saveSpokenNote(db, { groupId, transcript: "x", amountEtb: "five hundred" })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
    await expect(
      saveSpokenNote(db, { groupId, transcript: "x", locale: "sw" as never })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
    await expect(
      saveSpokenNote(db, { groupId, transcript: "x", channel: "crypto" as never })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });

  it("orders notes newest first and scopes them to a group", async () => {
    await saveSpokenNote(db, { groupId, transcript: "older", occurredAt: "2026-09-01T09:00:00.000Z" });
    await saveSpokenNote(db, { groupId, transcript: "newer", occurredAt: "2026-09-20T09:00:00.000Z" });
    await saveSpokenNote(db, { groupId: otherGroupId, transcript: "elsewhere", occurredAt: "2026-09-21T09:00:00.000Z" });

    const notes = await listSpokenNotes(db, groupId);
    expect(notes.map((note) => note.transcript)).toEqual(["newer", "older"]);
  });
});

describe("draft store", () => {
  it("validates a draft with the ledger's own rules before storing it", async () => {
    const draft = await saveDraft(db, { request: contribution("draft-1", "1500"), updatedBy: actorId });
    expect(draft.request.postings).toHaveLength(2);
    expect(draft.status).toBe("draft");
    expect(draft.outboxId).toBeNull();
  });

  it("refuses an unbalanced draft with the ledger's own code, not a vague error", async () => {
    await expect(
      saveDraft(db, {
        updatedBy: actorId,
        request: {
          ...contribution("draft-unbalanced"),
          postings: [
            { accountId: cashAccount, direction: "debit", amount: "500.00" },
            { accountId: incomeAccount, direction: "credit", amount: "400.00" }
          ]
        }
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });

    try {
      await saveDraft(db, {
        updatedBy: actorId,
        request: {
          ...contribution("draft-unbalanced-2"),
          postings: [
            { accountId: cashAccount, direction: "debit", amount: "500.00" },
            { accountId: incomeAccount, direction: "credit", amount: "400.00" }
          ]
        }
      });
      throw new Error("expected the draft to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).message).toContain("UNBALANCED");
      expect((error as SyncError).cause).toMatchObject({ code: "UNBALANCED" });
    }
  });

  it("refuses a single-sided posting, a bad amount and a non-uuid group", async () => {
    await expect(
      saveDraft(db, {
        updatedBy: actorId,
        request: { ...contribution("one-sided"), postings: [{ accountId: cashAccount, direction: "debit", amount: "500.00" }] }
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });
    await expect(
      saveDraft(db, {
        updatedBy: actorId,
        request: { ...contribution("bad-amount"), postings: [
          { accountId: cashAccount, direction: "debit", amount: "-5" },
          { accountId: incomeAccount, direction: "credit", amount: "-5" }
        ] }
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });
    await expect(
      saveDraft(db, { updatedBy: actorId, request: { ...contribution("bad-group"), groupId: "not-a-uuid" } })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });
  });

  it("refuses a correction without a rationale, using the ledger's correction rules", async () => {
    await expect(
      saveDraft(db, {
        updatedBy: actorId,
        request: {
          groupId,
          idempotencyKey: "correction-1",
          occurredAt: "2026-09-20T09:00:00.000Z",
          entryType: "correction",
          postings: [
            { accountId: cashAccount, direction: "credit", amount: "500.00" },
            { accountId: incomeAccount, direction: "debit", amount: "500.00" }
          ]
        }
      })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });
  });

  it("derives a stable idempotency key from the draft so a reload cannot double-post", async () => {
    const draft = await saveDraft(db, { request: contribution("stable-key"), updatedBy: actorId });
    const first = await queueDraft(db, draft.id);
    const second = await queueDraft(db, draft.id);

    expect(second.outbox.id).toBe(first.outbox.id);
    expect(first.outbox.idempotencyKey).toBe(`sened-offline:ledger-draft:${groupId}:${draft.id}`);
    expect(await db.outbox.count()).toBe(1);
  });

  it("refuses to edit or delete a draft that is already queued", async () => {
    const draft = await saveDraft(db, { request: contribution("locked"), updatedBy: actorId });
    await queueDraft(db, draft.id);

    await expect(
      saveDraft(db, { id: draft.id, request: contribution("locked", "600"), updatedBy: actorId })
    ).rejects.toMatchObject({ code: "SYNC_PROTECTED_ROW" });
    await expect(deleteDraft(db, draft.id)).rejects.toMatchObject({ code: "SYNC_PROTECTED_ROW" });
  });

  it("rejects a draft whose group disagrees with its request", async () => {
    await expect(
      saveDraft(db, { groupId: otherGroupId, request: contribution("mismatch"), updatedBy: actorId })
    ).rejects.toMatchObject({ code: "INVALID_DRAFT" });
  });

  it("requires an actor for the audit trail", async () => {
    await expect(saveDraft(db, { request: contribution("no-actor"), updatedBy: "  " })).rejects.toMatchObject({
      code: "SYNC_CORRUPT_PAYLOAD"
    });
  });

  it("lists drafts newest-updated first and can delete an unqueued one", async () => {
    const first = await saveDraft(db, {
      request: contribution("list-1"),
      updatedBy: actorId,
      now: new Date("2026-09-20T09:00:00.000Z")
    });
    await saveDraft(db, {
      request: contribution("list-2"),
      updatedBy: actorId,
      now: new Date("2026-09-21T09:00:00.000Z")
    });
    expect((await listDrafts(db, groupId)).map((row) => row.id)).not.toContain("nope");
    expect((await listDrafts(db, groupId))[0]?.id).not.toBe(first.id);
    await deleteDraft(db, first.id);
    expect(await getDraft(db, first.id)).toBeUndefined();
  });
});

describe("outbox store", () => {
  it("enqueues in the queued state and never in a synced state", async () => {
    const row = await enqueue(db, {
      kind: "spoken-note",
      groupId,
      subjectId: "note-1",
      payload: { transcript: "hello" }
    });
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.serverEntryId).toBeNull();
    expect(row.settledAt).toBeNull();
  });

  it("refuses an envelope with no payload", async () => {
    await expect(
      enqueue(db, { kind: "spoken-note", groupId, subjectId: "note-1", payload: undefined })
    ).rejects.toMatchObject({ code: "SYNC_CORRUPT_PAYLOAD" });
  });

  it("is idempotent for the same mutation id", async () => {
    const first = await enqueue(db, {
      id: "mutation-1",
      kind: "ledger-draft",
      groupId,
      subjectId: "draft-1",
      payload: { a: 1 }
    });
    const second = await enqueue(db, {
      id: "mutation-1",
      kind: "ledger-draft",
      groupId,
      subjectId: "draft-1",
      payload: { a: 2 }
    });
    expect(second).toEqual(first);
    expect(await db.outbox.count()).toBe(1);
  });

  it("claims a due batch under a lease, skips what is not due, and never double-claims", async () => {
    const now = new Date("2026-09-20T09:00:00.000Z");
    await enqueue(db, { id: "m1", kind: "ledger-draft", groupId, subjectId: "d1", payload: {}, now });
    await enqueue(db, { id: "m2", kind: "ledger-draft", groupId, subjectId: "d2", payload: {}, now });
    await enqueue(db, {
      id: "m3",
      kind: "ledger-draft",
      groupId,
      subjectId: "d3",
      payload: {},
      now: new Date("2026-09-20T09:10:00.000Z")
    });

    const first = await claimOutboxBatch(db, { now, limit: 2, leaseOwner: "device-a", leaseMs: 30_000 });
    expect(first.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(first[0]?.state).toBe("in-flight");
    expect(first[0]?.leaseExpiresAt).toBe(now.getTime() + 30_000);

    // A second drain at the same instant must not steal the leased rows, and
    // m3 is not due yet, so there is nothing left to claim.
    const second = await claimOutboxBatch(db, { now, limit: 10, leaseOwner: "device-b", leaseMs: 30_000 });
    expect(second).toEqual([]);

    // Once the 30s lease expires every row is reclaimable, which is what makes a
    // crash mid-drain recoverable rather than lost work.
    const later = new Date("2026-09-20T09:11:00.000Z");
    const third = await claimOutboxBatch(db, { now: later, limit: 10, leaseOwner: "device-b", leaseMs: 30_000 });
    expect(third.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
    expect(third.every((row) => row.leaseOwner === "device-b")).toBe(true);
  });

  it("reclaims an expired lease so a crashed drain is not lost work", async () => {
    const now = new Date("2026-09-20T09:00:00.000Z");
    await enqueue(db, { id: "m1", kind: "ledger-draft", groupId, subjectId: "d1", payload: {}, now });
    const first = await claimOutboxBatch(db, { now, limit: 10, leaseOwner: "device-a", leaseMs: 1_000 });
    expect(first).toHaveLength(1);

    const later = new Date(now.getTime() + 5_000);
    const reclaimed = await claimOutboxBatch(db, {
      now: later,
      limit: 10,
      leaseOwner: "device-b",
      leaseMs: 1_000
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.leaseOwner).toBe("device-b");
  });

  it("summarises the queue with an honest pending count", async () => {
    await enqueue(db, { id: "m1", kind: "ledger-draft", groupId, subjectId: "d1", payload: {} });
    await enqueue(db, { id: "m2", kind: "spoken-note", groupId, subjectId: "n1", payload: {} });
    const empty = await summarizeQueue(db, groupId);
    expect(empty.total).toBe(2);
    expect(empty.quiet).toBe(false);
    expect(empty.byState.queued).toBe(2);
    expect(empty.oldestPendingAt).not.toBeNull();

    expect((await summarizeQueue(db, otherGroupId)).total).toBe(0);
  });

  it("finds the queue row carrying a local subject", async () => {
    const draft = await saveDraft(db, { request: contribution("find-me"), updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id);
    expect((await findOutboxBySubject(db, draft.id))?.id).toBe(outbox.id);
    expect(await findOutboxBySubject(db, "unknown")).toBeUndefined();
  });
});

describe("ledger mirror", () => {
  it("stores pulled entries in sequence order and reports the local head", async () => {
    const result = await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date("2026-09-20T09:00:00.000Z"),
      entries: [
        mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) }),
        mirroredEntry({ id: "e2", sequence: "2", entryHash: "b".repeat(64), previousHash: "a".repeat(64) })
      ]
    });

    expect(result.added).toHaveLength(2);
    expect(result.conflicting).toHaveLength(0);
    expect(result.unlinked).toHaveLength(0);
    expect((await listMirrorChain(db, groupId)).map((row) => row.sequence)).toEqual(["1", "2"]);
    expect(await getLocalChainHead(db, groupId)).toEqual({ sequence: "2", hash: "b".repeat(64) });
  });

  it("refuses an entry that does not link onto the head it already holds", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) })]
    });

    const result = await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "e2", sequence: "2", entryHash: "b".repeat(64), previousHash: "9".repeat(64) })]
    });

    expect(result.added).toHaveLength(0);
    expect(result.unlinked).toEqual([
      { sequence: "2", expectedPreviousHash: "a".repeat(64), receivedPreviousHash: "9".repeat(64) }
    ]);
    expect(await db.ledgerMirror.count()).toBe(1);
  });

  it("refuses a gap in the sequence rather than storing an unverifiable link", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) })]
    });
    const result = await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "e4", sequence: "4", entryHash: "b".repeat(64), previousHash: "a".repeat(64) })]
    });
    expect(result.added).toHaveLength(0);
    expect(result.unlinked[0]?.sequence).toBe("4");
  });

  it("never overwrites a sequence the device already holds", async () => {
    const first = mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) });
    await storeMirrorEntries(db, { groupId, pulledAt: new Date(), entries: [first] });

    const rewritten = mirroredEntry({ id: "e1-rewritten", sequence: "1", entryHash: "f".repeat(64) });
    const result = await storeMirrorEntries(db, { groupId, pulledAt: new Date(), entries: [rewritten] });

    expect(result.added).toHaveLength(0);
    expect(result.conflicting).toEqual([
      { sequence: "1", localHash: "a".repeat(64), incomingHash: "f".repeat(64) }
    ]);
    const chain = await listMirrorChain(db, groupId);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.entryHash).toBe("a".repeat(64));
  });

  it("treats the same hash under a new id as a conflict too", async () => {
    await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) })]
    });
    const result = await storeMirrorEntries(db, {
      groupId,
      pulledAt: new Date(),
      entries: [mirroredEntry({ id: "different-id", sequence: "1", entryHash: "a".repeat(64) })]
    });
    expect(result.conflicting).toHaveLength(1);
  });

  it("counts an identical re-pull as unchanged", async () => {
    const entry = mirroredEntry({ id: "e1", sequence: "1", entryHash: "a".repeat(64) });
    await storeMirrorEntries(db, { groupId, pulledAt: new Date(), entries: [entry] });
    const second = await storeMirrorEntries(db, { groupId, pulledAt: new Date(), entries: [entry] });
    expect(second.unchanged).toBe(1);
    expect(second.added).toHaveLength(0);
  });

  it("refuses an entry from another group", async () => {
    await expect(
      storeMirrorEntries(db, {
        groupId,
        pulledAt: new Date(),
        entries: [mirroredEntry({ groupId: otherGroupId, id: "e1", sequence: "1", entryHash: "a".repeat(64) })]
      })
    ).rejects.toThrow(/different group/);
  });

  it("refuses a sequence it cannot order safely instead of storing a wrong order", async () => {
    await expect(
      storeMirrorEntries(db, {
        groupId,
        pulledAt: new Date(),
        entries: [mirroredEntry({ id: "e1", sequence: "9007199254740993", entryHash: "a".repeat(64) })]
      })
    ).rejects.toThrow(/safe ordering range/);
  });

  it("starts with an empty meta row for a group that has never synced", async () => {
    const meta = await readSyncMeta(db, groupId);
    expect(meta.lastPulledSequence).toBe("0");
    expect(meta.divergence).toBeNull();
  });
});
