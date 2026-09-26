import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

import { DrawError } from "./errors";
import type { DrawRiskAssessment } from "./types";

/**
 * M4.2 — default risk and reserve retention.
 *
 * The classic ROSCA failure mode is not a rigged draw. It is the winning member
 * receiving the pot and then stopping, so the remaining rounds are
 * under-funded and the cycle collapses with real money missing. A fair draw
 * that pays 100% of the pot on every round actively makes this worse: after the
 * first payout the only money left is whatever members still choose to send.
 *
 * So the engine never pays the whole pot. It retains a reserve sized to the
 * actual exposure created by this particular payout, and it reports the
 * reasoning rather than a bare number.
 *
 * This is a deterministic heuristic informed by the ROSCA default literature
 * (Abebe et al., AAAI 2022, and the wider rotating savings-group literature).
 * It is **not** a proof of equilibrium and is not presented as one. Every
 * figure below is reproducible by hand from the published round values.
 */

/** Basis points. 10000 bps = 100%. */
export const BPS_SCALE = 10_000n;

/**
 * The reserve may never grow past this share of the pot. Past roughly a third
 * the pot stops being a payout and becomes a savings account, which defeats the
 * purpose of the draw. If exposure genuinely exceeds this we would rather
 * report an inadequate reserve than silently pay out almost nothing.
 */
export const MAX_RESERVE_BPS = 3_333n;

export interface ReserveRequest {
  readonly drawId: string;
  readonly round: number;
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly totalRounds: number;
  readonly contributionAmount: string;
  readonly eligibleCount: number;
}

export interface ReservePlan {
  readonly potMinor: bigint;
  readonly baseReserveMinor: bigint;
  readonly exposureMinor: bigint;
  readonly reserveMinor: bigint;
  readonly payoutMinor: bigint;
  readonly capped: boolean;
  readonly notes: readonly string[];
}

function requireMinorUnits(value: string, label: string): bigint {
  try {
    return toEtbMinorUnits(value, true);
  } catch {
    throw new DrawError("INVALID_AMOUNT", `${label} is not a positive ETB amount`);
  }
}

function bpsOf(value: bigint, ratioBps: number): bigint {
  return (value * BigInt(ratioBps)) / BPS_SCALE;
}

/**
 * Size the reserve for the exposure this payout creates, then compute the
 * payout as whatever is left. All arithmetic is in ETB minor units via
 * `bigint` — the ledger's money helpers, never floating point.
 */
