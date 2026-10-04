import {
  OFFLINE_SYNC_STATES,
  isTerminalOfflineSyncState,
  SyncError,
  type OfflineMutationKind,
  type OfflineSyncState,
  type SyncAttributionOutcome,
  type SyncPushResult
} from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import { createIdempotencyKey, newLocalId } from "./ids";
import type { SenedDatabase } from "./schema";
import type { OfflineQueueSummary, OutboxRow } from "./types";

export interface EnqueueInput {
  readonly id?: string;
  readonly kind: OfflineMutationKind;
  readonly groupId: string;
  readonly subjectId: string;
  readonly payload: unknown;
  readonly now?: Date;
  /** Override only for tests. Defaults to the deterministic key. */
  readonly idempotencyKey?: string;
}

export interface ListOutboxFilter {
  readonly groupId?: string;
  readonly states?: readonly OfflineSyncState[];
  readonly limit?: number;
}

function emptyStateCounts(): Record<OfflineSyncState, number> {
  return OFFLINE_SYNC_STATES.reduce((counts, state) => {
    counts[state] = 0;
    return counts;
  }, {} as Record<OfflineSyncState, number>);
}

/**
 * Append a mutation to the queue.
 *
 * The row is written in state `queued` and nothing else. There is no code path
 * that writes `synced` here — only `settleSynced`, which requires a server
 * response. That is what makes "never present an unsynced entry as committed"
 * a structural property rather than a discipline.
 */
export async function enqueue(
  db: SenedDatabase,
  input: EnqueueInput
): Promise<OutboxRow> {
  if (input.payload === undefined) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "An outbox mutation needs a payload");
  }
  const now = (input.now ?? new Date());
  const timestamp = now.toISOString();
  const row: OutboxRow = {
    id: input.id ?? newLocalId(),
    kind: input.kind,
    groupId: input.groupId,
    subjectId: input.subjectId,
    idempotencyKey:
      input.idempotencyKey ??
      createIdempotencyKey({ kind: input.kind, subjectId: input.subjectId, groupId: input.groupId }),
    state: "queued",
    attempts: 0,
    payload: input.payload,
    nextAttemptAt: now.getTime(),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverEntryId: null,
    serverEntryHash: null,
    serverSequence: null,
    attributionOutcome: null,
    attributionError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    settledAt: null
  };

  try {
    const existing = await db.outbox.get(row.id);
    if (existing) {
      if (existing.idempotencyKey !== row.idempotencyKey) {
        throw new SyncError("SYNC_IDEMPOTENCY_CONFLICT", "That mutation is already queued under a different key");
      }
      return existing;
    }
    await db.outbox.put(row);
    return row;
  } catch (error) {
    throw mapStorageError(error, "Queueing an offline mutation");
  }
}

export async function listOutbox(
  db: SenedDatabase,
  filter: ListOutboxFilter = {}
): Promise<OutboxRow[]> {
  let rows: OutboxRow[];
  if (filter.groupId) {
    const query = filter.states
      ? db.outbox.where("[groupId+state]").between(
          [filter.groupId, filter.states[0] ?? "local-draft"],
          [filter.groupId, filter.states[filter.states.length - 1] ?? "queued"]
        )
      : db.outbox.where("groupId").equals(filter.groupId);
    rows = await query.toArray();
  } else {
    rows = await db.outbox.toArray();
  }

  if (filter.states) {
    const allowed = new Set<OfflineSyncState>(filter.states);
    rows = rows.filter((row) => allowed.has(row.state));
  }
  rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return typeof filter.limit === "number" ? rows.slice(0, Math.max(0, filter.limit)) : rows;
}

export async function getOutboxRow(db: SenedDatabase, id: string): Promise<OutboxRow | undefined> {
  return db.outbox.get(id);
}

/** The queue entry carrying a given local row, if there is one. */
export async function findOutboxBySubject(
  db: SenedDatabase,
  subjectId: string
): Promise<OutboxRow | undefined> {
  const rows = await db.outbox.toArray();
  return rows.find((row) => row.subjectId === subjectId);
}

export interface ClaimBatchOptions {
  readonly now: Date;
  readonly limit: number;
  readonly leaseOwner: string;
  readonly leaseMs: number;
}

/**
 * Take a lease on up to `limit` due mutations.
 *
 * Leases, not deletes. A crashed drain leaves rows in `in-flight` with an
 * expired `leaseExpiresAt`, and any device can reclaim them — which is what
 * makes the queue survive a browser crash mid-sync. The whole claim runs in one
 * `readwrite` transaction so two drains cannot both believe they own a row.
 */
