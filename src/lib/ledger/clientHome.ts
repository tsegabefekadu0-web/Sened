import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { fetchLedgerBalances, readEntriesPage, readMyGroup, type GroupChoiceOptions, type WireEntry } from "./clientRead";
import { STANDARD_ACCOUNTS } from "./accounts";
import { LEDGER_ENTRY_TYPES, type LedgerEntryType } from "./types";
import { isMaskedReference } from "@/lib/banking/referenceMask";
import { loadMembers, type MemberRow } from "./clientInvites";
import {
  summarizeContributions,
  type EntryAttribution,
  type EntryProvenance,
  type HomeLedgerSummary,
  type SummaryEntry
} from "./homeSummary";
import { formatEtbMinorUnits, toEtbMinorUnits } from "./money";
import { isContributionChannel } from "./paymentChannel";

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
       * Each named member's own avatar attire (a display preference every member
       * may see), keyed by user id. A member the members API did not return is
       * absent: no attire is guessed.
       */
      readonly memberAttire: Readonly<Record<string, "gabi" | "netela" | "none">>;
      /** The group the entries belong to, for the owner's / treasurer's "attribute payer" action. */
      readonly groupId: string;
      /** The caller's role in it (`null` when the server did not say). */
      readonly role: string | null;
      /**
       * The members an owner or treasurer may name as a payer. Empty for everyone
       * else (a plain member is never offered the action), and when the members
       * could not be read.
       */
      readonly attributableMembers: readonly MemberRow[];
      /**
       * True when older entries than the contributions listed exist. The pot
       * balance still covers the whole ledger (it is computed by the server);
       * only the feed is the most recent page.
       */
      readonly feedTruncated: boolean;
    }
  /** The group exists and has no entries yet: the balance is genuinely zero. */
  | { readonly status: "empty"; readonly groupId: string }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "choose-group" }
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
    memberUserId: raw.memberUserId,
    // Re-checked here as well: anything but the masked shape is dropped, so a
    // full reference could not reach the screen even if a response carried it.
    referenceMasked: isMaskedReference(raw.referenceMasked) ? raw.referenceMasked : null
  };
}

/**
 * An attribution object is trusted only when every field is present and
 * well-formed. A partial one is dropped (the row simply has no payer shown).
 */
export function toEntryAttribution(value: unknown): EntryAttribution | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const cycleId = raw.cycleId ?? null;
  const round = raw.round ?? null;
  const reason = raw.reason ?? null;
  // Additive: an older server sends neither. A malformed value is dropped, not trusted.
  const channel = isContributionChannel(raw.channel) ? raw.channel : null;
  const note = typeof raw.note === "string" && raw.note.length > 0 && raw.note.length <= 560 ? raw.note : null;
  if (
    (raw.source !== "bank_verification" && raw.source !== "treasurer") ||
    typeof raw.memberUserId !== "string" ||
    !UUID.test(raw.memberUserId) ||
    typeof raw.recordedBy !== "string" ||
    !UUID.test(raw.recordedBy) ||
    typeof raw.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.recordedAt)) ||
    (cycleId !== null && (typeof cycleId !== "string" || !UUID.test(cycleId))) ||
    (round !== null && (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1)) ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    (reason !== null && typeof reason !== "string")
  ) {
    return null;
  }
  return {
    source: raw.source,
    memberUserId: raw.memberUserId,
    recordedBy: raw.recordedBy,
    recordedAt: raw.recordedAt,
    cycleId: cycleId as string | null,
    round: round as number | null,
    revision: raw.revision,
    reason: reason as string | null,
    channel,
    note
  };
}

/**
 * The effective attribution of an entry as the screen should hold it. Bank
 * provenance outranks a treasurer's record, so when the entry has provenance the
 * attribution is the bank's (built from the provenance itself, which the verifier
 * wrote) even if a server also sent a treasurer row; with none, the server's
 * attribution is used only if it is complete.
 */
export function effectiveAttribution(
  provenance: EntryProvenance | null,
  attribution: EntryAttribution | null,
  recordedBy?: string
): EntryAttribution | null {
  if (provenance !== null) {
    return {
      source: "bank_verification",
      memberUserId: provenance.memberUserId,
      recordedBy: attribution?.source === "bank_verification" ? attribution.recordedBy : (recordedBy ?? provenance.memberUserId),
      recordedAt: provenance.verifiedAt,
      cycleId: null,
      round: null,
      revision: 1,
      reason: null,
      // The provider IS the channel, and a bank row has no treasurer's note.
      channel: provenance.provider,
      note: null
    };
  }
  return attribution;
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
  const provenance = toEntryProvenance(entry.provenance);
  return {
    id: entry.id,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    entryType: entry.entryType as LedgerEntryType,
    correctsEntryId: (entry.correctsEntryId as string | null | undefined) ?? null,
    postings,
    provenance,
    attribution: effectiveAttribution(provenance, toEntryAttribution(entry.attribution))
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
 * contain. The group rules (none, choose one of several, unauthorized) are those of the
 * correction form (`readMyGroup`).
 *
 * Two integrity refusals rather than a guess: a negative pot (cash cannot be
 * owed), and, when the page happens to be the entire ledger, a page whose pot
 * net differs from the server balance (the two would contradict each other on
 * screen).
 */
export async function loadHomeLedger(
  deps: AuthedFetchDeps = {},
  options: GroupChoiceOptions = {}
): Promise<HomeLedgerResult> {
  const mine = await readMyGroup(deps, { groupId: options.groupId });
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
    return potUnits === 0n ? { status: "empty", groupId: mine.groupId } : { status: "error" };
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
    groupId: mine.groupId,
    role: mine.role,
    ...(await readMembers(mine.groupId, mine.role, summary, deps))
  };
}

/**
 * Names and avatar attire for the members named as payers, whether by a verified
 * bank receipt or by the treasurer's record, and (for an owner or treasurer only)
 * the roster the "attribute payer" action offers. Best effort: if the members
 * cannot be read the contributions are still shown with what the ledger read
 * said (verified stays verified, a treasurer's record stays labelled as one), just
 * with the anonymous label and no shawl. The members API decides what a caller
 * may see of a member; nothing is added here.
 */
async function readMembers(
  groupId: string,
  role: string | null,
  summary: HomeLedgerSummary,
  deps: AuthedFetchDeps
): Promise<{
  readonly memberLabels: Readonly<Record<string, string | null>>;
  readonly memberAttire: Readonly<Record<string, "gabi" | "netela" | "none">>;
  readonly attributableMembers: readonly MemberRow[];
}> {
  const wanted = new Set(
    summary.contributions.flatMap((contribution) => {
      const payer = contribution.attribution?.memberUserId ?? contribution.provenance?.memberUserId;
      return payer ? [payer] : [];
    })
  );
  const manager = role === "owner" || role === "treasurer";
  if (wanted.size === 0 && !manager) {
    return { memberLabels: {}, memberAttire: {}, attributableMembers: [] };
  }
  const outcome = await loadMembers(groupId, deps);
  if (outcome.status !== "ready") {
    return { memberLabels: {}, memberAttire: {}, attributableMembers: [] };
  }
  const memberLabels: Record<string, string | null> = {};
  const memberAttire: Record<string, "gabi" | "netela" | "none"> = {};
  for (const member of outcome.members) {
    if (wanted.has(member.userId)) {
      memberLabels[member.userId] = member.email;
      memberAttire[member.userId] = member.attire;
    }
  }
  return { memberLabels, memberAttire, attributableMembers: manager ? outcome.members : [] };
}