export function planReserve(request: ReserveRequest): ReservePlan {
  const potMinor = requireMinorUnits(request.potAmount, "potAmount");
  const shareMinor = requireMinorUnits(request.contributionAmount, "contributionAmount");

  if (!Number.isInteger(request.reserveRatioBps) || request.reserveRatioBps < 0) {
    throw new DrawError("INVALID_REQUEST", "reserveRatioBps must be a non-negative integer");
  }
  if (request.reserveRatioBps > Number(MAX_RESERVE_BPS)) {
    throw new DrawError(
      "INVALID_REQUEST",
      `reserveRatioBps must not exceed ${MAX_RESERVE_BPS} basis points`
    );
  }
  if (!Number.isInteger(request.totalRounds) || request.totalRounds < 1) {
    throw new DrawError("INVALID_REQUEST", "totalRounds must be a positive integer");
  }
  if (!Number.isInteger(request.round) || request.round < 1 || request.round > request.totalRounds) {
    throw new DrawError(
      "INVALID_REQUEST",
      "round must fall within the cycle's rounds"
    );
  }
  if (!Number.isInteger(request.eligibleCount) || request.eligibleCount < 1) {
    throw new DrawError(
      "NO_ELIGIBLE_PARTICIPANTS",
      "A reserve cannot be planned without at least one eligible participant"
    );
  }

  // Rounds still owed after this payout, including this one if it is unpaid.
  const roundsRemaining = BigInt(request.totalRounds - request.round + 1);

  /**
   * The most a single member can walk away with: every share they still owe
   * across the rounds that follow their win. A member drawn in the last round
   * has no exposure at all, which is exactly why rotation is a real
   * risk-management tool and not only a fairness one.
   */
  const singleMemberExposure = shareMinor * (roundsRemaining - 1n);

  /**
   * Worst case if every eligible member stops contributing at once. This is the
   * ceiling the reserve is allowed to grow toward, never the target.
   */
  const aggregateExposure = singleMemberExposure * BigInt(request.eligibleCount);

  const baseReserveMinor = bpsOf(potMinor, request.reserveRatioBps);
  const desiredMinor = baseReserveMinor > singleMemberExposure ? baseReserveMinor : singleMemberExposure;
  const capMinor = bpsOf(potMinor, Number(MAX_RESERVE_BPS));
  const reserveMinor = desiredMinor > capMinor ? capMinor : desiredMinor;
  const payoutMinor = potMinor - reserveMinor;

  const notes: string[] = [];
  notes.push(
    `Base reserve is ${formatEtbMinorUnits(baseReserveMinor)} ETB (${request.reserveRatioBps} bps of the pot).`
  );
  if (singleMemberExposure > 0n) {
    notes.push(
      `A member drawn this round still owes ${formatEtbMinorUnits(singleMemberExposure)} ETB across the remaining rounds, so the reserve is raised to cover one member's default.`
    );
  } else {
    notes.push("This is the final round, so no member retains contribution exposure.");
  }
  if (desiredMinor > capMinor) {
    notes.push(
      `Full exposure coverage would need ${formatEtbMinorUnits(desiredMinor)} ETB, above the ${MAX_RESERVE_BPS} bps ceiling, so the reserve is capped. The cycle is under-funded and needs a member vote.`
    );
  }

  if (payoutMinor <= 0n) {
    throw new DrawError(
      "INVALID_AMOUNT",
      "The reserve model would consume the whole pot; refusing to post a zero-value payout"
    );
  }

  return {
    potMinor,
    baseReserveMinor,
    exposureMinor: aggregateExposure,
    reserveMinor,
    payoutMinor,
    capped: desiredMinor > capMinor,
    notes
  };
}

export function assessDrawRisk(
  request: ReserveRequest,
  plan: ReservePlan
): DrawRiskAssessment {
  const shareMinor = requireMinorUnits(request.contributionAmount, "contributionAmount");
  const roundsRemaining = BigInt(request.totalRounds - request.round + 1);
  const participantMinor = shareMinor * roundsRemaining;

  // What the cycle must still be able to pay out for the rounds that follow.
  const remainingObligation = participantMinor * BigInt(request.eligibleCount);
  const coverageBps =
    remainingObligation === 0n
      ? BPS_SCALE
      : (plan.reserveMinor * BPS_SCALE) / remainingObligation;
  const cappedCoverageBps = coverageBps > BPS_SCALE ? BPS_SCALE : coverageBps;

  const singleDefault = participantMinor;
  const covers =
    singleDefault === 0n ? Number.MAX_SAFE_INTEGER : Number(plan.reserveMinor / singleDefault);

  const winnerOutstanding = participantMinor - shareMinor;

  const notes = [...plan.notes];
  notes.push(
    `The reserve covers ${cappedCoverageBps === BPS_SCALE ? "100" : String(cappedCoverageBps / 100n)}% of the ${formatEtbMinorUnits(remainingObligation)} ETB still owed across the remaining rounds.`
  );
  if (covers <= 0) {
    notes.push(
      "The reserve cannot absorb even one member's default. Treat the remaining rounds as at risk."
    );
  }

  return {
    drawId: request.drawId,
    round: request.round,
    potAmount: formatEtbMinorUnits(plan.potMinor),
    payoutAmount: formatEtbMinorUnits(plan.payoutMinor),
    reserveAmount: formatEtbMinorUnits(plan.reserveMinor),
    reserveRatioBps: request.reserveRatioBps,
    participantsAfterWin: Math.max(0, request.eligibleCount - 1),
    winnerOutstandingMinor: formatEtbMinorUnits(winnerOutstanding),
    reserveCoversDefaults: covers,
    reserveAdequate: plan.capped === false && plan.reserveMinor >= singleDefault,
    notes
  };
}
