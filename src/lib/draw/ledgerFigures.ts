import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { loadHomeLedger } from "@/lib/ledger/clientHome";
import type { HomeContribution } from "@/lib/ledger/homeSummary";
import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

/**
 * What the ledger can honestly say about a cycle's contributions.
 *
 * The ledger records WHAT was paid and WHEN, on which accounts. A ledger entry
 * carries no member id (its `actor` is whoever recorded it, not whoever paid) and
 * no cycle or round id. So three things are NOT derivable and are not shown as if
 * they were:
 *
 *  - which member paid which entry, so there is no per-member paid / unpaid status;
 *  - which round an entry belongs to, so there is no per-round total;
 *  - whether a member is in default.
 *
 * What IS derivable, by the same reading the home screen uses (`loadHomeLedger`):
 * the contribution entries recorded since the cycle started, how many, and their
 * total. Each member is then shown at the cycle's configured amount, labelled as
 * configured and not as paid.
 */

export interface CycleLedgerFigures {
  /** Contribution entries recorded on or after the cycle's start. */
  readonly count: number;
  /** ETB, two decimals: what those entries added to the pot. */
  readonly total: string;
}

/** Pure: the contributions that fall on or after the cycle's start, and their total. */
export function cycleLedgerFigures(
  contributions: readonly HomeContribution[],
  startedAt: string
): CycleLedgerFigures {
  const start = Date.parse(startedAt);
  let total = 0n;
  let count = 0;
  for (const contribution of contributions) {
    if (Number.isFinite(start) && Date.parse(contribution.occurredAt) < start) {
      continue;
    }
    total += toEtbMinorUnits(contribution.amount);
    count += 1;
  }
  return { count, total: formatEtbMinorUnits(total) };
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
