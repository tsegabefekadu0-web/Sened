import type { SupabaseClient } from "@supabase/supabase-js";

import { LedgerError } from "./errors";
import { formatEtbAmount } from "./money";
import { isUuid } from "./rules";
import {
  LEDGER_ENTRY_TYPES,
  LEDGER_POSTING_DIRECTIONS,
  type LedgerEntryType,
  type LedgerPostingDirection
} from "./types";

/**
 * The read side of the ledger: a group's entries, newest first, with postings.
 *
 * Runs under the caller's JWT against the tables' own `select` policies
 * (`sened_ledger_can_access_group`), so tenant isolation is Postgres's job and
 * not this file's. Nothing here widens that: no service role, no RPC.
 *
 * A row that does not parse is an error, not a skipped row. The two client
 * reads before this one drop malformed rows because they list *options*; this
 * lists the *record*, and a history with a silently missing line is worse than
 * a refused one.
 */

export interface PublicLedgerPosting {
  readonly id: string;
  readonly ordinal: number;
  readonly accountId: string;
  readonly direction: LedgerPostingDirection;
  readonly amount: string;
}

/** What the browser sees. No tenant id, request fingerprint or idempotency key. */
export interface PublicLedgerEntry {
  readonly id: string;
  readonly groupId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly entryType: LedgerEntryType;
  readonly correctsEntryId: string | null;
  readonly rationale: string | null;
  readonly actorId: string;
  readonly nonce: string;
  readonly previousHash: string;
  readonly entryHash: string;
  readonly postings: readonly PublicLedgerPosting[];
}

const ENTRY_COLUMNS =
  "id, group_id, sequence, occurred_at, recorded_at, entry_type, corrects_entry_id, rationale, actor_id, nonce, previous_hash, entry_hash";
const POSTING_COLUMNS = "id, entry_id, account_id, direction, amount, ordinal";

function integrity(message: string): LedgerError {
  return new LedgerError("INTEGRITY_FAILURE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw integrity(`Ledger read returned an invalid ${key}`);
  }
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw integrity(`Ledger read returned an invalid ${key}`);
  }
  return value;
}

/** PostgREST renders bigint and numeric as JSON numbers; accept either form. */
function numeric(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw integrity(`Ledger read returned an invalid ${key}`);
}

function uuid(row: Record<string, unknown>, key: string): string {
  const value = str(row, key);
  if (!isUuid(value)) {
    throw integrity(`Ledger read returned an invalid ${key}`);
  }
  return value.toLowerCase();
}

function parsePosting(value: unknown): PublicLedgerPosting & { readonly entryId: string } {
  if (!isRecord(value)) {
    throw integrity("Ledger read returned an invalid posting");
  }
  const direction = str(value, "direction");
  if (!LEDGER_POSTING_DIRECTIONS.includes(direction as LedgerPostingDirection)) {
    throw integrity("Ledger read returned an invalid direction");
  }
  const ordinal = value.ordinal;
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)) {
    throw integrity("Ledger read returned an invalid ordinal");
  }
  let amount: string;
  try {
    amount = formatEtbAmount(numeric(value, "amount"));
  } catch {
    throw integrity("Ledger read returned an invalid amount");
  }
  return {
    id: uuid(value, "id"),
    entryId: uuid(value, "entry_id"),
    ordinal,
    accountId: uuid(value, "account_id"),
    direction: direction as LedgerPostingDirection,
    amount
  };
}

function parseEntry(value: unknown, postings: readonly PublicLedgerPosting[]): PublicLedgerEntry {
  if (!isRecord(value)) {
    throw integrity("Ledger read returned an invalid entry");
  }
  const entryType = str(value, "entry_type");
  if (!LEDGER_ENTRY_TYPES.includes(entryType as LedgerEntryType)) {
    throw integrity("Ledger read returned an invalid entry_type");
  }
  const correctsRaw = nullableStr(value, "corrects_entry_id");
  return {
    id: uuid(value, "id"),
    groupId: uuid(value, "group_id"),
    sequence: numeric(value, "sequence"),
    occurredAt: str(value, "occurred_at"),
    recordedAt: str(value, "recorded_at"),
    entryType: entryType as LedgerEntryType,
    correctsEntryId: correctsRaw === null ? null : correctsRaw.toLowerCase(),
    rationale: nullableStr(value, "rationale"),
    actorId: uuid(value, "actor_id"),
    nonce: uuid(value, "nonce"),
    previousHash: str(value, "previous_hash"),
    entryHash: str(value, "entry_hash"),
    postings
  };
}

function storageFailure(cause: unknown): LedgerError {
  return new LedgerError("STORAGE_FAILURE", "Ledger read failed", cause);
}

/**
 * The newest `limit` entries of one group, or `null` when the caller cannot see
 * the group. Row-level security makes "not yours" and "does not exist" the same
 * answer, which is the point: neither is distinguishable from outside.
 */
export async function listGroupLedgerEntries(
  client: SupabaseClient,
  groupId: string,
  limit: number
): Promise<readonly PublicLedgerEntry[] | null> {
  const group = await client.from("ledger_groups").select("id").eq("id", groupId).maybeSingle();
  if (group.error) {
    throw storageFailure(group.error);
  }
  if (!group.data) {
    return null;
  }

  const entries = await client
    .from("ledger_entries")
    .select(ENTRY_COLUMNS)
    .eq("group_id", groupId)
    .order("sequence", { ascending: false })
    .limit(limit);
  if (entries.error) {
    throw storageFailure(entries.error);
  }
  if (!Array.isArray(entries.data)) {
    throw integrity("Ledger read returned an invalid entry list");
  }
  if (entries.data.length === 0) {
    return [];
  }

  const entryIds = entries.data.map((row) => uuid(isRecord(row) ? row : {}, "id"));
  const postings = await client
    .from("ledger_entry_postings")
    .select(POSTING_COLUMNS)
    .eq("group_id", groupId)
    .in("entry_id", entryIds)
    .order("ordinal", { ascending: true });
  if (postings.error) {
    throw storageFailure(postings.error);
  }
  if (!Array.isArray(postings.data)) {
    throw integrity("Ledger read returned an invalid posting list");
  }

  const byEntry = new Map<string, PublicLedgerPosting[]>();
  for (const raw of postings.data) {
    const { entryId, ...posting } = parsePosting(raw);
    byEntry.set(entryId, [...(byEntry.get(entryId) ?? []), posting]);
  }
  return entries.data.map((row) => {
    const parsed = parseEntry(row, []);
    const entryPostings = byEntry.get(parsed.id);
    if (!entryPostings || entryPostings.length === 0) {
      throw integrity("Ledger entry has no postings");
    }
    return { ...parsed, postings: entryPostings };
  });
}
