import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { loadHomeLedger } from "@/lib/ledger/clientHome";
import type { HomeContribution } from "@/lib/ledger/homeSummary";
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
  /** More entries than one read returns: a total would be a guess, so none is shown. */
  | { readonly status: "incomplete" }
  | { readonly status: "unavailable" };

/** Read the group's ledger the way the home screen does, and total what the cycle covers. */
export async function loadCycleLedgerFigures(
  startedAt: string,
  deps: AuthedFetchDeps = {}
): Promise<LedgerFiguresResult> {
  const home = await loadHomeLedger(deps);
  if (home.status === "empty") return { status: "empty" };
  if (home.status === "incomplete") return { status: "incomplete" };
  if (home.status !== "ready") return { status: "unavailable" };
  try {
    return { status: "ready", figures: cycleLedgerFigures(home.summary.contributions, startedAt) };
  } catch {
    return { status: "unavailable" };
  }
}
