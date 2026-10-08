import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attributionFromPayload, normalizeDraftAttribution } from "@/lib/db/attribution";
import { deleteSenedDatabase, resetSenedDatabase } from "@/lib/db/database";
import { getDraft, queueDraft, saveDraft } from "@/lib/db/drafts";
import { claimAttributionRetry, getOutboxRow, requeueTerminal } from "@/lib/db/outbox";
import { createSenedDatabase, type SenedDatabase } from "@/lib/db/schema";
import type { OutboxRow } from "@/lib/db/types";
import {
  ATTRIBUTION_MAX_AUTO_ATTEMPTS,
  attributionRetryView,
  classifyAttributionError,
  isAttributionRetryDue
} from "@/lib/offline/attributionPolicy";
import { nextAttributionRetryAt, retryDraftAttribution, retryDueAttributions } from "@/lib/offline/attributionRetry";
import { computeBackoffMs } from "@/lib/offline/backoff";
import { SyncError, type SyncPushResult } from "@/lib/offline/contract";
import { OfflineSyncEngine } from "@/lib/offline/engine";

const groupId = "22222222-2222-4222-8222-222222222222";
const cashAccount = "44444444-4444-4444-8444-444444444444";
const incomeAccount = "55555555-5555-4555-8555-555555555555";
const actorId = "11111111-1111-4111-8111-111111111111";
const payer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const serverEntryId = "77777777-7777-4777-8777-777777777777";
const T0 = new Date("2026-10-12T09:00:00.000Z");

let db: SenedDatabase;
let dbName: string;

function contribution(key: string) {
  return {
    groupId,
    idempotencyKey: key,
    occurredAt: "2026-09-20T09:00:00.000Z",
    entryType: "contribution" as const,
    postings: [
      { accountId: cashAccount, direction: "debit" as const, amount: "500.00" },
      { accountId: incomeAccount, direction: "credit" as const, amount: "500.00" }
    ]
  };
}

