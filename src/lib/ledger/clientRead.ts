import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import type { LedgerEntryType } from "./types";

/** One entry the correction form can offer as the original to correct. */
export interface CorrectionTarget {
  readonly id: string;
  readonly type: LedgerEntryType;
  readonly sequence: string;
  /** Sum of the debit postings: the amount that moved, in ETB. */
  readonly amount: string;
  readonly direction: "inbound" | "outbound";
  readonly reference: string;
}

export type LiveLedgerResult =
  | { readonly status: "ready"; readonly targets: readonly CorrectionTarget[] }
  | { readonly status: "empty" }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "multiple-groups" }
  | { readonly status: "error" };

interface WireGroup {
  readonly groupId?: unknown;
}
interface WirePosting {
  readonly direction?: unknown;
  readonly amount?: unknown;
}
interface WireEntry {
  readonly id?: unknown;
  readonly sequence?: unknown;
  readonly entryType?: unknown;
  readonly correctsEntryId?: unknown;
  readonly postings?: unknown;
}

function minorUnits(amount: string): bigint | null {
  const match = /^(\d+)\.(\d{2})$/.exec(amount);
  return match ? BigInt(match[1]) * 100n + BigInt(match[2]) : null;
}

function toTarget(entry: WireEntry): CorrectionTarget | null {
  if (
    typeof entry.id !== "string" ||
    typeof entry.sequence !== "string" ||
    typeof entry.entryType !== "string" ||
    !Array.isArray(entry.postings)
  ) {
    return null;
  }
  let total = 0n;
  for (const posting of entry.postings as WirePosting[]) {
    if (posting.direction !== "debit") {
      continue;
    }
    const units = typeof posting.amount === "string" ? minorUnits(posting.amount) : null;
    if (units === null) {
      return null;
    }
    total += units;
  }
  const amount = `${total / 100n}.${(total % 100n).toString().padStart(2, "0")}`;
  return {
    id: entry.id,
    type: entry.entryType as LedgerEntryType,
    sequence: entry.sequence,
    amount,
    direction: entry.entryType === "contribution" ? "inbound" : "outbound",
    reference: `#${entry.sequence}`
  };
}

/**
 * Load the entries the correction form can target: the caller's group from
 * `GET /api/my-groups`, then `GET /api/ledger/entries` for it.
 *
 * Every non-success is a distinct result, because "you have nothing" and "we
 * could not look" must not render the same. With more than one group this
 * refuses rather than choosing: picking the group someone is acting for is
 * exactly the guess that puts money on the wrong ledger.
 */
export async function loadCorrectionTargets(deps: AuthedFetchDeps = {}): Promise<LiveLedgerResult> {
  try {
    const groupsResponse = await authedFetch("/api/my-groups", { method: "GET" }, deps);
    if (groupsResponse.status === 401) {
      return { status: "unauthorized" };
    }
    if (!groupsResponse.ok) {
      return { status: "error" };
    }
    const groups = ((await groupsResponse.json()) as { groups?: readonly WireGroup[] }).groups ?? [];
    if (groups.length === 0) {
      return { status: "no-group" };
    }
    if (groups.length > 1) {
      return { status: "multiple-groups" };
    }
    const groupId = groups[0].groupId;
    if (typeof groupId !== "string") {
      return { status: "error" };
    }

    const entriesResponse = await authedFetch(
      `/api/ledger/entries?groupId=${encodeURIComponent(groupId)}`,
      { method: "GET" },
      deps
    );
    if (entriesResponse.status === 401) {
      return { status: "unauthorized" };
    }
    if (!entriesResponse.ok) {
      return { status: "error" };
    }
    const wire = ((await entriesResponse.json()) as { entries?: readonly WireEntry[] }).entries;
    if (!Array.isArray(wire)) {
      return { status: "error" };
    }
    const alreadyCorrected = new Set(wire.map((entry) => entry.correctsEntryId));
    const targets = wire
      .filter((entry) => entry.entryType !== "correction" && !alreadyCorrected.has(entry.id))
      .map(toTarget);
    if (targets.some((target) => target === null)) {
      return { status: "error" };
    }
    return targets.length === 0
      ? { status: "empty" }
      : { status: "ready", targets: targets as CorrectionTarget[] };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}
