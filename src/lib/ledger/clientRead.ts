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
  /** The caller is in several groups and none is chosen yet: the group switcher decides. */
  | { readonly status: "choose-group" }
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
  readonly recordedAt?: unknown;
  readonly sequence?: unknown;
  readonly entryType?: unknown;
  readonly correctsEntryId?: unknown;
  readonly postings?: unknown;
  readonly provenance?: unknown;
  readonly attribution?: unknown;
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

/** The active group's ledger: its chart of accounts and raw entries. */
export type GroupLedgerRead =
  | {
      readonly status: "ok";
      readonly groupId: string;
      readonly accounts: readonly { readonly id: string; readonly code: string }[];
      readonly entries: readonly WireEntry[];
    }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "choose-group" }
  | { readonly status: "read-only" }
  | { readonly status: "error" };

/** One of the caller's groups (id, role, chart of accounts) from `GET /api/my-groups`. */
export type MyGroupRead =
  | {
      readonly status: "ok";
      readonly groupId: string;
      readonly role: string | null;
      readonly accounts: readonly { readonly id: string; readonly code: string }[];
    }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "choose-group" }
  | { readonly status: "error" };

/** Which of the caller's groups to act on. */
export interface GroupChoiceOptions {
  /**
   * The caller's active group (see `src/lib/groups`). It is only a preference:
   * it is used when it is one of the groups the server just returned for this
   * caller, and ignored otherwise (a stale or foreign id never takes effect).
   * The server re-checks membership for every group id regardless.
   */
  readonly groupId?: string | null;
}

/**
 * Pick the group the caller is acting for from the groups the server returned
 * for them: the preferred one when it is among them, the only one when there
 * is exactly one, otherwise nothing (the caller must choose). Never guesses
 * among several, because that is how money lands on the wrong ledger.
 */
export function pickGroup<T extends { readonly groupId?: unknown }>(
  groups: readonly T[],
  preferred: string | null | undefined
): T | null {
  if (preferred) {
    const match = groups.find((group) => group.groupId === preferred);
    if (match) {
      return match;
    }
  }
  return groups.length === 1 ? groups[0] : null;
}

/**
 * Resolve which group the caller is acting for: the preferred (active) group if
 * they belong to it, else their only group. With none there is nothing to act
 * on; with several and no valid preference this reports `choose-group` rather
 * than choosing.
 */