export async function claimOutboxBatch(
  db: SenedDatabase,
  options: ClaimBatchOptions
): Promise<OutboxRow[]> {
  const nowMs = options.now.getTime();
  const limit = Math.max(0, options.limit);
  if (limit === 0) {
    return [];
  }

  try {
    return await db.transaction("rw", db.outbox, async () => {
      const all = await db.outbox.toArray();
      const due = all
        .filter((row) => (row.state === "queued" || row.state === "retry-scheduled" || row.state === "in-flight"))
        .filter((row) => row.nextAttemptAt <= nowMs)
        .filter((row) => row.leaseExpiresAt === null || row.leaseExpiresAt <= nowMs)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .slice(0, limit);

      const claimed: OutboxRow[] = [];
      for (const row of due) {
        const next: OutboxRow = {
          ...row,
          state: "in-flight",
          leaseOwner: options.leaseOwner,
          leaseExpiresAt: nowMs + Math.max(1, options.leaseMs),
          updatedAt: new Date(nowMs).toISOString()
        };
        await db.outbox.put(next);
        claimed.push(next);
      }
      return claimed;
    });
  } catch (error) {
    throw mapStorageError(error, "Claiming queued mutations");
  }
}

/** Give a lease back without settling it, so another attempt can pick it up. */
export async function releaseOutboxLease(
  db: SenedDatabase,
  id: string,
  leaseOwner: string,
  now: Date
): Promise<boolean> {
  const row = await db.outbox.get(id);
  if (!row || row.leaseOwner !== leaseOwner) {
    return false;
  }
  await db.outbox.put({
    ...row,
    state: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now.toISOString()
  });
  return true;
}

export interface SettleInput {
  readonly now: Date;
  readonly expectedLeaseOwner?: string;
}

function assertLease(row: OutboxRow, expectedLeaseOwner: string | undefined): void {
  if (expectedLeaseOwner !== undefined && row.leaseOwner !== null && row.leaseOwner !== expectedLeaseOwner) {
    throw new SyncError(
      "SYNC_IDEMPOTENCY_CONFLICT",
      "Another device is already syncing this mutation. Try again once it settles."
    );
  }
}

/**
 * Record a confirmed acceptance.
 *
 * Requires a `serverEntryId` and `serverEntryHash`. A push result that claims
 * success without them is treated as a protocol violation, not a success — an
 * entry the client cannot re-verify later is not evidence of anything.
 */
export async function settleSynced(
  db: SenedDatabase,
  id: string,
  result: SyncPushResult,
  input: SettleInput
): Promise<OutboxRow> {
  if (result.outcome !== "ACCEPTED" && result.outcome !== "REPLAYED") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Only an accepted or replayed result can settle as synced");
  }
  if (!result.serverEntryId || !result.serverEntryHash) {
    throw new SyncError(
      "SYNC_CORRUPT_PAYLOAD",
      "The server reported acceptance without an entry id and hash, so it is not treated as synced"
    );
  }

  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  assertLease(row, input.expectedLeaseOwner);
  const settled: OutboxRow = {
    ...row,
    state: "synced",
    leaseOwner: null,
    leaseExpiresAt: null,
    serverEntryId: result.serverEntryId,
    serverEntryHash: result.serverEntryHash,
    serverSequence: result.serverSequence ?? null,
    // What the server said about the payer riding on this entry. The entry is
    // synced either way; a refused payer is surfaced, never swallowed.
    attributionOutcome: result.attribution?.outcome ?? null,
    attributionError: result.attribution?.outcome === "REFUSED" ? (result.attribution.error ?? null) : null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: input.now.toISOString(),
    settledAt: input.now.toISOString()
  };
  await db.outbox.put(settled);
  return settled;
}

export interface TerminalSettleInput extends SettleInput {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly state: "rejected" | "blocked";
}

/** Terminal failure. The row stays on disk for a person — nothing is deleted. */
export async function settleTerminal(
  db: SenedDatabase,
  id: string,
  input: TerminalSettleInput
): Promise<OutboxRow> {
  if (input.state !== "rejected" && input.state !== "blocked") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "A terminal settle must be rejected or blocked");
  }
  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  assertLease(row, input.expectedLeaseOwner);
  const settled: OutboxRow = {
    ...row,
    state: input.state,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: input.errorCode,
    lastErrorMessage: input.errorMessage,
    updatedAt: input.now.toISOString(),
    settledAt: input.now.toISOString()
  };
  await db.outbox.put(settled);
  return settled;
}

