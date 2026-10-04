import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { STANDARD_ACCOUNTS } from "@/lib/ledger/accounts";
import { ENTRIES_PAGE_LIMIT, toSummaryEntry } from "@/lib/ledger/clientHome";
import { readEntriesPage, readMyGroup } from "@/lib/ledger/clientRead";
import { summarizeContributions, type HomeContribution, type SummaryEntry } from "@/lib/ledger/homeSummary";
import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

/**
 * What the ledger can honestly say about a cycle's contributions.
 *
 * A ledger entry's `actor` is whoever recorded it, not whoever paid, and an
 * entry carries no cycle or round id of its own. So the actor is never used to
 * say who paid. A payer is credited only through an ATTRIBUTION, of which there
 * are two kinds and they are kept apart:
 *
 *  - `bank_verification`: the entry was posted from a verified bank receipt, and
 *    the verification's own user is the member who paid. This is evidence.
 *  - `treasurer`: an owner or treasurer RECORDED who paid an entry that has no
 *    bank provenance (cash, a manual entry). This is the treasurer's word, not a
 *    verification; it makes who-paid work for a cash group, and it is counted
 *    and labelled separately so it is never presented as verified.
 *
 * Bank provenance wins when both exist (the read path already resolves that).
 *
 * Still NOT derivable here, and not shown as if it were:
 *
 *  - which round an entry belongs to unless the treasurer said so; the window
 *    is "since the cycle started". The per-round view is the collateral view
 *    (`collateral.ts`), which derives each winner's later rounds in the database;
 *  - whether a member is in default. A member absent from `byMember` has no
 *    attributed entry in the window; that is not the same as unpaid.
 */

export interface MemberPaidFigure {
  /** The member credited: the verification's user, or the member the treasurer named. */
  readonly memberUserId: string;
  /** Attributed contribution entries from this member since the cycle began (both kinds). */
  readonly count: number;
  /** Of `count`, the entries a verified bank receipt names. */
  readonly verifiedCount: number;
  /** Of `count`, the entries only the treasurer's record names: not bank-verified. */
  readonly treasurerCount: number;
  /** ETB, two decimals. */
  readonly total: string;
}

export interface CycleLedgerFigures {
  /** Contribution entries recorded on or after the cycle's start. */
  readonly count: number;
  /** ETB, two decimals: what those entries added to the pot. */
  readonly total: string;
  /** Members with attributed entries in the window, largest total first. */
  readonly byMember: readonly MemberPaidFigure[];
  /** Entries in the window nobody has attributed (no bank provenance, no treasurer's record). */
  readonly unattributedCount: number;
  /** ETB, two decimals. */
  readonly unattributedTotal: string;
}

/** Pure: the contributions that fall on or after the cycle's start, their total, and who is credited. */
export function cycleLedgerFigures(
  contributions: readonly HomeContribution[],
  startedAt: string
): CycleLedgerFigures {
  const start = Date.parse(startedAt);
  let total = 0n;
  let count = 0;
  let unattributedTotal = 0n;
  let unattributedCount = 0;
  const members = new Map<string, { count: number; verified: number; total: bigint }>();
  for (const contribution of contributions) {
    if (Number.isFinite(start) && Date.parse(contribution.occurredAt) < start) {
      continue;
    }
    const units = toEtbMinorUnits(contribution.amount);
    total += units;
    count += 1;
    // Bank provenance wins; a caller that only knows provenance still credits it.
    const attribution = contribution.provenance
      ? { memberUserId: contribution.provenance.memberUserId, verified: true }
      : contribution.attribution
        ? { memberUserId: contribution.attribution.memberUserId, verified: contribution.attribution.source === "bank_verification" }
        : null;
    if (attribution === null) {
      unattributedTotal += units;
      unattributedCount += 1;
      continue;
    }
    const current = members.get(attribution.memberUserId) ?? { count: 0, verified: 0, total: 0n };
    members.set(attribution.memberUserId, {
      count: current.count + 1,
      verified: current.verified + (attribution.verified ? 1 : 0),
      total: current.total + units
    });
  }
  const byMember = [...members.entries()]
    .map(([memberUserId, figure]) => ({ memberUserId, count: figure.count, verified: figure.verified, units: figure.total }))
    .sort((left, right) =>
      left.units === right.units ? left.memberUserId.localeCompare(right.memberUserId) : left.units > right.units ? -1 : 1
    )
    .map(({ memberUserId, count: entries, verified, units }) => ({
      memberUserId,
      count: entries,
      verifiedCount: verified,
      treasurerCount: entries - verified,
      total: formatEtbMinorUnits(units)
    }));
  return {
    count,
    total: formatEtbMinorUnits(total),
    byMember,
    unattributedCount,
    unattributedTotal: formatEtbMinorUnits(unattributedTotal)
  };
}