export async function readMyGroup(
  deps: AuthedFetchDeps = {},
  options: GroupChoiceOptions = {}
): Promise<MyGroupRead> {
  try {
    const response = await authedFetch("/api/my-groups", { method: "GET" }, deps);
    if (response.status === 401) {
      return { status: "unauthorized" };
    }
    if (!response.ok) {
      return { status: "error" };
    }
    const groups = ((await response.json()) as { groups?: readonly WireGroup[] }).groups ?? [];
    if (groups.length === 0) {
      return { status: "no-group" };
    }
    const group = pickGroup(groups, options.groupId);
    if (group === null) {
      return { status: "choose-group" };
    }
    if (typeof group.groupId !== "string") {
      return { status: "error" };
    }
    const accounts = (Array.isArray(group.accounts) ? group.accounts : []).flatMap((account: WireAccount) =>
      typeof account?.id === "string" && typeof account.code === "string"
        ? [{ id: account.id, code: account.code }]
        : []
    );
    return {
      status: "ok",
      groupId: group.groupId,
      role: typeof group.role === "string" ? group.role : null,
      accounts
    };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

/** One page of `GET /api/ledger/entries`, newest first. */
export type EntriesPageRead =
  | {
      readonly status: "ok";
      readonly entries: readonly WireEntry[];
      readonly hasMore: boolean;
      /** The `beforeSequence` for the next older page; `null` on the last page. */
      readonly nextCursor: string | null;
    }
  | { readonly status: "unauthorized" }
  | { readonly status: "error" };

/**
 * One page of a group's entries. `beforeSequence` pages back through history
 * (exclusive upper bound). A server that predates the cursor omits `hasMore`;
 * that is read as "no more", which is only wrong for the older, capped route
 * and is what those callers already assumed.
 */
export async function readEntriesPage(
  groupId: string,
  options: { readonly limit?: number; readonly beforeSequence?: string } = {},
  deps: AuthedFetchDeps = {}
): Promise<EntriesPageRead> {
  try {
    const query =
      `groupId=${encodeURIComponent(groupId)}` +
      (options.limit === undefined ? "" : `&limit=${options.limit}`) +
      (options.beforeSequence === undefined ? "" : `&beforeSequence=${encodeURIComponent(options.beforeSequence)}`);
    const response = await authedFetch(`/api/ledger/entries?${query}`, { method: "GET" }, deps);
    if (response.status === 401) {
      return { status: "unauthorized" };
    }
    if (!response.ok) {
      return { status: "error" };
    }
    const body = (await response.json()) as { entries?: readonly WireEntry[]; hasMore?: unknown; nextCursor?: unknown };
    if (!Array.isArray(body.entries)) {
      return { status: "error" };
    }
    const hasMore = body.hasMore === true;
    if (hasMore && (typeof body.nextCursor !== "string" || !/^[1-9]\d{0,18}$/.test(body.nextCursor))) {
      return { status: "error" };
    }
    return {
      status: "ok",
      entries: body.entries,
      hasMore,
      nextCursor: hasMore ? (body.nextCursor as string) : null
    };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

export interface WireBalance {
  readonly accountId: string;
  readonly code: string;
  readonly accountType: string;
  /** Exact ETB decimal string, debit-positive. */
  readonly balance: string;
}

/** A group's per-account balances at one chain head (`GET /api/ledger/balances`). */
export type BalancesRead =
  | {
      readonly status: "ok";
      readonly headSequence: string;
      readonly entryCount: string;
      readonly balances: readonly WireBalance[];
    }
  | { readonly status: "unauthorized" }
  | { readonly status: "error" };

/** Read and strictly validate the balances snapshot; anything malformed is `error`, never a guess. */
export async function fetchLedgerBalances(groupId: string, deps: AuthedFetchDeps = {}): Promise<BalancesRead> {
  try {
    const response = await authedFetch(
      `/api/ledger/balances?groupId=${encodeURIComponent(groupId)}`,
      { method: "GET" },
      deps
    );
    if (response.status === 401) {
      return { status: "unauthorized" };
    }
    if (!response.ok) {
      return { status: "error" };
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.headSequence !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(body.headSequence) ||
      typeof body.entryCount !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(body.entryCount) ||
      !Array.isArray(body.balances)
    ) {
      return { status: "error" };
    }
    const balances: WireBalance[] = [];
    for (const item of body.balances as readonly Record<string, unknown>[]) {
      if (
        typeof item?.accountId !== "string" ||
        typeof item.code !== "string" ||
        typeof item.accountType !== "string" ||
        typeof item.balance !== "string" ||
        !/^-?\d+\.\d{2}$/.test(item.balance)
      ) {
        return { status: "error" };
      }
      balances.push({ accountId: item.accountId, code: item.code, accountType: item.accountType, balance: item.balance });
    }
    return { status: "ok", headSequence: body.headSequence, entryCount: body.entryCount, balances };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

/**
 * Read the caller's group from `GET /api/my-groups`, then its entries from
 * `GET /api/ledger/entries`. The one place that sequence lives, shared by the
 * correction form and the home screen.
 *
 * Every non-success is a distinct result, because "you have nothing" and "we
 * could not look" must not render the same. The group is the caller's active
 * one (`options.groupId`) or their only one; with several and none chosen this
 * reports `choose-group` rather than guessing.
 *
 * `writerOnly` is for callers that go on to record entries: only the owner and
 * treasurer may (the database enforces it), so say so up front rather than
 * letting a submit fail with a 403. Readers pass nothing: any member may read.
 */
export async function readGroupLedger(
  deps: AuthedFetchDeps = {},
  options: GroupChoiceOptions & { readonly writerOnly?: boolean; readonly limit?: number } = {}
): Promise<GroupLedgerRead> {
  try {
    const mine = await readMyGroup(deps, { groupId: options.groupId });
    if (mine.status !== "ok") {
      return { status: mine.status };
    }
    const { groupId, role } = mine;
    if (options.writerOnly && role === "member") {
      return { status: "read-only" };
    }

    const page = await readEntriesPage(groupId, { limit: options.limit }, deps);
    if (page.status !== "ok") {
      return { status: page.status };
    }
    return { status: "ok", groupId, accounts: mine.accounts, entries: page.entries };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

/**
 * Load the entries the correction form can target: the caller's active group, then
 * its entries (see `readGroupLedger`).
 */
export async function loadCorrectionTargets(
  deps: AuthedFetchDeps = {},
  options: GroupChoiceOptions = {}
): Promise<LiveLedgerResult> {
  const read = await readGroupLedger(deps, { writerOnly: true, groupId: options.groupId });
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
