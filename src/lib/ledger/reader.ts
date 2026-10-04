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

/** Mirrors `bank_verification_intents.provider`; kept local so the read side does not import the banking module. */
type BankProvider = "telebirr" | "cbe" | "awash";

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

/**
 * Where an entry came from, when that is a verified bank receipt.
 *
 * Read from `bank_verification_intents` through the SECURITY DEFINER function
 * `get_ledger_entry_provenance_v1`, which any active member of the group may
 * call and which returns only these fields. `memberUserId` is the member whose
 * receipt was verified (not the actor who recorded the entry). There is
 * deliberately no reference field: the stored provider reference is only
 * ciphertext and HMACs, and nothing derived from it is safe to show.
 */
export interface PublicLedgerProvenance {
  readonly kind: "bank_verification";
  readonly provider: BankProvider;
  readonly verifiedAt: string;
  readonly verificationId: string;
  readonly memberUserId: string;
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
  /** `null` for every entry not posted from a verified bank receipt. */
  readonly provenance: PublicLedgerProvenance | null;
}

const BANK_PROVIDERS: readonly BankProvider[] = ["telebirr", "cbe", "awash"];

/** The only entry types the bank-verification sink posts. */
const BANK_POSTED_TYPES: readonly LedgerEntryType[] = ["contribution", "disbursement"];

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
    postings,
    provenance: null
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

  return attachPostings(client, groupId, entries.data);
}

function parseProvenance(value: unknown): PublicLedgerProvenance & { readonly entryId: string } {
  if (!isRecord(value)) {
    throw integrity("Ledger read returned an invalid provenance row");
  }
  const provider = str(value, "provider");
  if (!BANK_PROVIDERS.includes(provider as BankProvider)) {
    throw integrity("Ledger read returned an invalid provenance provider");
  }
  const verifiedAt = str(value, "verifiedAt");
  if (!Number.isFinite(Date.parse(verifiedAt))) {
    throw integrity("Ledger read returned an invalid provenance time");
  }
  // Only the named fields are copied: whatever else a row carried is dropped.
  return {
    entryId: uuid(value, "entryId"),
    kind: "bank_verification",
    provider: provider as BankProvider,
    verifiedAt,
    verificationId: uuid(value, "verificationId"),
    memberUserId: uuid(value, "memberUserId")
  };
}

/**
 * Bank-verification provenance for the given entries, keyed by entry id.
 *
 * Only contribution and disbursement entries can come from the sink, so other
 * entries are not asked about. The RPC re-checks group membership itself.
 */
async function readProvenance(
  client: SupabaseClient,
  groupId: string,
  rows: readonly Record<string, unknown>[]
): Promise<ReadonlyMap<string, PublicLedgerProvenance>> {
  const candidates = rows
    .filter((row) => BANK_POSTED_TYPES.includes(row.entry_type as LedgerEntryType))
    .map((row) => uuid(row, "id"));
  const found = new Map<string, PublicLedgerProvenance>();
  if (candidates.length === 0) {
    return found;
  }
  const result = await client.rpc("get_ledger_entry_provenance_v1", {
    p_group_id: groupId,
    p_entry_ids: candidates
  });
  if (result.error) {
    throw storageFailure(result.error);
  }
  if (!Array.isArray(result.data)) {
    throw integrity("Ledger read returned an invalid provenance list");
  }
  for (const raw of result.data) {
    const { entryId, ...provenance } = parseProvenance(raw);
    if (!candidates.includes(entryId) || found.has(entryId)) {
      throw integrity("Ledger read returned provenance for an entry it was not asked about");
    }
    found.set(entryId, provenance);
  }
  return found;
}

