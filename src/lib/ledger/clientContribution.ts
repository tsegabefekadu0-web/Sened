import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { listCycles } from "@/lib/draw/clientDraw";
import { attributeCodeFromServer, type AttributeFailureCode } from "./attributionCodes";
import { loadMembers } from "./clientInvites";
import type { ContributionChannel } from "./paymentChannel";
import { readMyGroup, type GroupChoiceOptions } from "./clientRead";
import { formatEtbAmount, isEtbAmount } from "./money";
import type { LedgerEntryRequest } from "./types";

/**
 * Browser side of "record a contribution" (ROADMAP 4.2): one balanced
 * contribution (debit `POT_CASH`, credit `CONTRIBUTION_INCOME`) plus the payer it
 * was attributed to, in a single `POST /api/ledger/entries`.
 *
 * The entry and the attribution are two writes and the ledger is the source of
 * truth: a refused attribution is REPORTED (`attribution.status: "refused"`) while
 * the entry stays posted, and the treasurer retries only the attribution
 * (`attributePayer`), never the entry.
 */

export interface ContributionPayer {
  readonly memberUserId: string;
  readonly cycleId?: string;
  readonly round?: number;
  /** How it was paid, when the treasurer said. A cash contribution has no bank to say it for them. */
  readonly channel?: ContributionChannel;
  /** A short plain-text note (trimmed, 1..280 characters), when the treasurer wrote one. */
  readonly note?: string;
}

/** What became of the attribution that rode along on the post. */
export type PostedAttribution =
  | { readonly status: "recorded"; readonly replayed: boolean }
  | { readonly status: "refused"; readonly code: AttributeFailureCode }
  /** The attribution write itself failed (storage); nothing says it was refused. Retry it. */
  | { readonly status: "failed" };

export type PostContributionResult =
  | {
      readonly status: "created";
      readonly entryId: string;
      readonly sequence: string;
      readonly replayed: boolean;
      /** Present when an attribution was sent. */
      readonly attribution?: PostedAttribution;
    }
  | { readonly status: "invalid" }
  | { readonly status: "unauthorized" }
  | { readonly status: "forbidden" }
  | { readonly status: "conflict" }
  | { readonly status: "rate-limited" }
  | { readonly status: "error" };

export interface BuildContributionInput {
  readonly groupId: string;
  readonly cashAccountId: string;
  readonly incomeAccountId: string;
  /** Exact decimal ETB as typed ("250", "250.5", "250.50"); must be positive. */
  readonly amount: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
}

export class ContributionBuildError extends Error {
  constructor(readonly code: "amount" | "date" | "accounts") {
    super(code);
    this.name = "ContributionBuildError";
  }
}

/**
 * The ledger request for one contribution. Pure, so a retry rebuilds the
 * identical body. The amount goes through the same money helpers as the server
 * (`isEtbAmount`, `formatEtbAmount`): never a float.
 */
export function buildContributionRequest(input: BuildContributionInput): LedgerEntryRequest {
  const amount = input.amount.trim();
  if (!isEtbAmount(amount, true)) {
    throw new ContributionBuildError("amount");
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    throw new ContributionBuildError("date");
  }
  if (!input.cashAccountId || !input.incomeAccountId || input.cashAccountId === input.incomeAccountId) {
    throw new ContributionBuildError("accounts");
  }
  const wire = formatEtbAmount(amount);
  return {
    groupId: input.groupId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt.toISOString(),
    entryType: "contribution",
    postings: [
      { accountId: input.cashAccountId, direction: "debit", amount: wire },
      { accountId: input.incomeAccountId, direction: "credit", amount: wire }
    ]
  };
}

