import Dexie, { type Table } from "dexie";
import type {
  LedgerDraftRow,
  LedgerMirrorRow,
  OutboxRow,
  RosterMemberRow,
  SpokenNoteRow,
  SyncMetaRow
} from "./types";

export const DEFAULT_DATABASE_NAME = "sened-offline";
export const DATABASE_SCHEMA_VERSION = 1;

/**
 * The treasurer's offline store.
 *
 * `declare` (not `!`) on the table fields is required: with `target: ES2022`
 * TypeScript enables `useDefineForClassFields`, and a non-initialised field
 * declaration would emit `Object.defineProperty(this, "roster", { value:
 * undefined })` in the constructor, clobbering the tables Dexie assigns. See
 * `docs/architecture/offline-pwa.md` §5.
 */
export class SenedDatabase extends Dexie {
  declare roster: Table<RosterMemberRow, string>;
  declare spokenNotes: Table<SpokenNoteRow, string>;
  declare drafts: Table<LedgerDraftRow, string>;
  declare outbox: Table<OutboxRow, string>;
  declare ledgerMirror: Table<LedgerMirrorRow, string>;
  declare syncMeta: Table<SyncMetaRow, string>;

  constructor(name: string = DEFAULT_DATABASE_NAME) {
    super(name);

    // IndexedDB cannot order decimal strings numerically. `sequenceNumber` is a
    // safe-integer mirror of `sequence` purely so the chain can be walked in
    // order; `sequence` remains the authoritative value and is what the
    // divergence check compares.
    this.version(DATABASE_SCHEMA_VERSION).stores({
      roster: "id, groupId, [groupId+displayName], updatedAt",
      spokenNotes: "id, groupId, memberId, [groupId+occurredAt], createdAt",
      drafts: "id, groupId, [groupId+status], idempotencyKey, updatedAt",
      outbox: "id, [state+nextAttemptAt], [groupId+state], kind, createdAt, idempotencyKey",
      ledgerMirror: "id, groupId, [groupId+sequenceNumber], [groupId+entryHash]",
      syncMeta: "key, groupId"
    });
  }
}

export function createSenedDatabase(name?: string): SenedDatabase {
  return new SenedDatabase(name ?? DEFAULT_DATABASE_NAME);
}