/** Fetch the postings and provenance for already-read entry rows and join them on. */
async function attachPostings(
  client: SupabaseClient,
  groupId: string,
  rows: readonly unknown[]
): Promise<readonly PublicLedgerEntry[]> {
  const entryIds = rows.map((row) => uuid(isRecord(row) ? row : {}, "id"));
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
  const provenance = await readProvenance(
    client,
    groupId,
    rows.map((row) => (isRecord(row) ? row : {}))
  );
  return rows.map((row) => {
    const parsed = parseEntry(row, []);
    const entryPostings = byEntry.get(parsed.id);
    if (!entryPostings || entryPostings.length === 0) {
      throw integrity("Ledger entry has no postings");
    }
    return { ...parsed, postings: entryPostings, provenance: provenance.get(parsed.id) ?? null };
  });
}

/** The server's chain head for one group, as the sync pull reports it. */
export interface PublicLedgerChainHead {
  readonly groupId: string;
  readonly tenantId: string;
  readonly lastSequence: string;
  readonly lastHash: string;
}

export interface LedgerChainSlice {
  readonly head: PublicLedgerChainHead;
  /** Ascending by sequence, every sequence in `(since, head.lastSequence]`. */
  readonly entries: readonly PublicLedgerEntry[];
  readonly hasMore: boolean;
}

/**
 * A contiguous, hash-linked slice of one group's chain for the offline pull:
 * entries with `sequence > sinceSequence`, ascending, at most `limit`, never
 * past the head read in the same call (so the head and the slice describe one
 * snapshot even while another device is appending).
 *
 * Runs under the caller's JWT and the tables' own `select` policies. `null`
 * means the caller cannot see the group's head (absent and not-yours are the
 * same answer). The slice is checked for gaps and broken `previousHash` links
 * before it is returned: a chain the server cannot vouch for is an integrity
 * failure, never a page the client is asked to trust.
 */
export async function readLedgerChainSlice(
  client: SupabaseClient,
  groupId: string,
  sinceSequence: string,
  limit: number
): Promise<LedgerChainSlice | null> {
  const headResult = await client
    .from("ledger_group_heads")
    .select("group_id, tenant_id, last_sequence, last_hash")
    .eq("group_id", groupId)
    .maybeSingle();
  if (headResult.error) {
    throw storageFailure(headResult.error);
  }
  if (!headResult.data) {
    return null;
  }
  const headRow = isRecord(headResult.data) ? headResult.data : {};
  const head: PublicLedgerChainHead = {
    groupId: uuid(headRow, "group_id"),
    tenantId: uuid(headRow, "tenant_id"),
    lastSequence: numeric(headRow, "last_sequence"),
    lastHash: str(headRow, "last_hash")
  };

  const rows = await client
    .from("ledger_entries")
    .select(ENTRY_COLUMNS)
    .eq("group_id", groupId)
    .gt("sequence", sinceSequence)
    .lte("sequence", head.lastSequence)
    .order("sequence", { ascending: true })
    .limit(limit + 1);
  if (rows.error) {
    throw storageFailure(rows.error);
  }
  if (!Array.isArray(rows.data)) {
    throw integrity("Ledger read returned an invalid entry list");
  }
  const hasMore = rows.data.length > limit;
  const page = hasMore ? rows.data.slice(0, limit) : rows.data;
  if (page.length === 0) {
    return { head, entries: [], hasMore: false };
  }

  const entries = await attachPostings(client, groupId, page);
  let expectedSequence: bigint | null = null;
  let previous: PublicLedgerEntry | null = null;
  for (const entry of entries) {
    const sequence = BigInt(entry.sequence);
    if (expectedSequence !== null && sequence !== expectedSequence) {
      throw integrity("Ledger slice has a gap in its sequence");
    }
    if (previous !== null && entry.previousHash !== previous.entryHash) {
      throw integrity("Ledger slice has a broken previous-hash link");
    }
    expectedSequence = sequence + 1n;
    previous = entry;
  }
  if (previous !== null && previous.sequence === head.lastSequence && previous.entryHash !== head.lastHash) {
    throw integrity("Ledger head does not match its last entry");
  }
  return { head, entries, hasMore };
}
