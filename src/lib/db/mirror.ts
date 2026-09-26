import type { LedgerChainHeadLike, LedgerEntryLike } from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import type { SenedDatabase } from "./schema";
import type { LedgerMirrorRow } from "./types";

/**
 * The local read model of the server's chain.
 *
 * **Append-only, like the ledger itself.** `storeMirrorEntries` never updates
 * or deletes an existing `(groupId, sequence)` row. If the server hands back a
 * *different* hash for a sequence this device already holds, the write is
 * refused and the caller is expected to record a divergence — because a
 * same-height, different-hash disagreement is the one thing an append-only hash
 * chain cannot resolve, and quietly overwriting it would destroy the evidence.
 */
export interface StoreMirrorResult {
  readonly added: readonly LedgerMirrorRow[];
  /** Sequences this device already held with exactly this hash. */
  readonly unchanged: number;
  /** Sequences where the server disagrees with what we hold. Never applied. */
  readonly conflicting: readonly { sequence: string; localHash: string; incomingHash: string }[];
  /**
   * Entries that do not link onto the head this device already holds. Also never
   * applied — writing them would corrupt the one local read model a treasurer
   * can trust without a network.
   */
  readonly unlinked: readonly { sequence: string; expectedPreviousHash: string; receivedPreviousHash: string }[];
}

export interface StoreMirrorInput {
  readonly groupId: string;
  readonly entries: readonly LedgerEntryLike[];
  readonly pulledAt: Date;
}

function safeSequenceNumber(sequence: string): number {
  if (!/^[0-9]+$/.test(sequence)) {
    throw new Error(`Ledger sequence must be a decimal string, received "${sequence}"`);
  }
  const value = BigInt(sequence);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    // Ordering relies on a numeric sort key. Beyond 2^53 that key would be
    // wrong, and a chain that long is not something this client can honestly
    // mirror. Refuse rather than store a subtly incorrect order.
    throw new Error(`Ledger sequence ${sequence} exceeds the local mirror's safe ordering range`);
  }
  return Number(value);
}

export async function storeMirrorEntries(
  db: SenedDatabase,
  input: StoreMirrorInput
): Promise<StoreMirrorResult> {
  const pulledAt = input.pulledAt.toISOString();
  const added: LedgerMirrorRow[] = [];
  const conflicting: { sequence: string; localHash: string; incomingHash: string }[] = [];
  const unlinked: { sequence: string; expectedPreviousHash: string; receivedPreviousHash: string }[] = [];
  let unchanged = 0;

  try {
    await db.transaction("rw", db.ledgerMirror, async () => {
      // The head this device already trusts. New entries must link onto it, or
      // they do not go in — see the loop below.
      let head: LedgerMirrorRow | null = null;
      const mirror = await db.ledgerMirror.where("groupId").equals(input.groupId).toArray();
      if (mirror.length > 0) {
        head = mirror.reduce((latest, row) => (row.sequenceNumber > latest.sequenceNumber ? row : latest));
      }

      for (const entry of input.entries) {
        if (entry.groupId !== input.groupId) {
          throw new Error("Refusing to mirror an entry that belongs to a different group");
        }
        const sequenceNumber = safeSequenceNumber(entry.sequence);
        // Look the row up by (groupId, sequence), **not** by entry id. A server
        // that rewrote history would issue a fresh entry id for a sequence we
        // already hold, and an id-keyed lookup would happily store a second row
        // at the same height — the exact corruption the fork check exists to
        // catch.
        const existing = await db.ledgerMirror
          .where("[groupId+sequenceNumber]")
          .equals([entry.groupId, sequenceNumber])
          .first();
        if (existing) {
          if (existing.entryHash === entry.entryHash && existing.id === entry.id) {
            unchanged += 1;
          } else {
            conflicting.push({
              sequence: entry.sequence,
              localHash: existing.entryHash,
              incomingHash: entry.entryHash
            });
          }
          continue;
        }

        if (head) {
          const expectedSequence = BigInt(head.sequence) + 1n;
          const isNextSlot = BigInt(entry.sequence) === expectedSequence;
          if (!isNextSlot || entry.previousHash !== head.entryHash) {
            // Either a gap we cannot verify, or an entry that does not descend
            // from the head we hold. Storing it would make the offline read
            // model a mixture of two histories, so it is refused and reported.
            unlinked.push({
              sequence: entry.sequence,
              expectedPreviousHash: head.entryHash,
              receivedPreviousHash: entry.previousHash
            });
            break;
          }
        }

        const row: LedgerMirrorRow = {
          id: entry.id,
          groupId: entry.groupId,
          sequence: entry.sequence,
          sequenceNumber,
          entryHash: entry.entryHash,
          previousHash: entry.previousHash,
          occurredAt: entry.occurredAt,
          recordedAt: entry.recordedAt,
          entryType: entry.entryType,
          entry,
          pulledAt
        };
        await db.ledgerMirror.put(row);
        head = row;
        added.push(row);
      }
    });
  } catch (error) {
    throw mapStorageError(error, "Mirroring ledger entries");
  }

  return { added, unchanged, conflicting, unlinked };
}

/** The whole mirrored chain for a group, in sequence order. */
export async function listMirrorChain(
  db: SenedDatabase,
  groupId: string
): Promise<LedgerMirrorRow[]> {
  const rows = await db.ledgerMirror.where("groupId").equals(groupId).toArray();
  return rows.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

export interface LocalChainHead {
  readonly sequence: string;
  readonly hash: string;
}

/** The head this device can prove it holds, or null when nothing is mirrored. */
export async function getLocalChainHead(
  db: SenedDatabase,
  groupId: string
): Promise<LocalChainHead | null> {
  const rows = await listMirrorChain(db, groupId);
  const last = rows[rows.length - 1];
  return last ? { sequence: last.sequence, hash: last.entryHash } : null;
}

/** Build the `LedgerChainHead` shape from the local mirror, for the contract. */
export async function localChainHeadFor(
  db: SenedDatabase,
  groupId: string,
  tenantId: string
): Promise<LedgerChainHeadLike | null> {
  const head = await getLocalChainHead(db, groupId);
  return head ? { groupId, tenantId, lastSequence: head.sequence, lastHash: head.hash } : null;
}

export async function getMirrorRow(
  db: SenedDatabase,
  id: string
): Promise<LedgerMirrorRow | undefined> {
  return db.ledgerMirror.get(id);
}
