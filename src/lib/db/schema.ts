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
export const DATABASE_SCHEMA_VERSION = 3;

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
    const stores = {
      roster: "id, groupId, [groupId+displayName], updatedAt",
      spokenNotes: "id, groupId, memberId, [groupId+occurredAt], createdAt",
      drafts: "id, groupId, [groupId+status], idempotencyKey, updatedAt",
      outbox: "id, [state+nextAttemptAt], [groupId+state], kind, createdAt, idempotencyKey",
      ledgerMirror: "id, groupId, [groupId+sequenceNumber], [groupId+entryHash]",
      syncMeta: "key, groupId"
    };
    this.version(1).stores(stores);

    // Version 2 (payer attribution on a draft): no index changes. The upgrade
    // gives every existing row an explicit "no payer / no attribution result"
    // value, so a draft saved before it stays valid and is sent exactly as it
    // always was. Nothing is deleted or rewritten otherwise.
    this.version(2)
      .stores(stores)
      .upgrade(async (transaction) => {
        await transaction
          .table("drafts")
          .toCollection()
          .modify((draft: { attribution?: unknown }) => {
            if (draft.attribution === undefined) {
              draft.attribution = null;
            }
          });
        await transaction
          .table("outbox")
          .toCollection()
          .modify((row: { attributionOutcome?: unknown; attributionError?: unknown }) => {
            if (row.attributionOutcome === undefined) {
              row.attributionOutcome = null;
            }
            if (row.attributionError === undefined) {
              row.attributionError = null;
            }
          });
      });

    // Version 3 (payment channel + note on a draft's payer, and automatic retry of a
    // payer that did not record): no index changes.
    //  - A draft's `attribution` may now carry `channel` and `note`. Both are
    //    OPTIONAL and an absent one means "none", so every draft saved before this
    //    stays valid and syncs byte-for-byte as it did; drafts are not rewritten.
    //  - Every outbox row gets `attributionAttempts: 0` and `attributionNextAttemptAt:
    //    null`. A row that synced but whose payer was never confirmed is therefore due
    //    for the automatic retry (0 attempts used, nothing scheduled), and one the
    //    server answered definitively stays in need of a person. Nothing is deleted.
    this.version(DATABASE_SCHEMA_VERSION)
      .stores(stores)
      .upgrade(async (transaction) => {
        await transaction
          .table("outbox")
          .toCollection()
          .modify((row: { attributionAttempts?: unknown; attributionNextAttemptAt?: unknown }) => {
            if (row.attributionAttempts === undefined) {
              row.attributionAttempts = 0;
            }
            if (row.attributionNextAttemptAt === undefined) {
              row.attributionNextAttemptAt = null;
            }
          });
      });
  }
}

export function createSenedDatabase(name?: string): SenedDatabase {
  return new SenedDatabase(name ?? DEFAULT_DATABASE_NAME);
}
