import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

import { planDrawReserve, type ReservePlan } from "./risk";

/**
 * M4.2 — social collateral and post-win default risk.
 *
 * ADVISORY ONLY. Nothing in this file, in the guarantee records it describes or
 * in the screens built on it debits a guarantor, moves money or writes the
 * ledger. A guarantee is a recorded promise that a named member vouches for a
 * winner's remaining contributions, made with that member's own consent; a "default
 * flag" is a statement about what the ledger can show. What the group does about
 * either is the group's decision.
 *
 * Nothing here is stored as a status. The database derives, on every read
 * (`get_draw_cycle_collateral_v1`), for each winner and each round AFTER the one
 * they won:
 *
 *   met      a qualifying contribution is assigned to the round;
 *   flagged  NOT met, and the round's draw has been OPENED, so it was due;
 *   not_due  NOT met and no draw for that round has been opened yet.
 *
 * A qualifying contribution is a contribution entry that is not reversed by a
 * correction, is attributed to the winner (bank provenance, else the treasurer's
 * record; bank wins), moved at least the cycle's contribution into the pot, was
 * recorded on or after the cycle's start, and is not attributed to another
 * cycle. It is assigned to a round explicitly (an attribution carrying that cycle
 * and round) or by order: the winner's remaining entries, oldest first, fill the
 * earliest still-unmet due round whose previous round had been revealed before
 * the entry was recorded; one entry pays one round. The full rule is in
 * `docs/architecture/draw.md` §17.
 *
 * `flagged` is a flag, not a verdict: it means the ledger cannot show the
 * contribution, not that the member did not pay. It clears the moment an
 * attributed entry exists.
 */

export type OwedRoundStatus = "met" | "flagged" | "not_due";
export type GuaranteeState = "proposed" | "accepted" | "declined" | "released" | "superseded";

export interface OwedRound {
  readonly round: number;
  readonly status: OwedRoundStatus;
  /** When the round's draw was first opened, or `null` while it has not been. */
  readonly dueAt: string | null;
  /** The entry that meets the round, when one does. */
  readonly entryId: string | null;
  /** How the ledger knows who paid that entry: a bank verification or the treasurer's record. */
  readonly source: "bank_verification" | "treasurer" | null;
}

export interface Guarantee {
  readonly guaranteeId: string;
  readonly cycleId: string;
  readonly winnerMemberId: string;
  readonly guarantorMemberId: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly state: GuaranteeState;
  readonly stateAt: string;
  readonly stateBy: string;
  /** When the guarantor themselves accepted, even if it was released afterwards. */
  readonly acceptedAt: string | null;
  readonly reason: string | null;
  readonly successorGuaranteeId: string | null;
}

export interface CollateralWinner {
  readonly memberId: string;
  /** The round they won. */
  readonly round: number;
  readonly revealedAt: string;
  readonly owed: readonly OwedRound[];
  readonly guarantees: readonly Guarantee[];
}

