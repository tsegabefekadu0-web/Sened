import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { readGroupLedger, type WireEntry } from "./clientRead";
import { LEDGER_ENTRY_TYPES, type LedgerEntryType } from "./types";
import { loadMembers } from "./clientInvites";
import { summarizeLedger, type EntryProvenance, type HomeLedgerSummary, type SummaryEntry } from "./homeSummary";
import { toEtbMinorUnits } from "./money";

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
    }
  /** The group exists and has no entries yet: the balance is genuinely zero. */
  | { readonly status: "empty" }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "multiple-groups" }
  /** More entries than one read returns, so a total would be a guess. */
  | { readonly status: "incomplete" }
  | { readonly status: "error" };

/** The most the entries route returns in one read (`LEDGER_READ_MAX_LIMIT`). */
const READ_LIMIT = 100;

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

function toSummaryEntry(entry: WireEntry): SummaryEntry | null {
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

/**
 * Load what the home screen shows from the caller's group ledger.
 *
 * Reuses `readGroupLedger` for the group and its entries, so the group rules
 * (none, several, unauthorized) are exactly the correction form's. The entries
 * route is newest-first and capped, with no cursor: if the read came back full
 * and does not reach sequence 1, older entries exist that were not read, and
 * this says `incomplete` rather than totalling part of the ledger.
 */
export async function loadHomeLedger(deps: AuthedFetchDeps = {}): Promise<HomeLedgerResult> {
  const read = await readGroupLedger(deps, { limit: READ_LIMIT });
  if (read.status !== "ok") {
    // "read-only" is only produced for `writerOnly` callers.
    return { status: read.status === "read-only" ? "error" : read.status };
  }
  const entries: SummaryEntry[] = [];
  for (const wire of read.entries) {
    const entry = toSummaryEntry(wire);
    if (entry === null) {
      return { status: "error" };
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    return { status: "empty" };
  }
  const oldest = entries.reduce((low, entry) => (BigInt(entry.sequence) < BigInt(low) ? entry.sequence : low), entries[0].sequence);
  if (entries.length >= READ_LIMIT && oldest !== "1") {
    return { status: "incomplete" };
  }
  let summary: HomeLedgerSummary;
  try {
    summary = summarizeLedger(entries, read.accounts);
  } catch {
    return { status: "error" };
  }
  return { status: "ready", summary, memberLabels: await readMemberLabels(read.groupId, summary, deps) };
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