export interface RetrySettleInput extends SettleInput {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly nextAttemptAt: number;
}

/** Transient failure. The payload is untouched, so the retry replays it as-is. */
export async function settleRetry(
  db: SenedDatabase,
  id: string,
  input: RetrySettleInput
): Promise<OutboxRow> {
  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  assertLease(row, input.expectedLeaseOwner);
  const attempts = row.attempts + 1;
  const next: OutboxRow = {
    ...row,
    state: "retry-scheduled",
    attempts,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: input.nextAttemptAt,
    lastErrorCode: input.errorCode,
    lastErrorMessage: input.errorMessage,
    updatedAt: input.now.toISOString()
  };
  await db.outbox.put(next);
  return next;
}

/**
 * Note a non-attempt failure (an unconfigured server, for example).
 *
 * `attempts` is deliberately untouched: retrying against a server that does not
 * exist yet must not burn the treasurer's attempt budget. The lease *is*
 * released and the row returns to `queued`, because leaving it `in-flight`
 * would make the treasurer's own work look like another device is holding it.
 */
export async function annotateUnattempted(
  db: SenedDatabase,
  id: string,
  input: { readonly errorCode: string; readonly errorMessage: string; readonly now: Date }
): Promise<OutboxRow> {
  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  const next: OutboxRow = {
    ...row,
    state: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: input.errorCode,
    lastErrorMessage: input.errorMessage,
    updatedAt: input.now.toISOString()
  };
  await db.outbox.put(next);
  return next;
}

/**
 * Put a terminal row back in the queue after a person fixed the cause.
 *
 * Requires an explicit `reason` so a blocked row is never re-opened by a
 * background timer — that would turn a human decision into an automatic one.
 */
export async function requeueTerminal(
  db: SenedDatabase,
  id: string,
  options: { readonly now: Date; readonly reason: string; readonly resetAttempts?: boolean }
): Promise<OutboxRow> {
  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  if (!isTerminalOfflineSyncState(row.state)) {
    throw new SyncError("SYNC_PROTECTED_ROW", "That mutation is still in flight and cannot be requeued by hand");
  }
  if (options.reason.trim().length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Requeueing a settled mutation needs a written reason");
  }
  const now = options.now;
  const next: OutboxRow = {
    ...row,
    state: "queued",
    attempts: options.resetAttempts === false ? row.attempts : 0,
    nextAttemptAt: now.getTime(),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverEntryId: null,
    serverEntryHash: null,
    serverSequence: null,
    attributionOutcome: null,
    attributionError: null,
    updatedAt: now.toISOString(),
    settledAt: null
  };
  await db.outbox.put(next);
  return next;
}

/**
 * Record the result of retrying a refused attribution against an entry that is
 * already synced. Touches nothing but the attribution fields: the entry's state,
 * ids and hash are the server's and stay as they were.
 */
export async function recordAttributionOutcome(
  db: SenedDatabase,
  id: string,
  outcome: SyncAttributionOutcome,
  error: string | null,
  now: Date
): Promise<OutboxRow> {
  const row = await db.outbox.get(id);
  if (!row) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Queued mutation was not found on this device");
  }
  if (row.state !== "synced") {
    throw new SyncError("SYNC_PROTECTED_ROW", "Only an entry the server already holds can have its payer retried");
  }
  const next: OutboxRow = {
    ...row,
    attributionOutcome: outcome,
    attributionError: outcome === "REFUSED" ? error : null,
    updatedAt: now.toISOString()
  };
  await db.outbox.put(next);
  return next;
}

export async function summarizeQueue(
  db: SenedDatabase,
  groupId?: string
): Promise<OfflineQueueSummary> {
  const rows = await listOutbox(db, groupId ? { groupId } : {});
  const byState = emptyStateCounts();
  let oldestPendingAt: string | null = null;
  for (const row of rows) {
    byState[row.state] += 1;
    const pending = row.state === "queued" || row.state === "retry-scheduled" || row.state === "in-flight";
    if (pending && (oldestPendingAt === null || row.createdAt < oldestPendingAt)) {
      oldestPendingAt = row.createdAt;
    }
  }
  const waiting = byState.queued + byState["retry-scheduled"] + byState["in-flight"];
  return {
    total: rows.length,
    byState,
    oldestPendingAt,
    blockedCount: byState.blocked,
    rejectedCount: byState.rejected,
    quiet: waiting === 0
  };
}
