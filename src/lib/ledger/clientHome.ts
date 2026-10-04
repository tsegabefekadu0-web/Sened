import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { fetchLedgerBalances, readEntriesPage, readMyGroup, type WireEntry } from "./clientRead";
import { STANDARD_ACCOUNTS } from "./accounts";
import { LEDGER_ENTRY_TYPES, type LedgerEntryType } from "./types";
import { loadMembers } from "./clientInvites";
import { summarizeContributions, type EntryProvenance, type HomeLedgerSummary, type SummaryEntry } from "./homeSummary";
import { formatEtbMinorUnits, toEtbMinorUnits } from "./money";

export type HomeLedgerResult =
  | {
      readonly status: "ready";
      readonly summary: HomeLedgerSummary;
      /**
       * Display names for the members named in the summary's provenance, keyed
       * by user id. The value is the login email only when the members API
       * already shows it to this caller (the group owner); otherwise `null`
       * and the screen falls back to the anonymous "Member xxxxxxxx" label.
       * Empty when nothing has provenance or the members could not be read.
       */
      readonly memberLabels: Readonly<Record<string, string | null>>;
      /**
       * True when older entries than the contributions listed exist. The pot
       * balance still covers the whole ledger (it is computed by the server);
       * only the feed is the most recent page.
       */
      readonly feedTruncated: boolean;
    }
  /** The group exists and has no entries yet: the balance is genuinely zero. */
  | { readonly status: "empty" }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "multiple-groups" }
  | { readonly status: "error" };

/** The most the entries route returns in one read (`LEDGER_READ_MAX_LIMIT`): the feed is one such page. */
export const ENTRIES_PAGE_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A provenance object is trusted only when every field is present and
 * well-formed. A partial one is dropped, so the row stays "Recorded in ledger"
 * rather than becoming a half-evidenced "Verified".
 */
export function toEntryProvenance(value: unknown): EntryProvenance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "bank_verification" ||
    (raw.provider !== "telebirr" && raw.provider !== "cbe" && raw.provider !== "awash") ||
    typeof raw.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.verifiedAt)) ||
    typeof raw.verificationId !== "string" ||
    !UUID.test(raw.verificationId) ||
    typeof raw.memberUserId !== "string" ||
    !UUID.test(raw.memberUserId)
  ) {
    return null;
  }
  return {
    provider: raw.provider,
    verifiedAt: raw.verifiedAt,
    verificationId: raw.verificationId,
    memberUserId: raw.memberUserId
  };
}

export function toSummaryEntry(entry: WireEntry): SummaryEntry | null {
  if (
    typeof entry.id !== "string" ||
    typeof entry.occurredAt !== "string" ||
    typeof entry.sequence !== "string" ||
    !/^[1-9]\d*$/.test(entry.sequence) ||
    typeof entry.entryType !== "string" ||
    !(LEDGER_ENTRY_TYPES as readonly string[]).includes(entry.entryType) ||
    !Array.isArray(entry.postings) ||
    (entry.correctsEntryId !== null && entry.correctsEntryId !== undefined && typeof entry.correctsEntryId !== "string")
  ) {
    return null;
  }
  const postings: SummaryEntry["postings"][number][] = [];
  for (const posting of entry.postings as readonly { accountId?: unknown; direction?: unknown; amount?: unknown }[]) {
    if (
      typeof posting.accountId !== "string" ||
      (posting.direction !== "debit" && posting.direction !== "credit") ||
      typeof posting.amount !== "string"
    ) {
      return null;
    }
    try {
      toEtbMinorUnits(posting.amount);
    } catch {
      return null;
    }
    postings.push({ accountId: posting.accountId, direction: posting.direction, amount: posting.amount });
  }
  return {
    id: entry.id,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    entryType: entry.entryType as LedgerEntryType,
    correctsEntryId: (entry.correctsEntryId as string | null | undefined) ?? null,
    postings,
    provenance: toEntryProvenance(entry.provenance)
  };
}

/** Parse a server balance such as `"-12.50"` to minor units; anything else throws. */
function balanceToMinorUnits(balance: string): bigint {
  const negative = balance.startsWith("-");
  const units = toEtbMinorUnits(negative ? balance.slice(1) : balance);
  return negative ? -units : units;
}

