import type { SupabaseClient } from "@supabase/supabase-js";

import { isMaskedReference } from "../banking/referenceMask";
import { LedgerError } from "./errors";
import { formatEtbAmount } from "./money";
import { isUuid } from "./rules";
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_ENTRY_TYPES,
  LEDGER_POSTING_DIRECTIONS,
  type LedgerAccountType,
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
 * not this file's. Nothing here widens that: no service role, and the two RPCs
 * (provenance, balances) are SECURITY DEFINER functions that re-check group
 * membership themselves.
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
 * receipt was verified (not the actor who recorded the entry).
 *
 * `referenceMasked` is the only form of the bank reference that ever leaves the
 * database: four bullets and the last 1-4 characters (`••••2F42`, rule in
 * `banking/referenceMask.ts`), stored at intent creation. `null` for a
 * verification recorded before it existed and not yet backfilled. The reader
 * accepts nothing else: a value that is not exactly the masked shape is an
 * integrity failure, never passed on.
 */
export interface PublicLedgerProvenance {
  readonly kind: "bank_verification";
  readonly provider: BankProvider;
  readonly verifiedAt: string;
  readonly verificationId: string;
  readonly memberUserId: string;
  readonly referenceMasked: string | null;
}

/**
 * Who paid a contribution, and how the ledger knows.
 *
 * `source` is the whole point: `bank_verification` means a verified bank receipt
 * names the payer (the same fact as `provenance`); `treasurer` means an owner or
 * treasurer RECORDED who paid an entry that has no bank provenance, which is the
 * treasurer's statement and never a verification. Bank provenance outranks a
 * treasurer's record (the database picks it), so a row is never shown as the
 * weaker thing when the stronger exists.
 *
 * Read through `get_ledger_entry_attributions_v1`. The attribution lives beside
 * the hash-chained entry and is not part of `entryHash`. `revision` counts the
 * records in the entry's history (1 = never corrected; each correction is a new
 * record with a `reason`, and none is ever edited or deleted). `recordedBy` is
 * the actor who recorded the entry for a bank-verified row, and the treasurer
 * who recorded the attribution otherwise. `cycleId` and `round` say which round
 * of which cycle the payment is for, when the treasurer said so.
 */
export interface PublicLedgerAttribution {
  readonly source: "bank_verification" | "treasurer";
  readonly memberUserId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly cycleId: string | null;
  readonly round: number | null;
  readonly revision: number;
  readonly reason: string | null;
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
  /**
   * Who paid, when anyone has said so: bank provenance, else the treasurer's
   * record. `null` for a contribution nobody has attributed and for every entry
   * that is not a contribution.
   */
  readonly attribution: PublicLedgerAttribution | null;
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
    provenance: null,
    attribution: null
  };
}

function storageFailure(cause: unknown): LedgerError {
  return new LedgerError("STORAGE_FAILURE", "Ledger read failed", cause);
}

/** One page of a group's entries, newest first, with the cursor for the next (older) page. */
export interface PublicLedgerEntryPage {
  readonly entries: readonly PublicLedgerEntry[];
  /** True when entries older than this page's oldest exist. */
  readonly hasMore: boolean;
  /**
   * The `beforeSequence` value that fetches the next page (this page's lowest
   * sequence), or `null` on the last page.
   */
  readonly nextCursor: string | null;
}

/**
 * One page of one group's entries, newest first, or `null` when the caller
 * cannot see the group. Row-level security makes "not yours" and "does not
 * exist" the same answer, which is the point: neither is distinguishable from
 * outside.
 *
 * `beforeSequence` is an exclusive upper bound on sequence (a keyset cursor, not
 * an offset): the chain is append-only and sequences only grow, so a cursor
 * stays valid while other devices append, and no entry is skipped or repeated
 * across pages. One extra row is read to know whether a further page exists.
 */
