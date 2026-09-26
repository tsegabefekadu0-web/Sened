import type { SyncDivergence, SyncDivergenceResolution } from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import type { SenedDatabase } from "./schema";
import { GLOBAL_SYNC_META_KEY, syncMetaKey, type SyncMetaRow } from "./types";

function emptyRow(groupId: string, now: string): SyncMetaRow {
  return {
    key: syncMetaKey(groupId),
    groupId,
    lastPulledSequence: "0",
    lastPulledHash: null,
    lastPullAt: null,
    lastSyncedAt: null,
    divergence: null,
    updatedAt: now
  };
}

export async function readSyncMeta(db: SenedDatabase, groupId: string): Promise<SyncMetaRow> {
  const existing = await db.syncMeta.get(syncMetaKey(groupId));
  return existing ?? emptyRow(groupId, new Date().toISOString());
}

async function put(db: SenedDatabase, row: SyncMetaRow): Promise<SyncMetaRow> {
  try {
    await db.syncMeta.put(row);
    return row;
  } catch (error) {
    throw mapStorageError(error, "Saving sync progress");
  }
}

export async function writeSyncMeta(db: SenedDatabase, row: SyncMetaRow): Promise<SyncMetaRow> {
  return put(db, row);
}

export interface RecordPullInput {
  readonly groupId: string;
  readonly sequence: string;
  readonly hash: string | null;
  readonly at: Date;
}

/**
 * Move the pull cursor forward.
 *
 * Only ever forward. A pull that somehow returns an older head must not rewind
 * the cursor, or the next sync would re-request entries the device already
 * holds and the treasurer would watch the same rows arrive twice.
 */
export async function recordPullProgress(
  db: SenedDatabase,
  input: RecordPullInput
): Promise<SyncMetaRow> {
  const current = await readSyncMeta(db, input.groupId);
  const currentSequence = BigInt(current.lastPulledSequence);
  const nextSequence = BigInt(input.sequence);
  if (nextSequence <= currentSequence) {
    return current;
  }
  return put(db, {
    ...current,
    lastPulledSequence: nextSequence.toString(),
    lastPulledHash: input.hash,
    lastPullAt: input.at.toISOString(),
    updatedAt: input.at.toISOString()
  });
}

export async function recordSyncActivity(
  db: SenedDatabase,
  groupId: string,
  at: Date
): Promise<SyncMetaRow> {
  const current = await readSyncMeta(db, groupId);
  return put(db, { ...current, lastSyncedAt: at.toISOString(), updatedAt: at.toISOString() });
}

/**
 * Record an unresolved fork.
 *
 * Recording is idempotent on `forkSequence` so a flapping network does not
 * produce a wall of duplicate warnings for one real disagreement.
 */
export async function recordDivergence(
  db: SenedDatabase,
  divergence: SyncDivergence
): Promise<SyncMetaRow> {
  const current = await readSyncMeta(db, divergence.groupId);
  if (
    current.divergence &&
    current.divergence.forkSequence === divergence.forkSequence &&
    current.divergence.kind === divergence.kind
  ) {
    return current;
  }
  return put(db, { ...current, divergence, updatedAt: divergence.detectedAt });
}

export async function readDivergence(
  db: SenedDatabase,
  groupId: string
): Promise<SyncDivergence | null> {
  return (await readSyncMeta(db, groupId)).divergence;
}

/**
 * Close a fork by recording a person's decision.
 *
 * This is bookkeeping only. It marks the fork resolved and stops the console
 * from pushing on top of an unknown head. It does **not** delete the local
 * mirror, re-parent an entry, or recompute a hash — those belong to the server
 * and to a human reconciliation, and doing them here would be exactly the
 * "quietly fix shared code" move this repo forbids.
 */
export async function resolveDivergence(
  db: SenedDatabase,
  groupId: string,
  resolution: SyncDivergenceResolution,
  at: Date,
  options: { readonly note?: string } = {}
): Promise<SyncMetaRow> {
  const current = await readSyncMeta(db, groupId);
  if (!current.divergence) {
    throw new Error("There is no recorded divergence to resolve for this group");
  }
  const detail = options.note?.trim()
    ? `${current.divergence.detail} · ${options.note.trim()}`
    : current.divergence.detail;
  return put(db, {
    ...current,
    divergence: {
      ...current.divergence,
      detail,
      resolution,
      resolvedAt: at.toISOString()
    },
    updatedAt: at.toISOString()
  });
}

export async function listSyncMetaRows(db: SenedDatabase): Promise<SyncMetaRow[]> {
  return db.syncMeta.toArray();
}

export const GLOBAL_SCOPE_KEY = GLOBAL_SYNC_META_KEY;