/**
 * Load what the home screen shows from the caller's group ledger.
 *
 * The pot balance is the server's: `GET /api/ledger/balances` sums every
 * posting in one database snapshot, so it exists for a ledger of any length and
 * is never assembled from a page. The feed is the most recent page of entries,
 * read with `beforeSequence = head + 1` so it ends exactly at the head the
 * balance was computed at: an entry appended between the two reads is in
 * neither, and the screen cannot show a contribution the balance does not
 * contain. The group rules (none, several, unauthorized) are those of the
 * correction form (`readMyGroup`).
 *
 * Two integrity refusals rather than a guess: a negative pot (cash cannot be
 * owed), and, when the page happens to be the entire ledger, a page whose pot
 * net differs from the server balance (the two would contradict each other on
 * screen).
 */
export async function loadHomeLedger(deps: AuthedFetchDeps = {}): Promise<HomeLedgerResult> {
  const mine = await readMyGroup(deps);
  if (mine.status !== "ok") {
    return { status: mine.status };
  }

  const snapshot = await fetchLedgerBalances(mine.groupId, deps);
  if (snapshot.status !== "ok") {
    return { status: snapshot.status };
  }
  const pot = snapshot.balances.find((account) => account.code === STANDARD_ACCOUNTS.POT_CASH.code);
  if (!pot) {
    return { status: "error" };
  }
  let potUnits: bigint;
  let head: bigint;
  let count: bigint;
  try {
    potUnits = balanceToMinorUnits(pot.balance);
    head = BigInt(snapshot.headSequence);
    count = BigInt(snapshot.entryCount);
  } catch {
    return { status: "error" };
  }
  if (potUnits < 0n || (head === 0n) !== (count === 0n) || count > head) {
    return { status: "error" };
  }
  if (head === 0n) {
    return potUnits === 0n ? { status: "empty" } : { status: "error" };
  }

  const page = await readEntriesPage(
    mine.groupId,
    { limit: ENTRIES_PAGE_LIMIT, beforeSequence: (head + 1n).toString() },
    deps
  );
  if (page.status !== "ok") {
    return { status: page.status };
  }
  const entries: SummaryEntry[] = [];
  for (const wire of page.entries) {
    const entry = toSummaryEntry(wire);
    // An entry newer than the snapshot would contradict the balance beside it.
    if (entry === null || BigInt(entry.sequence) > head) {
      return { status: "error" };
    }
    entries.push(entry);
  }

  let contributions;
  try {
    contributions = summarizeContributions(entries, pot.accountId);
    if (!page.hasMore && entries.length > 0) {
      let net = 0n;
      for (const entry of entries) {
        for (const posting of entry.postings) {
          if (posting.accountId === pot.accountId) {
            const units = toEtbMinorUnits(posting.amount);
            net += posting.direction === "debit" ? units : -units;
          }
        }
      }
      if (net !== potUnits || BigInt(entries.length) !== count) {
        return { status: "error" };
      }
    }
  } catch {
    return { status: "error" };
  }

  const summary: HomeLedgerSummary = { potBalance: formatEtbMinorUnits(potUnits), contributions };
  return {
    status: "ready",
    summary,
    feedTruncated: page.hasMore,
    memberLabels: await readMemberLabels(mine.groupId, summary, deps)
  };
}

/**
 * Names for the members whose receipts were verified. Best effort: if the
 * members cannot be read the contributions are still shown as verified (that
 * comes from the ledger read), just with the anonymous label. The members API
 * decides what a caller may see of a member; nothing is added here.
 */
async function readMemberLabels(
  groupId: string,
  summary: HomeLedgerSummary,
  deps: AuthedFetchDeps
): Promise<Readonly<Record<string, string | null>>> {
  const wanted = new Set(
    summary.contributions.flatMap((contribution) => (contribution.provenance ? [contribution.provenance.memberUserId] : []))
  );
  if (wanted.size === 0) {
    return {};
  }
  const outcome = await loadMembers(groupId, deps);
  if (outcome.status !== "ready") {
    return {};
  }
  const labels: Record<string, string | null> = {};
  for (const member of outcome.members) {
    if (wanted.has(member.userId)) {
      labels[member.userId] = member.email;
    }
  }
  return labels;
}
