import { normalizeLedgerEntryRequest } from "@/lib/ledger/rules";
import { LedgerError } from "@/lib/ledger/errors";
import type { LedgerEntryRequest } from "@/lib/ledger/types";
import { SyncError } from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import { createIdempotencyKey, newLocalId } from "./ids";
import { enqueue, findOutboxBySubject, getOutboxRow, type EnqueueInput } from "./outbox";
import type { SenedDatabase } from "./schema";
import type { LedgerDraftRow, OutboxRow } from "./types";

export interface SaveDraftInput {
  readonly id?: string;
  readonly groupId?: string;
  /**
   * An unvalidated ledger request. It is run through A1's
   * `normalizeLedgerEntryRequest` before it touches IndexedDB, so a draft on
   * this phone is balanced and well-typed by exactly the same rules the server
   * applies. That reuse is the whole point: reimplementing "balanced" here
   * would be how an offline device ends up minting an entry the server rejects.
   */
  readonly request: unknown;
  readonly updatedBy: string;
  readonly now?: Date;
}

export interface SaveDraftResult {
  readonly draft: LedgerDraftRow;
  /** The ledger code that rejected the draft, when validation failed. */
  readonly rejectedBy: LedgerError | null;
}

function validateRequest(input: unknown): LedgerEntryRequest {
  try {
    return normalizeLedgerEntryRequest(input);
  } catch (error) {
    if (error instanceof LedgerError) {
      // Re-thrown as a SyncError so offline callers have one error vocabulary,
      // with the ledger's own code preserved for the console to display.
      throw new SyncError("INVALID_DRAFT", `Draft rejected by ledger rule ${error.code}: ${error.message}`, {
        cause: error
      });
    }
    throw error;
  }
}

function requireActor(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "A draft needs the identity of whoever wrote it");
  }
  return value.trim();
}

/**
 * Save a draft entry.
 *
 * The draft's `idempotencyKey` is derived from the draft id, so the same draft
 * always carries the same key to the server no matter how many times the
 * treasurer reloads the page. It lives on the draft row rather than inside
 * `request` so it can be shown next to the entry and matched to the outbox.
 */
export async function saveDraft(db: SenedDatabase, input: SaveDraftInput): Promise<LedgerDraftRow> {
  const request = validateRequest(input.request);
  const updatedBy = requireActor(input.updatedBy);
  const groupId = input.groupId ?? request.groupId;
  if (groupId !== request.groupId) {
    throw new SyncError("INVALID_DRAFT", "A draft's group must match the group on its request");
  }

  const now = (input.now ?? new Date());
  const timestamp = now.toISOString();
  const id = input.id ?? newLocalId();

  try {
    return await db.transaction("rw", db.drafts, async () => {
      const existing = await db.drafts.get(id);
      if (existing && existing.status === "queued") {
        throw new SyncError(
          "SYNC_PROTECTED_ROW",
          "This draft is already queued for sync. Wait for it to settle before editing it."
        );
      }
      const row: LedgerDraftRow = {
        id,
        groupId,
        request,
        status: "draft",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        updatedBy,
        outboxId: null
      };
      await db.drafts.put(row);
      return row;
    });
  } catch (error) {
    if (error instanceof SyncError) {
      throw error;
    }
    throw mapStorageError(error, "Saving a ledger draft");
  }
}

export async function getDraft(db: SenedDatabase, id: string): Promise<LedgerDraftRow | undefined> {
  return db.drafts.get(id);
}

export async function listDrafts(
  db: SenedDatabase,
  groupId?: string
): Promise<LedgerDraftRow[]> {
  const rows = groupId
    ? await db.drafts.where("groupId").equals(groupId).toArray()
    : await db.drafts.toArray();
  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export interface QueueDraftResult {
  readonly draft: LedgerDraftRow;
  readonly outbox: OutboxRow;
}

/**
 * Hand a draft to the outbox.
 *
 * Idempotent: queueing an already-queued draft returns the existing outbox row
 * instead of creating a second one. Without that, a treasurer tapping "sync"
 * twice would post two entries with two different keys and break the chain.
 */
export async function queueDraft(
  db: SenedDatabase,
  draftId: string,
  options: { readonly now?: Date; readonly enqueueOverrides?: Partial<EnqueueInput> } = {}
): Promise<QueueDraftResult> {
  const now = options.now ?? new Date();
  try {
    return await db.transaction("rw", db.drafts, db.outbox, async () => {
      const draft = await db.drafts.get(draftId);
      if (!draft) {
        throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Draft was not found on this device");
      }
      if (draft.status === "queued" && draft.outboxId) {
        const existing = await db.outbox.get(draft.outboxId);
        if (existing) {
          return { draft, outbox: existing };
        }
      }

      const outbox = await enqueue(db, {
        kind: "ledger-draft",
        groupId: draft.groupId,
        subjectId: draft.id,
        payload: draft.request,
        now,
        idempotencyKey: createIdempotencyKey({
          kind: "ledger-draft",
          subjectId: draft.id,
          groupId: draft.groupId
        }),
        ...options.enqueueOverrides
      });

      const queued: LedgerDraftRow = {
        ...draft,
        status: "queued",
        outboxId: outbox.id,
        updatedAt: now.toISOString()
      };
      await db.drafts.put(queued);
      return { draft: queued, outbox };
    });
  } catch (error) {
    if (error instanceof SyncError) {
      throw error;
    }
    throw mapStorageError(error, "Queueing a ledger draft");
  }
}

/** Delete a draft. Refused once it is queued — the queue is the record. */
export async function deleteDraft(db: SenedDatabase, id: string): Promise<void> {
  const draft = await db.drafts.get(id);
  if (!draft) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Draft was not found on this device");
  }
  if (draft.status === "queued") {
    throw new SyncError(
      "SYNC_PROTECTED_ROW",
      "This draft is queued for sync. It can only be removed after it settles."
    );
  }
  await db.drafts.delete(id);
}

/**
 * A draft plus whatever the queue is doing with it.
 *
 * The UI renders from this rather than from the draft alone, so an unsynced
 * entry cannot be drawn as though it were committed: there is exactly one place
 * that knows the sync state and it is the outbox row.
 */
export interface DraftWithQueueState {
  readonly draft: LedgerDraftRow;
  readonly outbox: OutboxRow | null;
}

export async function listDraftsWithQueueState(
  db: SenedDatabase,
  groupId?: string
): Promise<DraftWithQueueState[]> {
  const drafts = await listDrafts(db, groupId);
  const rows = await db.outbox.toArray();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return drafts.map((draft) => ({
    draft,
    outbox: draft.outboxId ? byId.get(draft.outboxId) ?? null : (findIn(rows, draft.id) ?? null)
  }));
}

function findIn(rows: readonly OutboxRow[], draftId: string): OutboxRow | undefined {
  return rows.find((row) => row.subjectId === draftId);
}

export { findOutboxBySubject, getOutboxRow };