export async function readGroupLedgerPage(
  client: SupabaseClient,
  groupId: string,
  options: { readonly limit: number; readonly beforeSequence?: string | null }
): Promise<PublicLedgerEntryPage | null> {
  const group = await client.from("ledger_groups").select("id").eq("id", groupId).maybeSingle();
  if (group.error) {
    throw storageFailure(group.error);
  }
  if (!group.data) {
    return null;
  }

  let query = client.from("ledger_entries").select(ENTRY_COLUMNS).eq("group_id", groupId);
  if (options.beforeSequence !== undefined && options.beforeSequence !== null) {
    query = query.lt("sequence", options.beforeSequence);
  }
  const entries = await query.order("sequence", { ascending: false }).limit(options.limit + 1);
  if (entries.error) {
    throw storageFailure(entries.error);
  }
  if (!Array.isArray(entries.data)) {
    throw integrity("Ledger read returned an invalid entry list");
  }
  const hasMore = entries.data.length > options.limit;
  const rows = hasMore ? entries.data.slice(0, options.limit) : entries.data;
  if (rows.length === 0) {
    return { entries: [], hasMore: false, nextCursor: null };
  }

  const page = await attachPostings(client, groupId, rows);
  return { entries: page, hasMore, nextCursor: hasMore ? page[page.length - 1].sequence : null };
}

/** The newest `limit` entries of one group, or `null` when the caller cannot see the group. */
export async function listGroupLedgerEntries(
  client: SupabaseClient,
  groupId: string,
  limit: number
): Promise<readonly PublicLedgerEntry[] | null> {
  const page = await readGroupLedgerPage(client, groupId, { limit });
  return page === null ? null : page.entries;
}

export interface PublicLedgerAccountBalance {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: LedgerAccountType;
  /** ETB, exact, two decimals, debit-positive (debits minus credits) for every account type. */
  readonly balance: string;
}

/** Every account's balance at one chain head, from `get_ledger_balances_v1`. */
export interface PublicLedgerBalances {
  readonly groupId: string;
  /** Sequence of the newest entry the balances include (`"0"` for an empty ledger). */
  readonly headSequence: string;
  /** Entries the balances were computed over. */
  readonly entryCount: string;
  readonly balances: readonly PublicLedgerAccountBalance[];
}

const COUNT = /^(0|[1-9]\d{0,18})$/;
const SIGNED_AMOUNT = /^-?\d+\.\d{2}$/;

function parseBalances(value: unknown, groupId: string): PublicLedgerBalances {
  if (!isRecord(value)) {
    throw integrity("Ledger balances returned an invalid body");
  }
  if (uuid(value, "groupId") !== groupId) {
    throw integrity("Ledger balances returned another group");
  }
  const headSequence = str(value, "headSequence");
  const entryCount = str(value, "entryCount");
  if (!COUNT.test(headSequence) || !COUNT.test(entryCount)) {
    throw integrity("Ledger balances returned an invalid head or count");
  }
  const raw = value.balances;
  if (!Array.isArray(raw)) {
    throw integrity("Ledger balances returned an invalid account list");
  }
  const seen = new Set<string>();
  const balances = raw.map((item): PublicLedgerAccountBalance => {
    if (!isRecord(item)) {
      throw integrity("Ledger balances returned an invalid account");
    }
    const accountId = uuid(item, "accountId");
    const accountType = str(item, "accountType");
    const balance = str(item, "balance");
    if (seen.has(accountId) || !LEDGER_ACCOUNT_TYPES.includes(accountType as LedgerAccountType) || !SIGNED_AMOUNT.test(balance)) {
      throw integrity("Ledger balances returned an invalid account");
    }
    seen.add(accountId);
    return { accountId, code: str(item, "code"), name: str(item, "name"), accountType: accountType as LedgerAccountType, balance };
  });
  return { groupId, headSequence, entryCount, balances };
}

/**
 * Per-account balances for one group at one chain head, or `null` when the
 * caller is not a member (the function refuses; absent and not-yours are the
 * same answer). Runs `get_ledger_balances_v1` under the caller's JWT; the
 * function computes head, count and balances in a single statement, so they
 * describe one snapshot.
 */