export interface CycleCollateral {
  readonly cycleId: string;
  readonly groupId: string;
  readonly totalRounds: number;
  /** ETB, two decimals. `null` for a cycle created before cycles carried a contribution. */
  readonly contributionAmount: string | null;
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly startedAt: string;
  readonly nextRound: number | null;
  /** Members still eligible to win the next round; `null` when the cycle is complete. */
  readonly eligibleCount: number | null;
  /** ETB, two decimals: the reserve withheld from the payouts already revealed. */
  readonly reserveRetained: string;
  readonly flaggedCount: number;
  readonly winners: readonly CollateralWinner[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES: readonly GuaranteeState[] = ["proposed", "accepted", "declined", "released", "superseded"];
const MONEY = /^\d{1,18}\.\d{2}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableTime(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return isTime(value) ? value : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

/** A guarantee as the database returns it; anything malformed is `null`, never a guess. */
export function parseGuarantee(value: unknown): Guarantee | null {
  const row = record(value);
  if (row === null) return null;
  const acceptedAt = nullableTime(row.acceptedAt);
  const reason = nullableText(row.reason);
  const successor = row.successorGuaranteeId ?? null;
  if (
    !isUuid(row.guaranteeId) ||
    !isUuid(row.cycleId) ||
    !isUuid(row.winnerMemberId) ||
    !isUuid(row.guarantorMemberId) ||
    !isUuid(row.proposedBy) ||
    !isTime(row.proposedAt) ||
    typeof row.state !== "string" ||
    !(STATES as readonly string[]).includes(row.state) ||
    !isTime(row.stateAt) ||
    !isUuid(row.stateBy) ||
    acceptedAt === undefined ||
    reason === undefined ||
    (successor !== null && !isUuid(successor))
  ) {
    return null;
  }
  return {
    guaranteeId: row.guaranteeId.toLowerCase(),
    cycleId: row.cycleId.toLowerCase(),
    winnerMemberId: row.winnerMemberId.toLowerCase(),
    guarantorMemberId: row.guarantorMemberId.toLowerCase(),
    proposedBy: row.proposedBy.toLowerCase(),
    proposedAt: row.proposedAt,
    state: row.state as GuaranteeState,
    stateAt: row.stateAt,
    stateBy: row.stateBy.toLowerCase(),
    acceptedAt,
    reason,
    successorGuaranteeId: successor === null ? null : (successor as string).toLowerCase()
  };
}

function parseOwed(value: unknown): OwedRound | null {
  const row = record(value);
  if (row === null) return null;
  const dueAt = nullableTime(row.dueAt);
  const entryId = row.entryId ?? null;
  const source = row.source ?? null;
  if (
    typeof row.round !== "number" ||
    !Number.isSafeInteger(row.round) ||
    row.round < 1 ||
    (row.status !== "met" && row.status !== "flagged" && row.status !== "not_due") ||
    dueAt === undefined ||
    (entryId !== null && !isUuid(entryId)) ||
    (source !== null && source !== "bank_verification" && source !== "treasurer") ||
    // A met round names its entry and how the payer is known; the others name neither.
    (row.status === "met") !== (entryId !== null && source !== null) ||
    (row.status !== "met" && (entryId !== null || source !== null)) ||
    // `flagged` means a draw was opened, so it has a due time; `not_due` has none.
    (row.status === "flagged" && dueAt === null) ||
    (row.status === "not_due" && dueAt !== null)
  ) {
    return null;
  }
  return {
    round: row.round,
    status: row.status,
    dueAt,
    entryId: entryId === null ? null : (entryId as string).toLowerCase(),
    source: source as OwedRound["source"]
  };
}

function parseWinner(value: unknown): CollateralWinner | null {
  const row = record(value);
  if (row === null) return null;
  if (
    !isUuid(row.memberId) ||
    typeof row.round !== "number" ||
    !Number.isSafeInteger(row.round) ||
    row.round < 1 ||
    !isTime(row.revealedAt) ||
    !Array.isArray(row.owed) ||
    !Array.isArray(row.guarantees)
  ) {
    return null;
  }
  const owed: OwedRound[] = [];
  for (const raw of row.owed) {
    const parsed = parseOwed(raw);
    if (parsed === null) return null;
    owed.push(parsed);
  }
  const guarantees: Guarantee[] = [];
  for (const raw of row.guarantees) {
    const parsed = parseGuarantee(raw);
    if (parsed === null) return null;
    guarantees.push(parsed);
  }
  return { memberId: row.memberId.toLowerCase(), round: row.round, revealedAt: row.revealedAt, owed, guarantees };
}

/** The derived collateral view of a cycle; anything malformed is `null`, never a guess. */
export function parseCycleCollateral(value: unknown): CycleCollateral | null {
  const row = record(value);
  if (row === null) return null;
  const contribution = row.contributionAmount ?? null;
  const eligible = row.eligibleCount ?? null;
  const next = row.nextRound ?? null;
  if (
    !isUuid(row.cycleId) ||
    !isUuid(row.groupId) ||
    typeof row.totalRounds !== "number" ||
    !Number.isSafeInteger(row.totalRounds) ||
    row.totalRounds < 1 ||
    (contribution !== null && (typeof contribution !== "string" || !MONEY.test(contribution))) ||
    typeof row.potAmount !== "string" ||
    !MONEY.test(row.potAmount) ||
    typeof row.reserveRatioBps !== "number" ||
    !Number.isSafeInteger(row.reserveRatioBps) ||
    !isTime(row.startedAt) ||
    (next !== null && (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1)) ||
    (eligible !== null && (typeof eligible !== "number" || !Number.isSafeInteger(eligible) || eligible < 0)) ||
    typeof row.reserveRetained !== "string" ||
    !MONEY.test(row.reserveRetained) ||
    typeof row.flaggedCount !== "number" ||
    !Number.isSafeInteger(row.flaggedCount) ||
    row.flaggedCount < 0 ||
    !Array.isArray(row.winners)
  ) {
    return null;
  }
  const winners: CollateralWinner[] = [];
  for (const raw of row.winners) {
    const parsed = parseWinner(raw);
    if (parsed === null) return null;
    winners.push(parsed);
  }
  return {
    cycleId: row.cycleId.toLowerCase(),
    groupId: row.groupId.toLowerCase(),
    totalRounds: row.totalRounds,
    contributionAmount: contribution as string | null,
    potAmount: row.potAmount,
    reserveRatioBps: row.reserveRatioBps,
    startedAt: row.startedAt,
    nextRound: next as number | null,
    eligibleCount: eligible as number | null,
    reserveRetained: row.reserveRetained,
    flaggedCount: row.flaggedCount,
    winners
  };
}

// -- derived figures ------------------------------------------------------------

export interface WinnerExposure {
  readonly memberId: string;
  /** The round they won. */
  readonly winRound: number;
  /** Rounds after their win: what they still owe the cycle. */
  readonly roundsOwed: number;
  readonly roundsMet: number;
  /** Due, and no qualifying contribution attributed. */
  readonly roundsFlagged: number;
  readonly roundsNotDue: number;
  /** ETB, two decimals: the contribution times the rounds not yet met. `null` when the cycle has no contribution on record. */
  readonly outstanding: string | null;
  /** ETB, two decimals: the contribution times the flagged rounds. */
  readonly overdue: string | null;
  /** Guarantors who have accepted themselves, and those still only proposed. */
  readonly acceptedGuarantors: number;
  readonly pendingGuarantors: number;
}

export interface CollateralSummary {
  readonly winners: readonly WinnerExposure[];
  /** ETB: everything the winners have yet to contribute. `null` without a contribution on record. */
  readonly totalOutstanding: string | null;
  /** ETB: the part of it that is flagged. */
  readonly totalOverdue: string | null;
  /** ETB: the reserve withheld from payouts so far. */
  readonly reserveRetained: string;
  /** Whether the retained reserve covers what is flagged. `null` without a contribution on record. */
  readonly reserveCoversOverdue: boolean | null;
  readonly flaggedCount: number;
}

export function summarizeCollateral(view: CycleCollateral): CollateralSummary {
  const share = view.contributionAmount === null ? null : toEtbMinorUnits(view.contributionAmount);
  let outstandingTotal = 0n;
  let overdueTotal = 0n;
  const winners = view.winners.map((winner): WinnerExposure => {
    const count = (status: OwedRoundStatus): number => winner.owed.filter((round) => round.status === status).length;
    const met = count("met");
    const flagged = count("flagged");
    const notDue = count("not_due");
    const outstanding = share === null ? null : share * BigInt(flagged + notDue);
    const overdue = share === null ? null : share * BigInt(flagged);
    if (outstanding !== null && overdue !== null) {
      outstandingTotal += outstanding;
      overdueTotal += overdue;
    }
    return {
      memberId: winner.memberId,
      winRound: winner.round,
      roundsOwed: winner.owed.length,
      roundsMet: met,
      roundsFlagged: flagged,
      roundsNotDue: notDue,
      outstanding: outstanding === null ? null : formatEtbMinorUnits(outstanding),
      overdue: overdue === null ? null : formatEtbMinorUnits(overdue),
      acceptedGuarantors: winner.guarantees.filter((entry) => entry.state === "accepted").length,
      pendingGuarantors: winner.guarantees.filter((entry) => entry.state === "proposed").length
    };
  });
  return {
    winners,
    totalOutstanding: share === null ? null : formatEtbMinorUnits(outstandingTotal),
    totalOverdue: share === null ? null : formatEtbMinorUnits(overdueTotal),
    reserveRetained: view.reserveRetained,
    reserveCoversOverdue: share === null ? null : toEtbMinorUnits(view.reserveRetained) >= overdueTotal,
    flaggedCount: view.flaggedCount
  };
}

/**
 * The reserve the draw (`planDrawReserve`: the cycle's ratio of the pot) would withhold from the NEXT
 * payout, for display beside the exposure. `null` when the cycle is complete or
 * the figures `planReserve` needs are not on record; never an invented number.
 */
export function planNextReserve(view: CycleCollateral): ReservePlan | null {
  if (view.nextRound === null || view.eligibleCount === null || view.eligibleCount < 1 || view.contributionAmount === null) {
    return null;
  }
  try {
    return planDrawReserve({
      drawId: view.cycleId,
      round: view.nextRound,
      potAmount: view.potAmount,
      reserveRatioBps: view.reserveRatioBps,
      totalRounds: view.totalRounds,
      contributionAmount: view.contributionAmount,
      eligibleCount: view.eligibleCount
    });
  } catch {
    return null;
  }
}
