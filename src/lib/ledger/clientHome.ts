import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { readGroupLedger, type WireEntry } from "./clientRead";
import { LEDGER_ENTRY_TYPES, type LedgerEntryType } from "./types";
import { summarizeLedger, type HomeLedgerSummary, type SummaryEntry } from "./homeSummary";
import { toEtbMinorUnits } from "./money";

export type HomeLedgerResult =
  | { readonly status: "ready"; readonly summary: HomeLedgerSummary }
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
    postings
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
  try {
    return { status: "ready", summary: summarizeLedger(entries, read.accounts) };
  } catch {
    return { status: "error" };
  }
}