export async function readLedgerBalances(
  client: SupabaseClient,
  groupId: string
): Promise<PublicLedgerBalances | null> {
  const result = await client.rpc("get_ledger_balances_v1", { p_group_id: groupId });
  if (result.error) {
    const message = typeof result.error.message === "string" ? result.error.message : "";
    if (message.includes("ledger_forbidden") || result.error.code === "42501") {
      return null;
    }
    throw storageFailure(result.error);
  }
  return parseBalances(result.data, groupId);
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
  // Absent (a database one migration behind) and null both mean "no reference
  // shown"; anything else must be exactly the masked shape.
  const referenceMasked = value.referenceMasked ?? null;
  if (referenceMasked !== null && !isMaskedReference(referenceMasked)) {
    throw integrity("Ledger read returned an invalid masked reference");
  }
  // Only the named fields are copied: whatever else a row carried is dropped.
  return {
    entryId: uuid(value, "entryId"),
    kind: "bank_verification",
    provider: provider as BankProvider,
    verifiedAt,
    verificationId: uuid(value, "verificationId"),
    memberUserId: uuid(value, "memberUserId"),
    referenceMasked
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

function parseAttribution(value: unknown): PublicLedgerAttribution & { readonly entryId: string } {
  if (!isRecord(value)) {
    throw integrity("Ledger read returned an invalid attribution row");
  }
  const source = str(value, "source");
  if (source !== "bank_verification" && source !== "treasurer") {
    throw integrity("Ledger read returned an invalid attribution source");
  }
  const recordedAt = str(value, "recordedAt");
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw integrity("Ledger read returned an invalid attribution time");
  }
  const cycleRaw = nullableStr(value, "cycleId");
  const round = value.round;
  if (round !== null && round !== undefined && (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1)) {
    throw integrity("Ledger read returned an invalid attribution round");
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw integrity("Ledger read returned an invalid attribution revision");
  }
  const cycleId = cycleRaw === null ? null : cycleRaw.toLowerCase();
  if (cycleId !== null && !isUuid(cycleId)) {
    throw integrity("Ledger read returned an invalid attribution cycle");
  }
  // Only the named fields are copied: whatever else a row carried is dropped.
  return {
    entryId: uuid(value, "entryId"),
    source,
    memberUserId: uuid(value, "memberUserId"),
    recordedBy: uuid(value, "recordedBy"),
    recordedAt,
    cycleId,
    round: typeof round === "number" ? round : null,
    revision,
    reason: nullableStr(value, "reason")
  };
}

/**
 * The effective attribution of the given contribution entries, keyed by entry id.
 * Only contributions are asked about. The RPC re-checks group membership itself.
 */
async function readAttributions(
  client: SupabaseClient,
  groupId: string,
  rows: readonly Record<string, unknown>[]
): Promise<ReadonlyMap<string, PublicLedgerAttribution>> {
  const candidates = rows.filter((row) => row.entry_type === "contribution").map((row) => uuid(row, "id"));
  const found = new Map<string, PublicLedgerAttribution>();
  if (candidates.length === 0) {
    return found;
  }
  const result = await client.rpc("get_ledger_entry_attributions_v1", {
    p_group_id: groupId,
    p_entry_ids: candidates
  });
  if (result.error) {
    throw storageFailure(result.error);
  }
  if (!Array.isArray(result.data)) {
    throw integrity("Ledger read returned an invalid attribution list");
  }
  for (const raw of result.data) {
    const { entryId, ...attribution } = parseAttribution(raw);
    if (!candidates.includes(entryId) || found.has(entryId)) {
      throw integrity("Ledger read returned an attribution for an entry it was not asked about");
    }
    found.set(entryId, attribution);
  }
  return found;
}

/** Fetch the postings, provenance and attribution for already-read entry rows and join them on. */
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
  const plainRows = rows.map((row) => (isRecord(row) ? row : {}));
  const provenance = await readProvenance(client, groupId, plainRows);
  const attributions = await readAttributions(client, groupId, plainRows);
  return rows.map((row) => {
    const parsed = parseEntry(row, []);
    const entryPostings = byEntry.get(parsed.id);
    if (!entryPostings || entryPostings.length === 0) {
      throw integrity("Ledger entry has no postings");
    }
    return {
      ...parsed,
      postings: entryPostings,
      provenance: provenance.get(parsed.id) ?? null,
      attribution: attributions.get(parsed.id) ?? null
    };
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