/** A fresh idempotency key for one attempt. Matches the server's pattern. */
export function newContributionIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `contrib-${cryptoApi.randomUUID()}`;
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `contrib-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toPostedAttribution(value: unknown): PostedAttribution | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.status === "recorded") return { status: "recorded", replayed: raw.replayed === true };
  if (raw.status === "refused") return { status: "refused", code: attributeCodeFromServer(raw.error) };
  if (raw.status === "failed") return { status: "failed" };
  // An attribution report this client does not understand is not a success.
  return { status: "failed" };
}

/**
 * `POST /api/ledger/entries` with the signed-in user's token. A 200 is the server
 * saying this idempotency key already posted this exact entry (`replayed`), which
 * is the outcome the person wanted. `error` means the outcome is unknown: retry
 * with the same key.
 */
export async function postContribution(
  request: LedgerEntryRequest,
  payer: ContributionPayer,
  deps: AuthedFetchDeps = {}
): Promise<PostContributionResult> {
  try {
    const response = await authedFetch(
      "/api/ledger/entries",
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          attribution: {
            memberUserId: payer.memberUserId,
            ...(payer.cycleId === undefined ? {} : { cycleId: payer.cycleId }),
            ...(payer.round === undefined ? {} : { round: payer.round }),
            ...(payer.channel === undefined ? {} : { channel: payer.channel }),
            ...(payer.note === undefined ? {} : { note: payer.note })
          }
        })
      },
      deps
    );
    if (response.status === 200 || response.status === 201) {
      const body = (await response.json().catch(() => null)) as {
        entry?: { id?: unknown; sequence?: unknown };
        replayed?: unknown;
        attribution?: unknown;
      } | null;
      if (!body || typeof body.entry?.sequence !== "string" || typeof body.entry.id !== "string") {
        return { status: "error" };
      }
      const attribution = toPostedAttribution(body.attribution);
      return {
        status: "created",
        entryId: body.entry.id,
        sequence: body.entry.sequence,
        replayed: body.replayed === true,
        // The attribution was sent: a response that says nothing about it is not a recorded payer.
        attribution: attribution ?? { status: "failed" }
      };
    }
    switch (response.status) {
      case 400:
      case 422:
        return { status: "invalid" };
      case 401:
        return { status: "unauthorized" };
      case 403:
        return { status: "forbidden" };
      case 409:
        return { status: "conflict" };
      case 429:
        return { status: "rate-limited" };
      default:
        return { status: "error" };
    }
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

// -- what the form needs to know about the group ---------------------------

export interface PayerMemberChoice {
  readonly userId: string;
  /** The login email only when the members API showed it to this caller, else null. */
  readonly email: string | null;
}

export interface PayerCycleChoice {
  readonly cycleId: string;
  readonly name: string;
  readonly totalRounds: number;
  readonly contributionAmount: string | null;
  readonly nextRound: number | null;
  readonly closed: boolean;
}

export type ContributionContext =
  | {
      readonly status: "ready";
      readonly groupId: string;
      /** The group's name, so the form can say which ledger it records to; empty when unnamed. */
      readonly groupName: string;
      readonly cashAccountId: string;
      readonly incomeAccountId: string;
      readonly members: readonly PayerMemberChoice[];
      readonly cycles: readonly PayerCycleChoice[];
      /** False when the cycles could not be read: the form still works, without a cycle choice. */
      readonly cyclesLoaded: boolean;
    }
  /** A plain member: may read, may not record. */
  | { readonly status: "read-only" }
  /** The group has no `POT_CASH` / `CONTRIBUTION_INCOME` account to post against. */
  | { readonly status: "no-accounts" }
  | { readonly status: "unauthorized" }
  | { readonly status: "no-group" }
  | { readonly status: "choose-group" }
  | { readonly status: "error" };

export type PayerChoices =
  | {
      readonly status: "ready";
      readonly members: readonly PayerMemberChoice[];
      readonly cycles: readonly PayerCycleChoice[];
      /** False when the cycles could not be read: the payer choice still works, without a cycle. */
      readonly cyclesLoaded: boolean;
    }
  | { readonly status: "unauthorized" | "error" };

/**
 * The payer choices of one group: its active members (required) and its draw
 * cycles (optional: their failure only removes the cycle choice).
 */
export async function loadPayerChoices(groupId: string, deps: AuthedFetchDeps = {}): Promise<PayerChoices> {
  try {
    const [members, cycles] = await Promise.all([loadMembers(groupId, deps), listCycles(groupId, deps)]);
    if (members.status === "unauthorized") return { status: "unauthorized" };
    if (members.status !== "ready") return { status: "error" };
    return {
      status: "ready",
      members: members.members.map((member) => ({ userId: member.userId, email: member.email })),
      cycles: cycles.ok
        ? cycles.data.map((cycle) => ({
            cycleId: cycle.cycleId,
            name: cycle.name,
            totalRounds: cycle.totalRounds,
            contributionAmount: cycle.contributionAmount,
            nextRound: cycle.nextRound,
            closed: cycle.closedAt !== null
          }))
        : [],
      cyclesLoaded: cycles.ok
    };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

/**
 * Resolve the active group, the caller's role, the two accounts and the payer
 * choices (see `loadPayerChoices`).
 */
export async function loadContributionContext(
  deps: AuthedFetchDeps = {},
  options: GroupChoiceOptions = {}
): Promise<ContributionContext> {
  try {
    const mine = await readMyGroup(deps, { groupId: options.groupId });
    if (mine.status !== "ok") {
      return { status: mine.status };
    }
    if (mine.role !== "owner" && mine.role !== "treasurer") {
      return { status: "read-only" };
    }
    const byCode = new Map(mine.accounts.map((account) => [account.code, account.id]));
    const cashAccountId = byCode.get("POT_CASH");
    const incomeAccountId = byCode.get("CONTRIBUTION_INCOME");
    if (!cashAccountId || !incomeAccountId) {
      return { status: "no-accounts" };
    }
    const choices = await loadPayerChoices(mine.groupId, deps);
    if (choices.status !== "ready") return { status: choices.status };
    return {
      status: "ready",
      groupId: mine.groupId,
      groupName: mine.groupName,
      cashAccountId,
      incomeAccountId,
      members: choices.members,
      cycles: choices.cycles,
      cyclesLoaded: choices.cyclesLoaded
    };
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}
