import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import type { LedgerEntryType, LedgerPostingInput } from "./types";

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

/** A target read from the live ledger: carries what a reversal is built from. */
export interface LiveCorrectionTarget extends CorrectionTarget {
  readonly groupId: string;
  readonly occurredAt: string;
  readonly postings: readonly LedgerPostingInput[];
}

export type LiveLedgerResult =
  | { readonly status: "ready"; readonly targets: readonly LiveCorrectionTarget[] }
  | { readonly status: "empty" }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "multiple-groups" }
  /** The caller is a plain member: they may read but not record entries. */
  | { readonly status: "read-only" }
  | { readonly status: "error" };

interface WireAccount {
  readonly id?: unknown;
  readonly code?: unknown;
}
interface WireGroup {
  readonly groupId?: unknown;
  readonly role?: unknown;
  readonly accounts?: readonly WireAccount[];
}
export interface WirePosting {
  readonly accountId?: unknown;
  readonly direction?: unknown;
  readonly amount?: unknown;
}
export interface WireEntry {
  readonly id?: unknown;
  readonly groupId?: unknown;
  readonly occurredAt?: unknown;
  readonly sequence?: unknown;
  readonly entryType?: unknown;
  readonly correctsEntryId?: unknown;
  readonly postings?: unknown;
}

function minorUnits(amount: string): bigint | null {
  const match = /^(\d+)\.(\d{2})$/.exec(amount);
  return match ? BigInt(match[1]) * 100n + BigInt(match[2]) : null;
}

function toTarget(entry: WireEntry): LiveCorrectionTarget | null {
  if (
    typeof entry.id !== "string" ||
    typeof entry.groupId !== "string" ||
    typeof entry.occurredAt !== "string" ||
    typeof entry.sequence !== "string" ||
    typeof entry.entryType !== "string" ||
    !Array.isArray(entry.postings)
  ) {
    return null;
  }
  let total = 0n;
  const postings: LedgerPostingInput[] = [];
  for (const posting of entry.postings as WirePosting[]) {
    const units = typeof posting.amount === "string" ? minorUnits(posting.amount) : null;
    if (
      units === null ||
      typeof posting.accountId !== "string" ||
      (posting.direction !== "debit" && posting.direction !== "credit")
    ) {
      return null;
    }
    postings.push({ accountId: posting.accountId, direction: posting.direction, amount: posting.amount as string });
    if (posting.direction === "debit") {
      total += units;
    }
  }
  const amount = `${total / 100n}.${(total % 100n).toString().padStart(2, "0")}`;
  return {
    id: entry.id,
    groupId: entry.groupId,
    occurredAt: entry.occurredAt,
    postings,
    type: entry.entryType as LedgerEntryType,
    sequence: entry.sequence,
    amount,
    direction: entry.entryType === "contribution" ? "inbound" : "outbound",
    reference: `#${entry.sequence}`
  };
}

/** The caller's single group, with its chart of accounts and raw entries. */
export type GroupLedgerRead =
  | {
      readonly status: "ok";
      readonly groupId: string;
      readonly accounts: readonly { readonly id: string; readonly code: string }[];
      readonly entries: readonly WireEntry[];
    }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "multiple-groups" }
  | { readonly status: "read-only" }
  | { readonly status: "error" };

/**
 * Read the caller's group from `GET /api/my-groups`, then its entries from
 * `GET /api/ledger/entries`. The one place that sequence lives, shared by the
 * correction form and the home screen.
 *
 * Every non-success is a distinct result, because "you have nothing" and "we
 * could not look" must not render the same. With more than one group this
 * refuses rather than choosing: picking the group someone is acting for is
 * exactly the guess that puts money on the wrong ledger.
 *
 * `writerOnly` is for callers that go on to record entries: only the owner and
 * treasurer may (the database enforces it), so say so up front rather than
 * letting a submit fail with a 403. Readers pass nothing: any member may read.
 */
export async function readGroupLedger(
  deps: AuthedFetchDeps = {},
  options: { readonly writerOnly?: boolean; readonly limit?: number } = {}
): Promise<GroupLedgerRead> {
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
    if (options.writerOnly && groups[0].role === "member") {
      return { status: "read-only" };
    }

    const limitQuery = options.limit === undefined ? "" : `&limit=${options.limit}`;
    const entriesResponse = await authedFetch(
      `/api/ledger/entries?groupId=${encodeURIComponent(groupId)}${limitQuery}`,
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
    const accounts = (Array.isArray(groups[0].accounts) ? groups[0].accounts : []).flatMap(
      (account: WireAccount) =>
        typeof account?.id === "string" && typeof account.code === "string"
          ? [{ id: account.id, code: account.code }]
          : []
    );
    return { status: "ok", groupId, accounts, entries: wire };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

/**
 * Load the entries the correction form can target: the caller's group, then
 * its entries (see `readGroupLedger`).
 */
export async function loadCorrectionTargets(deps: AuthedFetchDeps = {}): Promise<LiveLedgerResult> {
  const read = await readGroupLedger(deps, { writerOnly: true });
  if (read.status !== "ok") {
    return { status: read.status };
  }
  const wire = read.entries;
  const alreadyCorrected = new Set(wire.map((entry) => entry.correctsEntryId));
  const targets = wire
    .filter((entry) => entry.entryType !== "correction" && !alreadyCorrected.has(entry.id))
    .map(toTarget);
  if (targets.some((target) => target === null)) {
    return { status: "error" };
  }
  return targets.length === 0
    ? { status: "empty" }
    : { status: "ready", targets: targets as LiveCorrectionTarget[] };
}
