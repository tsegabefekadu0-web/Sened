import { STANDARD_ACCOUNTS } from "./accounts";
import { LedgerError } from "./errors";
import { formatEtbGrouped, formatEtbMinorUnits, toEtbMinorUnits } from "./money";
import type { ContributionChannel } from "./paymentChannel";
import type { LedgerEntryType, LedgerPostingDirection } from "./types";

/**
 * What the home screen shows of a group's ledger: the pot balance and the
 * contributions that built it. Pure, so the arithmetic is testable without a
 * network and the screen, the card and the spoken digest cannot disagree.
 *
 * The pot balance is the net of every posting on the group's `POT_CASH`
 * account — the asset the ደብተር shows (see `accounts.ts`). It is an asset, so
 * a debit adds and a credit subtracts. Corrections, adjustments and
 * disbursements are all in the sum because they all moved that account;
 * counting only contributions would show money that was paid out or reversed.
 * Money is `bigint` minor units throughout.
 */

export interface SummaryPosting {
  readonly accountId: string;
  readonly direction: LedgerPostingDirection;
  readonly amount: string;
}

/**
 * What the read path says about a bank-verified entry (see
 * `PublicLedgerProvenance`). Present only when the server returned a complete,
 * well-formed provenance object; anything else is treated as no provenance.
 */
export interface EntryProvenance {
  readonly provider: "telebirr" | "cbe" | "awash";
  readonly verifiedAt: string;
  readonly verificationId: string;
  readonly memberUserId: string;
  /** `••••2F42`, or `null` when none is on record. Only ever the masked shape. */
  readonly referenceMasked: string | null;
}

/**
 * Who paid a contribution (see `PublicLedgerAttribution`). `bank_verification` is
 * a verified bank receipt; `treasurer` is an owner's or treasurer's record for an
 * entry with no bank provenance, which is the treasurer's word and never a
 * verification. Bank provenance outranks a treasurer's record.
 */
export interface EntryAttribution {
  readonly source: "bank_verification" | "treasurer";
  readonly memberUserId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly cycleId: string | null;
  readonly round: number | null;
  /** 1 = never corrected; each correction is a new record and the earlier ones are kept. */
  readonly revision: number;
  readonly reason: string | null;
  /**
   * How it was paid: the treasurer's word, or the provider for a bank verification.
   * Absent (an older server) or `null` = not said.
   */
  readonly channel?: ContributionChannel | null;
  /** The treasurer's plain-text note, or absent/`null`. Data: render it as text only. */
  readonly note?: string | null;
}

export interface SummaryEntry {
  readonly id: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly entryType: LedgerEntryType;
  readonly correctsEntryId: string | null;
  readonly postings: readonly SummaryPosting[];
  /** Absent or `null` for an entry with no bank-verification provenance. */
  readonly provenance?: EntryProvenance | null;
  /** Absent or `null` for a contribution nobody has said the payer of. */
  readonly attribution?: EntryAttribution | null;
}

export interface SummaryAccount {
  readonly id: string;
  readonly code: string;
}

export interface HomeContribution {
  readonly id: string;
  readonly sequence: string;
  readonly occurredAt: string;
  /** ETB, two decimals: what this entry added to the pot. */
  readonly amount: string;
  /** Set only when a verified bank receipt posted this entry; otherwise `null`. */
  readonly provenance: EntryProvenance | null;
  /**
   * Who paid, when anyone has said so: the bank verification, else the
   * treasurer's record. Optional so a caller that only knows provenance still
   * type-checks; consumers fall back to provenance when it is absent.
   */
  readonly attribution?: EntryAttribution | null;
}

export interface HomeLedgerSummary {
  /** ETB, two decimals. */
  readonly potBalance: string;
  /** Newest first. Contributions that were later corrected are left out. */
  readonly contributions: readonly HomeContribution[];
}

function integrity(message: string): LedgerError {
  return new LedgerError("INTEGRITY_FAILURE", message);
}

/**
 * Net change to one account by one entry, in minor units (debit positive).
 * Throws on an amount that is not a valid ETB value, because a total built over
 * a row we could not read is a wrong total.
 */
function netOnAccount(entry: SummaryEntry, accountId: string): bigint {
  let net = 0n;
  for (const posting of entry.postings) {
    if (posting.accountId !== accountId) {
      continue;
    }
    const units = toEtbMinorUnits(posting.amount);
    net += posting.direction === "debit" ? units : -units;
  }
  return net;
}

/**
 * The pot contributions among `entries`, newest first, corrected ones left out.
 *
 * Needs no balance, so it works on a page of the ledger: a correction always has
 * a higher sequence than the entry it reverses, so when the original is on the
 * page its correction is too (pages are cut at a sequence, newest side first).
 * The pot balance itself comes from the server (`GET /api/ledger/balances`) for
 * the screens that cannot hold the whole list.
 */
export function summarizeContributions(entries: readonly SummaryEntry[], potAccountId: string): HomeContribution[] {
  const corrected = new Set(entries.map((entry) => entry.correctsEntryId).filter((id) => id !== null));
  const contributions: HomeContribution[] = [];
  for (const entry of entries) {
    if (entry.entryType !== "contribution" || corrected.has(entry.id)) {
      continue;
    }
    const added = netOnAccount(entry, potAccountId);
    // A contribution that did not add to the pot is not a pot contribution.
    if (added > 0n) {
      contributions.push({
        id: entry.id,
        sequence: entry.sequence,
        occurredAt: entry.occurredAt,
        amount: formatEtbMinorUnits(added),
        provenance: entry.provenance ?? null,
        attribution: entry.attribution ?? null
      });
    }
  }
  contributions.sort((left, right) => {
    const difference = BigInt(right.sequence) - BigInt(left.sequence);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });

  return contributions;
}

/**
 * Derive the home summary from a group's complete entry list.
 *
 * "Complete" is the caller's job to establish: summing a truncated list yields
 * a plausible, wrong balance. Throws `INTEGRITY_FAILURE` when the group's chart
 * has no `POT_CASH` account (it cannot be guessed) or when the ledger nets the
 * pot below zero (cash cannot be owed; something is missing or wrong).
 */
export function summarizeLedger(
  entries: readonly SummaryEntry[],
  accounts: readonly SummaryAccount[]
): HomeLedgerSummary {
  const pot = accounts.find((account) => account.code === STANDARD_ACCOUNTS.POT_CASH.code);
  if (!pot) {
    throw integrity("The group's chart of accounts has no pot cash account");
  }

  let balance = 0n;
  for (const entry of entries) {
    balance += netOnAccount(entry, pot.id);
  }
  if (balance < 0n) {
    throw integrity("The ledger nets the pot below zero");
  }

  return { potBalance: formatEtbMinorUnits(balance), contributions: summarizeContributions(entries, pot.id) };
}

/**
 * One rendering of the pot balance for the card and the digest. A string is a
 * ledger amount and is only ever grouped, never turned into a float; a number
 * is the sample figure.
 */
export function formatPotBalance(value: number | string): string {
  return typeof value === "string" ? formatEtbGrouped(value) : value.toLocaleString("en-US");
}
