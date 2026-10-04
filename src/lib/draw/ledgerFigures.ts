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
 * entry carries no cycle or round id. So the actor is never used to say who
 * paid. What can be attributed is an entry posted from a verified bank receipt:
 * the read path now returns its provenance, and the verification's own user is
 * the member who paid. For those entries, and only those, a member is credited.
 *
 * Still NOT derivable, and not shown as if it were:
 *
 *  - who paid an entry that carries no bank provenance (a treasurer's manual
 *    entry), so such entries are counted and totalled as `unattributed`;
 *  - which round an entry belongs to, and the cycle has no cadence, so there is
 *    no per-round period: the window is "since the cycle started";
 *  - whether a member is in default. A member absent from `byMember` has no
 *    bank-verified entry in the window; that is not the same as unpaid, because
 *    they may have paid in a way the ledger cannot attribute.
 */

export interface MemberPaidFigure {
  /** The member whose bank receipt was verified. */
  readonly memberUserId: string;
  /** Bank-verified contribution entries from this member since the cycle began. */
  readonly count: number;
  /** ETB, two decimals. */
  readonly total: string;
}

export interface CycleLedgerFigures {
  /** Contribution entries recorded on or after the cycle's start. */
  readonly count: number;
  /** ETB, two decimals: what those entries added to the pot. */
  readonly total: string;
  /** Members with bank-verified entries in the window, largest total first. */
  readonly byMember: readonly MemberPaidFigure[];
  /** Entries in the window with no bank provenance: nobody can be credited. */
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
  const members = new Map<string, { count: number; total: bigint }>();
  for (const contribution of contributions) {
    if (Number.isFinite(start) && Date.parse(contribution.occurredAt) < start) {
      continue;
    }
    const units = toEtbMinorUnits(contribution.amount);
    total += units;
    count += 1;
    const memberUserId = contribution.provenance?.memberUserId;
    if (memberUserId === undefined) {
      unattributedTotal += units;
      unattributedCount += 1;
      continue;
    }
    const current = members.get(memberUserId) ?? { count: 0, total: 0n };
    members.set(memberUserId, { count: current.count + 1, total: current.total + units });
  }
  const byMember = [...members.entries()]
    .map(([memberUserId, figure]) => ({ memberUserId, count: figure.count, units: figure.total }))
    .sort((left, right) =>
      left.units === right.units ? left.memberUserId.localeCompare(right.memberUserId) : left.units > right.units ? -1 : 1
    )
    .map(({ memberUserId, count: entries, units }) => ({
      memberUserId,
      count: entries,
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