export type LedgerFiguresResult =
  | { readonly status: "ready"; readonly figures: CycleLedgerFigures }
  /** The ledger has no entries yet, so the figures are genuinely zero. */
  | { readonly status: "empty" }
  /**
   * The page bound was hit before the cycle's start was reached, so some of the
   * window was never read and a total would be a guess: none is shown.
   */
  | { readonly status: "incomplete" }
  | { readonly status: "unavailable" };

/**
 * The most pages of `ENTRIES_PAGE_LIMIT` entries read for one cycle's figures
 * (2,000 entries). A bound, not a target: paging stops as soon as the window is
 * covered, so a normal cycle reads one or two pages.
 */
export const FIGURES_MAX_PAGES = 20;

/** When an entry was recorded, falling back to when it occurred if the server sent no usable time. */
function recordedTime(entry: { readonly recordedAt?: unknown; readonly occurredAt?: unknown }): number {
  const recorded = typeof entry.recordedAt === "string" ? Date.parse(entry.recordedAt) : Number.NaN;
  return Number.isFinite(recorded) ? recorded : Date.parse(String(entry.occurredAt));
}

/**
 * Page back through the group's entries (newest first, `nextCursor`) until the
 * cycle's start is covered, then total what the cycle contains.
 *
 * Paging stops when the oldest entry of a page was *recorded* before the cycle
 * began: sequences and recording times rise together on the append-only chain,
 * so everything older was recorded before the cycle too. (`occurredAt` cannot
 * decide this: a backdated entry carries an old `occurredAt` and a new
 * sequence.) The figures themselves still count by `occurredAt`, as before.
 * At most `FIGURES_MAX_PAGES` pages are read; if that is not enough the result
 * is `incomplete`, never a partial total.
 */
export async function loadCycleLedgerFigures(
  startedAt: string,
  deps: AuthedFetchDeps = {},
  maxPages: number = FIGURES_MAX_PAGES
): Promise<LedgerFiguresResult> {
  const mine = await readMyGroup(deps);
  if (mine.status !== "ok") return { status: "unavailable" };
  const pot = mine.accounts.find((account) => account.code === STANDARD_ACCOUNTS.POT_CASH.code);
  if (!pot) return { status: "unavailable" };

  const start = Date.parse(startedAt);
  const entries: SummaryEntry[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await readEntriesPage(mine.groupId, { limit: ENTRIES_PAGE_LIMIT, beforeSequence: cursor }, deps);
    if (page.status !== "ok") return { status: "unavailable" };
    if (page.entries.length === 0) {
      if (pageNumber === 1) return { status: "empty" };
      break;
    }
    for (const wire of page.entries) {
      const entry = toSummaryEntry(wire);
      if (entry === null) return { status: "unavailable" };
      entries.push(entry);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    const oldest = page.entries[page.entries.length - 1];
    if (Number.isFinite(start) && recordedTime(oldest) < start) break;
    if (pageNumber === maxPages) return { status: "incomplete" };
    cursor = page.nextCursor;
  }
  try {
    return {
      status: "ready",
      figures: cycleLedgerFigures(summarizeContributions(entries, pot.id), startedAt)
    };
  } catch {
    return { status: "unavailable" };
  }
}