beforeEach(() => {
  dbName = `sened-test-auto-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
});

afterEach(async () => {
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
  vi.unstubAllGlobals();
});

/** Sync a draft carrying `attribution`; the server answers the entry and reports `report` for the payer. */
async function syncedDraft(
  key: string,
  attribution: object | undefined,
  report: { outcome: "RECORDED" } | { outcome: "REFUSED"; error: string } | undefined,
  database: SenedDatabase = db
): Promise<string> {
  const draft = await saveDraft(database, { request: contribution(key), attribution, updatedBy: actorId });
  const { outbox } = await queueDraft(database, draft.id);
  const engine = new OfflineSyncEngine({
    db: database,
    clock: () => T0,
    random: () => 0.5,
    transport: {
      async push(_a, envelopes) {
        return envelopes.map(
          (envelope): SyncPushResult => ({
            mutationId: envelope.mutationId,
            outcome: "ACCEPTED",
            serverEntryId,
            serverEntryHash: "b".repeat(64),
            serverSequence: "1",
            ...(report ? { attribution: report } : {})
          })
        );
      },
      async pull() {
        throw new SyncError("SYNC_NOT_CONFIGURED", "no pull");
      }
    }
  });
  await engine.drain("Bearer t");
  return outbox.id;
}

/** A stand-in for POST /api/ledger/attributions with the database's replay rule. */
function fakeAttributionServer(options: { fail?: () => Response | Promise<Response> } = {}) {
  const records = new Map<string, Record<string, unknown>>();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (options.fail) {
      return options.fail();
    }
    const entryId = body.entryId as string;
    const existing = records.get(entryId);
    const same =
      existing !== undefined &&
      ["memberUserId", "cycleId", "round", "channel", "note"].every((key) => (existing[key] ?? null) === (body[key] ?? null));
    if (existing && same) {
      return Response.json({ attribution: { revision: 1 }, replayed: true }, { status: 200 });
    }
    if (existing) {
      return Response.json({ error: "attribution_exists" }, { status: 409 });
    }
    records.set(entryId, body);
    return Response.json({ attribution: { revision: 1 }, replayed: false }, { status: 201 });
  });
  return { records, calls, fetchImpl };
}

const deps = (fetchImpl: unknown) => ({ getToken: async () => "tok", fetchImpl: fetchImpl as typeof fetch });

describe("which payer answers are retried by themselves", () => {
  it("retries what says nothing about the payer, and nothing the database refused", () => {
    for (const transient of [null, undefined, "", "attribution_failed", "attribution_unreadable", "attribution_conflict"]) {
      expect(classifyAttributionError(transient), String(transient)).toBe("transient");
    }
    for (const definitive of [
      "attribution_exists",
      "exists",
      "forbidden",
      "ledger_member_not_found",
      "member_not_found",
      "attribution_bank_verified",
      "bank_verified",
      "attribution_entry_corrected",
      "attribution_unchanged",
      "attribution_not_contribution",
      "ledger_entry_not_found",
      "ledger_cycle_not_found",
      "ledger_invalid_request",
      "some_new_code_from_a_newer_server"
    ]) {
      expect(classifyAttributionError(definitive), definitive).toBe("definitive");
    }
  });
});

describe("where the automatic retry starts when an entry syncs", () => {
  it("a failed attribution write counts as the first try and is due after the backoff; the entry stays synced", async () => {
    const id = await syncedDraft("k1", { memberUserId: payer }, { outcome: "REFUSED", error: "attribution_failed" });
    const row = await getOutboxRow(db, id);
    expect(row).toMatchObject({
      state: "synced",
      attributionOutcome: "REFUSED",
      attributionError: "attribution_failed",
      attributionAttempts: 1
    });
    expect(row?.attributionNextAttemptAt).toBe(T0.getTime() + computeBackoffMs(1, { random: () => 0.5 }));
    expect(attributionRetryView(row)).toEqual({
      kind: "auto",
      attempt: 2,
      maxAttempts: ATTRIBUTION_MAX_AUTO_ATTEMPTS,
      nextAt: row?.attributionNextAttemptAt
    });
  });

  it("a silent result is owed a try straight away", async () => {
    const id = await syncedDraft("k2", { memberUserId: payer }, undefined);
    const row = await getOutboxRow(db, id);
    expect(row).toMatchObject({ state: "synced", attributionOutcome: null, attributionAttempts: 0, attributionNextAttemptAt: null });
    expect(isAttributionRetryDue(row as OutboxRow, T0.getTime())).toBe(true);
    expect(attributionRetryView(row)).toMatchObject({ kind: "auto", attempt: 1, nextAt: null });
  });

  it("a definitive refusal is never scheduled: it needs a person", async () => {
    for (const error of ["attribution_exists", "forbidden", "ledger_member_not_found", "attribution_bank_verified"]) {
      const id = await syncedDraft(`k-${error}`, { memberUserId: payer }, { outcome: "REFUSED", error });
      const row = await getOutboxRow(db, id);
      expect(attributionRetryView(row), error).toEqual({ kind: "attention", reason: "definitive", code: error });
      expect(isAttributionRetryDue(row as OutboxRow, T0.getTime() + 10 * 60_000), error).toBe(false);
    }
  });

  it("a recorded payer, a draft with no payer and an unsynced draft have nothing to retry", async () => {
    const recorded = await getOutboxRow(db, await syncedDraft("k-r", { memberUserId: payer }, { outcome: "RECORDED" }));
    expect(attributionRetryView(recorded)).toEqual({ kind: "recorded" });
    const plain = await getOutboxRow(db, await syncedDraft("k-p", undefined, undefined));
    expect(attributionRetryView(plain)).toEqual({ kind: "none" });
    const draft = await saveDraft(db, { request: contribution("k-u"), attribution: { memberUserId: payer }, updatedBy: actorId });
    const { outbox } = await queueDraft(db, draft.id);
    expect(attributionRetryView(outbox)).toEqual({ kind: "waiting" });
    expect(isAttributionRetryDue(outbox, T0.getTime())).toBe(false);
  });
});

describe("retryDueAttributions", () => {
  it("never retries while signed out: nothing is read, sent or counted", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const before = await getOutboxRow(db, id);
    const server = fakeAttributionServer();
    const report = await retryDueAttributions(db, { signedIn: false, online: true, deps: deps(server.fetchImpl), now: T0 });
    expect(report).toEqual({ status: "signed-out" });
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(await getOutboxRow(db, id)).toEqual(before);
  });

  it("never sends from a session that has no token even when told it is signed in", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const fetchImpl = vi.fn();
    const report = await retryDueAttributions(db, {
      signedIn: true,
      online: true,
      now: T0,
      deps: { getToken: async () => null, fetchImpl: fetchImpl as never }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The 401-equivalent stops the run and spends no try.
    expect(report).toMatchObject({ status: "done", attempted: 0, stoppedSignedOut: true });
    expect(await getOutboxRow(db, id)).toMatchObject({ attributionAttempts: 0, attributionNextAttemptAt: null });
  });

  it("waits while offline: no request, no try spent", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const server = fakeAttributionServer();
    expect(await retryDueAttributions(db, { signedIn: true, online: false, deps: deps(server.fetchImpl), now: T0 })).toEqual({
      status: "offline"
    });
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(await getOutboxRow(db, id)).toMatchObject({ attributionAttempts: 0 });
  });

  it("records the payer with its channel and note, sending ONLY the attribution for the server's entry (never the entry again)", async () => {
    const id = await syncedDraft(
      "k",
      { memberUserId: payer, channel: "telebirr", note: "  Sent by his wife  " },
      { outcome: "REFUSED", error: "attribution_failed" }
    );
    const server = fakeAttributionServer();
    const later = new Date(T0.getTime() + 10 * 60_000);
    const report = await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: later });

    expect(report).toEqual({ status: "done", attempted: 1, recorded: 1, refused: 0, scheduled: 0, exhausted: 0, stoppedSignedOut: false });
    expect(server.calls).toEqual([
      {
        url: "/api/ledger/attributions",
        body: { groupId, entryId: serverEntryId, memberUserId: payer, channel: "telebirr", note: "Sent by his wife" }
      }
    ]);
    expect(await getOutboxRow(db, id)).toMatchObject({
      state: "synced",
      attributionOutcome: "RECORDED",
      attributionError: null,
      attributionAttempts: 2,
      attributionNextAttemptAt: null
    });
    expect(attributionRetryView(await getOutboxRow(db, id))).toEqual({ kind: "recorded" });
  });

  it("does not double-record: a repeat is answered with the existing record, and a recorded payer is never sent again", async () => {
    const id = await syncedDraft("k", { memberUserId: payer, channel: "cash" }, { outcome: "REFUSED", error: "attribution_failed" });
    const server = fakeAttributionServer();
    // The first attempt reached the server but its answer was lost: the record exists, the row does not know.
    server.records.set(serverEntryId, { groupId, entryId: serverEntryId, memberUserId: payer, channel: "cash" });
    const later = new Date(T0.getTime() + 10 * 60_000);
    const report = await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: later });
    expect(report).toMatchObject({ attempted: 1, recorded: 1 });
    expect(server.records.size).toBe(1);
    expect(await getOutboxRow(db, id)).toMatchObject({ attributionOutcome: "RECORDED" });

    const again = await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: later });
    expect(again).toMatchObject({ status: "done", attempted: 0 });
    expect(server.fetchImpl).toHaveBeenCalledTimes(1);
    // The manual button on a recorded payer does not send either.
    expect(await retryDraftAttribution(db, id, { deps: deps(server.fetchImpl) })).toEqual({ status: "recorded" });
    expect(server.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("two triggers firing together send one request", async () => {
    await syncedDraft("k", { memberUserId: payer }, undefined);
    const server = fakeAttributionServer();
    const options = { signedIn: true, online: true, deps: deps(server.fetchImpl), now: T0 };
    const [a, b] = await Promise.all([retryDueAttributions(db, options), retryDueAttributions(db, options)]);
    expect(server.fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.records.size).toBe(1);
    expect([a, b].filter((report) => report.status === "done" && report.attempted === 1)).toHaveLength(1);
  });

  it("a definitive refusal is stored with its reason and not retried again", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const server = fakeAttributionServer({ fail: () => Response.json({ error: "attribution_bank_verified" }, { status: 409 }) });
    const report = await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: T0 });
    expect(report).toMatchObject({ attempted: 1, refused: 1, recorded: 0 });
    expect(await getOutboxRow(db, id)).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "bank_verified" });
    expect(attributionRetryView(await getOutboxRow(db, id))).toMatchObject({ kind: "attention", reason: "definitive" });

    const later = new Date(T0.getTime() + 60 * 60_000);
    expect(await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: later })).toMatchObject({
      attempted: 0
    });
    expect(server.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 403 is definitive (stored as forbidden), a 404 member is definitive, and neither is retried by itself", async () => {
    const forbidden = await syncedDraft("k-403", { memberUserId: payer }, undefined);
    const fetch403 = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(fetch403), now: T0, limit: 1 });
    expect(await getOutboxRow(db, forbidden)).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "forbidden" });
    expect(attributionRetryView(await getOutboxRow(db, forbidden))).toMatchObject({ kind: "attention", reason: "definitive" });

    const notMember = await syncedDraft("k-404", { memberUserId: payer }, undefined);
    const fetch404 = vi.fn(async () => Response.json({ error: "ledger_member_not_found" }, { status: 404 }));
    await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(fetch404), now: T0 });
    expect(await getOutboxRow(db, notMember)).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "member_not_found" });
    expect(attributionRetryView(await getOutboxRow(db, notMember))).toMatchObject({ kind: "attention", reason: "definitive" });
  });

  it("a network failure, a 5xx and a rate limit back off with the shared helper, and the schedule is stored on the row", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const random = () => 0.25;
    const failures = [
      () => {
        throw new TypeError("network down");
      },
      () => Response.json({ error: "attribution_failed" }, { status: 502 }),
      () => Response.json({ error: "rate_limited" }, { status: 429 })
    ];
    let now = T0.getTime();
    for (const [index, fail] of failures.entries()) {
      const fetchImpl = vi.fn(async () => fail());
      const report = await retryDueAttributions(db, {
        signedIn: true,
        online: true,
        deps: deps(fetchImpl),
        now: new Date(now),
        backoff: { random }
      });
      expect(report).toMatchObject({ attempted: 1, scheduled: 1, recorded: 0 });
      const row = await getOutboxRow(db, id);
      expect(row).toMatchObject({ state: "synced", attributionOutcome: "REFUSED", attributionError: "attribution_failed", attributionAttempts: index + 1 });
      expect(row?.attributionNextAttemptAt).toBe(now + computeBackoffMs(index + 1, { random }));
      // not due before then: nothing is sent
      const early = vi.fn();
      expect(
        await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(early), now: new Date(now), backoff: { random } })
      ).toMatchObject({ attempted: 0 });
      expect(early).not.toHaveBeenCalled();
      now = (row?.attributionNextAttemptAt as number) + 1;
    }
  });

  it("is bounded: after the last try the row needs a person and is never retried by itself again", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    let now = T0.getTime();
    for (let attempt = 1; attempt <= ATTRIBUTION_MAX_AUTO_ATTEMPTS; attempt += 1) {
      await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(down), now: new Date(now), backoff: { random: () => 1 } });
      const row = await getOutboxRow(db, id);
      expect(row?.attributionAttempts).toBe(attempt);
      now = (row?.attributionNextAttemptAt ?? now) + 1;
    }
    const exhausted = await getOutboxRow(db, id);
    expect(down).toHaveBeenCalledTimes(ATTRIBUTION_MAX_AUTO_ATTEMPTS);
    expect(exhausted).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "attribution_failed", attributionNextAttemptAt: null });
    expect(attributionRetryView(exhausted)).toMatchObject({ kind: "attention", reason: "exhausted" });
    await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(down), now: new Date(now + 24 * 3_600_000) });
    expect(down).toHaveBeenCalledTimes(ATTRIBUTION_MAX_AUTO_ATTEMPTS);

    // The manual button still works, and a good answer records it.
    const server = fakeAttributionServer();
    expect(await retryDraftAttribution(db, id, { deps: deps(server.fetchImpl) })).toEqual({ status: "recorded" });
  });

  it("a signed-out answer (401) stops the run and spends no try", async () => {
    const first = await syncedDraft("k1", { memberUserId: payer }, undefined);
    await syncedDraft("k2", { memberUserId: payer }, undefined);
    const fetchImpl = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    const report = await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(fetchImpl), now: T0 });
    expect(report).toMatchObject({ status: "done", attempted: 0, stoppedSignedOut: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await getOutboxRow(db, first)).toMatchObject({ attributionAttempts: 0, attributionNextAttemptAt: null, attributionOutcome: null });
  });

  it("survives a reload: the attempt count and next-due time are on the stored row", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await retryDueAttributions(db, { signedIn: true, online: true, deps: deps(down), now: T0, backoff: { random: () => 0.5 } });
    const stored = await getOutboxRow(db, id);
    db.close();

    const reopened = createSenedDatabase(dbName);
    try {
      const row = await getOutboxRow(reopened, id);
      expect(row).toMatchObject({ attributionAttempts: 1, attributionNextAttemptAt: stored?.attributionNextAttemptAt });
      expect(await nextAttributionRetryAt(reopened)).toBe(stored?.attributionNextAttemptAt);
      const server = fakeAttributionServer();
      expect(
        await retryDueAttributions(reopened, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: new Date(T0.getTime() + 100) })
      ).toMatchObject({ attempted: 0 });
      const due = new Date((stored?.attributionNextAttemptAt as number) + 1);
      expect(await retryDueAttributions(reopened, { signedIn: true, online: true, deps: deps(server.fetchImpl), now: due })).toMatchObject({
        attempted: 1,
        recorded: 1
      });
    } finally {
      reopened.close();
      db = createSenedDatabase(dbName);
    }
  });

  it("claims a row once: a second claim in the lease window gets nothing", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, undefined);
    expect(await claimAttributionRetry(db, id, { now: T0 })).not.toBeNull();
    expect(await claimAttributionRetry(db, id, { now: T0 })).toBeNull();
    expect(await claimAttributionRetry(db, id, { now: new Date(T0.getTime() + 31_000) })).not.toBeNull();
  });

  it("a requeued entry starts over with a clean retry state", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, { outcome: "REFUSED", error: "attribution_failed" });
    const requeued = await requeueTerminal(db, id, { now: T0, reason: "test" });
    expect(requeued).toMatchObject({ attributionAttempts: 0, attributionNextAttemptAt: null, attributionOutcome: null });
  });
});

describe("the manual button", () => {
  it("changes nothing on a transient failure, and records a 403 as a definitive refusal", async () => {
    const id = await syncedDraft("k", { memberUserId: payer }, { outcome: "REFUSED", error: "attribution_failed" });
    const before = await getOutboxRow(db, id);
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await retryDraftAttribution(db, id, { deps: deps(down) })).toEqual({ status: "unavailable", cause: "error" });
    expect(await getOutboxRow(db, id)).toEqual(before);

    const forbidden = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    expect(await retryDraftAttribution(db, id, { deps: deps(forbidden) })).toEqual({ status: "refused", code: "forbidden" });
    expect(await getOutboxRow(db, id)).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "forbidden" });
  });
});

describe("a draft's payment channel and note", () => {
  it("are optional, trimmed and checked on the device with the server's rules", () => {
    expect(normalizeDraftAttribution({ memberUserId: payer, channel: "cash", note: "  Paid at the meeting  " })).toEqual({
      memberUserId: payer,
      channel: "cash",
      note: "Paid at the meeting"
    });
    // null and a blank note mean none, and are not kept
    expect(normalizeDraftAttribution({ memberUserId: payer, channel: null, note: "   " })).toEqual({ memberUserId: payer });
    expect(normalizeDraftAttribution({ memberUserId: payer })).toEqual({ memberUserId: payer });
    for (const bad of [
      { memberUserId: payer, channel: "paypal" },
      { memberUserId: payer, note: "x".repeat(281) },
      { memberUserId: payer, note: "two\nlines" },
      { memberUserId: payer, note: "bidi\u202eoverride" },
      { memberUserId: payer, note: 5 }
    ]) {
      expect(() => normalizeDraftAttribution(bad), JSON.stringify(bad)).toThrowError(/Draft attribution rejected/);
    }
    expect(normalizeDraftAttribution({ memberUserId: payer, note: "ሠ".repeat(280) })?.note).toHaveLength(280);
  });

  it("ride in the outbox payload beside the entry, never inside it", async () => {
    const draft = await saveDraft(db, {
      request: contribution("k"),
      attribution: { memberUserId: payer, channel: "awash", note: "Branch transfer" },
      updatedBy: actorId
    });
    const { outbox } = await queueDraft(db, draft.id);
    expect(attributionFromPayload(outbox.payload)).toEqual({ memberUserId: payer, channel: "awash", note: "Branch transfer" });
    const { attribution: _attribution, ...entry } = outbox.payload as Record<string, unknown>;
    expect(entry).toEqual(contribution("k"));
  });
});

describe("Dexie upgrade to schema version 3", () => {
  const STORES = {
    roster: "id, groupId, [groupId+displayName], updatedAt",
    spokenNotes: "id, groupId, memberId, [groupId+occurredAt], createdAt",
    drafts: "id, groupId, [groupId+status], idempotencyKey, updatedAt",
    outbox: "id, [state+nextAttemptAt], [groupId+state], kind, createdAt, idempotencyKey",
    ledgerMirror: "id, groupId, [groupId+sequenceNumber], [groupId+entryHash]",
    syncMeta: "key, groupId"
  };

  function outboxRow(id: string, extra: Record<string, unknown>) {
    return {
      id,
      kind: "ledger-draft",
      groupId,
      subjectId: `draft-${id}`,
      idempotencyKey: `sened-offline:ledger-draft:${id}`,
      attempts: 0,
      payload: { ...contribution(id), attribution: { memberUserId: payer } },
      nextAttemptAt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      settledAt: "2026-09-20T09:00:00.000Z",
      ...extra
    };
  }

  it.each([1, 2])("keeps everything written under version %i valid and gives each outbox row a clean retry state", async (version) => {
    const name = `sened-test-v${version}-to-v3-${Math.random().toString(36).slice(2, 10)}`;
    const old = new Dexie(name);
    old.version(1).stores(STORES);
    if (version === 2) {
      old.version(2).stores(STORES);
    }
    await old.table("drafts").put({
      id: "draft-old",
      groupId,
      request: contribution("old"),
      status: "draft",
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      updatedBy: actorId,
      outboxId: null,
      ...(version === 2 ? { attribution: { memberUserId: payer, cycleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", round: 2 } } : {})
    });
    const synced = (id: string, outcome: unknown, error: unknown) =>
      outboxRow(id, {
        state: "synced",
        serverEntryId,
        serverEntryHash: "b".repeat(64),
        serverSequence: "1",
        ...(version === 2 ? { attributionOutcome: outcome, attributionError: error } : {})
      });
    await old.table("outbox").bulkPut([
      synced("silent", null, null),
      synced("transient", "REFUSED", "attribution_failed"),
      synced("definitive", "REFUSED", "attribution_exists"),
      synced("done", "RECORDED", null)
    ]);
    old.close();

    const upgraded = createSenedDatabase(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(3);
      const draft = await getDraft(upgraded, "draft-old");
      expect(draft?.request).toEqual(contribution("old"));
      if (version === 2) {
        // An old payer has no channel and no note, and is still a valid attribution.
        expect(draft?.attribution).toEqual({ memberUserId: payer, cycleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", round: 2 });
        expect(normalizeDraftAttribution(draft?.attribution)).toEqual(draft?.attribution);
      }
      const queued = await queueDraft(upgraded, "draft-old");
      expect(queued.outbox.payload).toEqual(
        version === 2 ? { ...contribution("old"), attribution: draft?.attribution } : contribution("old")
      );

      for (const id of ["silent", "transient", "definitive", "done"]) {
        expect(await getOutboxRow(upgraded, id), id).toMatchObject({ attributionAttempts: 0, attributionNextAttemptAt: null });
      }
      if (version === 2) {
        // The ones whose payer never recorded for a reason a retry can change are owed a try; the others are not.
        const now = new Date("2026-10-12T09:00:00.000Z");
        expect(isAttributionRetryDue((await getOutboxRow(upgraded, "silent")) as OutboxRow, now.getTime())).toBe(true);
        expect(isAttributionRetryDue((await getOutboxRow(upgraded, "transient")) as OutboxRow, now.getTime())).toBe(true);
        expect(isAttributionRetryDue((await getOutboxRow(upgraded, "definitive")) as OutboxRow, now.getTime())).toBe(false);
        expect(isAttributionRetryDue((await getOutboxRow(upgraded, "done")) as OutboxRow, now.getTime())).toBe(false);
      }
    } finally {
      upgraded.close();
      await deleteSenedDatabase(name);
    }
  });
});
