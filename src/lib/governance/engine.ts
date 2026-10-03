import { planReserve } from "@/lib/draw/risk";
import { formatEtbGrouped, formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

import type { CitationId } from "./citations";
import { GovernanceError } from "./errors";
import {
  GROUP_TYPES,
  MAX_CYCLE_DAYS,
  MAX_MEMBERS,
  TRUST_LEVELS,
  type BylawClause,
  type ClauseParameter,
  type GovernanceInput,
  type GovernanceRecommendation,
  type GovernanceWarning,
  type TrustLevel
} from "./types";

/**
 * M5.2 — bylaw and penalty recommendation engine.
 *
 * Deterministic, no network, no LLM: the same input always produces the same
 * clauses, in the same order, forever. Every figure can be recomputed by hand.
 *
 * ## What this is, and is not
 *
 * These are **rules of thumb for a treasurer to put to a vote**. The citations
 * attached to each clause point at literature on rotating savings groups,
 * default, and risk-sharing that the project's README lists; they are context
 * for *why the topic matters*, not a proof that a given percentage is optimal.
 * Specific numbers (penalty percentages, grace days, vote thresholds, waiting
 * periods) are this project's own defaults, scaled by how well members know one
 * another. The rationale text says so.
 *
 * The one place a number comes from an existing model is post-win default
 * protection, which calls `planReserve` from
 * `src/lib/draw/risk.ts` so the advice and the draw engine cannot disagree.
 *
 * Nothing here writes to the ledger.
 */

/** Largest amount accepted, in ETB minor units (1,000,000,000.00 ETB). */
export const MAX_AMOUNT_MINOR = 100_000_000_000n;

/** Reserve held back from an Equb pot, in basis points, by member familiarity. */
export const RESERVE_BPS_BY_TRUST: Readonly<Record<TrustLevel, number>> = {
  close: 500,
  mixed: 1_000,
  new: 1_500
};

/** Late penalty per late cycle, in basis points of one contribution. */
export const EQUB_PENALTY_BPS_BY_TRUST: Readonly<Record<TrustLevel, number>> = {
  close: 200,
  mixed: 300,
  new: 500
};

/** Iddir penalties are gentler: the dues fund a cover, not a pot. */
export const IDDIR_PENALTY_BPS_BY_TRUST: Readonly<Record<TrustLevel, number>> = {
  close: 100,
  mixed: 150,
  new: 250
};

export const VOTE_THRESHOLD_BPS_BY_TRUST: Readonly<Record<TrustLevel, number>> = {
  close: 6_000,
  mixed: 6_667,
  new: 7_500
};

export const CLAIM_WAITING_DAYS_BY_TRUST: Readonly<Record<TrustLevel, number>> = {
  close: 30,
  mixed: 60,
  new: 90
};

export const EQUB_SUSPEND_AFTER_MISSED = 2;
export const IDDIR_SUSPEND_AFTER_MISSED = 3;
/** Advance on a medical emergency, as a share of one typical claim. */
export const MEDICAL_ADVANCE_BPS = 5_000;
export const SMALL_GROUP_THRESHOLD = 5;
export const SLOW_FUND_CYCLES = 24;
export const LONG_CYCLE_DAYS = 31;

const BPS = 10_000n;

function money(input: string, label: string, positive: boolean): bigint {
  let minor: bigint;
  try {
    minor = toEtbMinorUnits(input, positive);
  } catch {
    throw new GovernanceError(`${label} is not a valid ETB amount`);
  }
  if (minor > MAX_AMOUNT_MINOR) {
    throw new GovernanceError(`${label} is too large`);
  }
  return minor;
}

function validate(input: GovernanceInput): {
  readonly contributionMinor: bigint;
  readonly claimMinor: bigint | null;
  readonly balanceMinor: bigint;
} {
  if (!(GROUP_TYPES as readonly string[]).includes(input.groupType)) {
    throw new GovernanceError("groupType must be equb or iddir");
  }
  if (!(TRUST_LEVELS as readonly string[]).includes(input.trust)) {
    throw new GovernanceError("trust must be close, mixed or new");
  }
  if (!Number.isInteger(input.memberCount) || input.memberCount < 2 || input.memberCount > MAX_MEMBERS) {
    throw new GovernanceError(`memberCount must be a whole number from 2 to ${MAX_MEMBERS}`);
  }
  if (
    !Number.isInteger(input.cycleLengthDays) ||
    input.cycleLengthDays < 1 ||
    input.cycleLengthDays > MAX_CYCLE_DAYS
  ) {
    throw new GovernanceError(`cycleLengthDays must be a whole number from 1 to ${MAX_CYCLE_DAYS}`);
  }
  const contributionMinor = money(input.contributionAmount, "contributionAmount", true);

  if (input.groupType === "equb") {
    if (input.typicalClaimAmount !== undefined || input.currentFundBalance !== undefined) {
      throw new GovernanceError("typicalClaimAmount and currentFundBalance apply to an Iddir only");
    }
    return { contributionMinor, claimMinor: null, balanceMinor: 0n };
  }
  if (input.typicalClaimAmount === undefined) {
    throw new GovernanceError("typicalClaimAmount is required for an Iddir");
  }
  return {
    contributionMinor,
    claimMinor: money(input.typicalClaimAmount, "typicalClaimAmount", true),
    balanceMinor:
      input.currentFundBalance === undefined ? 0n : money(input.currentFundBalance, "currentFundBalance", false)
  };
}

/** `2` -> "2", `2.5` -> "2.5", `66.67` -> "66.67". */
export function formatBps(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

const etb = (minor: bigint): string => formatEtbMinorUnits(minor);
const shown = (minor: bigint): string => formatEtbGrouped(formatEtbMinorUnits(minor));

function graceDaysFor(cycleLengthDays: number): number {
  return Math.max(1, Math.min(5, Math.ceil(cycleLengthDays / 10)));
}

function lateClause(input: GovernanceInput, contributionMinor: bigint): BylawClause {
  const iddir = input.groupType === "iddir";
  const penaltyBps = (iddir ? IDDIR_PENALTY_BPS_BY_TRUST : EQUB_PENALTY_BPS_BY_TRUST)[input.trust];
  const penaltyMinor = (contributionMinor * BigInt(penaltyBps)) / BPS;
  const graceDays = graceDaysFor(input.cycleLengthDays);
  const suspendAfter = iddir ? IDDIR_SUSPEND_AFTER_MISSED : EQUB_SUSPEND_AFTER_MISSED;
  const citations: CitationId[] = iddir ? ["dercon2006", "besley1993"] : ["besley1993", "abebe2022"];

  const parameters: ClauseParameter[] = [
    { key: "graceDays", value: graceDays, unit: "days" },
    { key: "penaltyBps", value: penaltyBps, unit: "bps" },
    { key: "penaltyAmount", value: etb(penaltyMinor), unit: "etb" },
    {
      key: iddir ? "claimsSuspendedAfterMissed" : "suspendAfterMissed",
      value: suspendAfter,
      unit: "count"
    }
  ];
  return {
    id: iddir ? "late.iddir" : "late.equb",
    topic: "late_payment",
    titleKey: iddir ? "governance.clause.late.iddir.title" : "governance.clause.late.equb.title",
    summaryKey: iddir ? "governance.clause.late.iddir.summary" : "governance.clause.late.equb.summary",
    rationaleKey: iddir ? "governance.clause.late.iddir.rationale" : "governance.clause.late.equb.rationale",
    vars: {
      graceDays,
      penaltyPercent: formatBps(penaltyBps),
      penaltyAmount: shown(penaltyMinor),
      suspendAfter,
      cycleDays: input.cycleLengthDays
    },
    parameters,
    citations
  };
}

function replacementClause(input: GovernanceInput, contributionMinor: bigint): BylawClause {
  if (input.groupType === "iddir") {
    const waiting = CLAIM_WAITING_DAYS_BY_TRUST[input.trust];
    return {
      id: "replacement.iddir",
      topic: "replacement",
      titleKey: "governance.clause.replacement.iddir.title",
      summaryKey: "governance.clause.replacement.iddir.summary",
      rationaleKey: "governance.clause.replacement.iddir.rationale",
      vars: { vouchers: 1, waitingDays: waiting },
      parameters: [
        { key: "voucherCount", value: 1, unit: "count" },
        { key: "claimWaitingDays", value: waiting, unit: "days" }
      ],
      citations: ["dercon2006", "wang2021"]
    };
  }
  const vouchers = Math.min(input.trust === "close" ? 1 : 2, input.memberCount - 1);
  const threshold = VOTE_THRESHOLD_BPS_BY_TRUST[input.trust];
  // The most a departing member can leave unpaid is every share owed after a
  // first-round win: the same exposure `planReserve` computes for round 1.
  const worstCaseMinor = contributionMinor * BigInt(input.memberCount - 1);
  return {
    id: "replacement.equb",
    topic: "replacement",
    titleKey: "governance.clause.replacement.equb.title",
    summaryKey: "governance.clause.replacement.equb.summary",
    rationaleKey: "governance.clause.replacement.equb.rationale",
    vars: {
      vouchers,
      votePercent: formatBps(threshold),
      deadlineDays: input.cycleLengthDays,
      outstanding: shown(worstCaseMinor)
    },
    parameters: [
      { key: "voucherCount", value: vouchers, unit: "count" },
      { key: "voteThresholdBps", value: threshold, unit: "bps" },
      { key: "replacementDeadlineDays", value: input.cycleLengthDays, unit: "days" },
      { key: "maxOutstandingAmount", value: etb(worstCaseMinor), unit: "etb" }
    ],
    citations: ["abebe2022", "besley1993", "wang2021"]
  };
}

interface ReserveSummary {
  readonly clause: BylawClause;
  readonly guarantorThroughRound: number;
}

function defaultProtectionClause(input: GovernanceInput, contributionMinor: bigint): ReserveSummary {
  const rounds = input.memberCount;
  const reserveRatioBps = RESERVE_BPS_BY_TRUST[input.trust];
  const contributionAmount = etb(contributionMinor);
  const potAmount = etb(contributionMinor * BigInt(rounds));

  let guarantorThroughRound = 0;
  let firstRound: { reserve: bigint; payout: bigint; exposure: bigint } | null = null;
  for (let round = 1; round <= rounds; round += 1) {
    const request = {
      drawId: `governance-round-${round}`,
      round,
      potAmount,
      reserveRatioBps,
      totalRounds: rounds,
      contributionAmount,
      eligibleCount: rounds - round + 1
    };
    const plan = planReserve(request);
    if (round === 1) {
      firstRound = {
        reserve: plan.reserveMinor,
        payout: plan.payoutMinor,
        exposure: contributionMinor * BigInt(rounds - 1)
      };
    }
    // `capped` is the draw model's own signal that one member's default is
    // larger than the reserve is allowed to grow to.
    if (plan.capped) {
      guarantorThroughRound = round;
    }
  }
  const first = firstRound as { reserve: bigint; payout: bigint; exposure: bigint };

  return {
    guarantorThroughRound,
    clause: {
      id: "default.reserve",
      topic: "default_protection",
      titleKey: "governance.clause.default.reserve.title",
      summaryKey: "governance.clause.default.reserve.summary",
      rationaleKey: "governance.clause.default.reserve.rationale",
      vars: {
        reservePercent: formatBps(reserveRatioBps),
        reserve: shown(first.reserve),
        payout: shown(first.payout),
        guarantorRound: guarantorThroughRound,
        exposure: shown(first.exposure)
      },
      parameters: [
        { key: "baseReserveBps", value: reserveRatioBps, unit: "bps" },
        { key: "round1ReserveAmount", value: etb(first.reserve), unit: "etb" },
        { key: "round1PayoutAmount", value: etb(first.payout), unit: "etb" },
        { key: "guarantorThroughRound", value: guarantorThroughRound, unit: "rounds" },
        { key: "worstCaseExposure", value: etb(first.exposure), unit: "etb" }
      ],
      citations: ["abebe2022", "besley1993"]
    }
  };
}

function reserveClaimsFor(memberCount: number): number {
  if (memberCount < 25) {
    return 3;
  }
  return memberCount < 100 ? 2 : 1;
}

interface FundSummary {
  readonly clause: BylawClause;
  readonly cyclesToTarget: number;
}

function emergencyFundClause(
  input: GovernanceInput,
  contributionMinor: bigint,
  claimMinor: bigint,
  balanceMinor: bigint
): FundSummary {
  const claims = reserveClaimsFor(input.memberCount);
  const targetMinor = claimMinor * BigInt(claims);
  const gapMinor = targetMinor > balanceMinor ? targetMinor - balanceMinor : 0n;
  const perCycleMinor = contributionMinor * BigInt(input.memberCount);
  const cycles = gapMinor === 0n ? 0 : Number((gapMinor + perCycleMinor - 1n) / perCycleMinor);
  const medicalMinor = (claimMinor * BigInt(MEDICAL_ADVANCE_BPS)) / BPS;
  return {
    cyclesToTarget: cycles,
    clause: {
      id: "emergency.fund",
      topic: "emergency_fund",
      titleKey: "governance.clause.emergency.fund.title",
      summaryKey: "governance.clause.emergency.fund.summary",
      rationaleKey: "governance.clause.emergency.fund.rationale",
      vars: {
        target: shown(targetMinor),
        claims,
        claim: shown(claimMinor),
        gap: shown(gapMinor),
        cycles,
        perCycle: shown(perCycleMinor),
        medical: shown(medicalMinor)
      },
      parameters: [
        { key: "targetReserve", value: etb(targetMinor), unit: "etb" },
        { key: "currentBalance", value: etb(balanceMinor), unit: "etb" },
        { key: "fundingGap", value: etb(gapMinor), unit: "etb" },
        { key: "perCycleCollection", value: etb(perCycleMinor), unit: "etb" },
        { key: "cyclesToTarget", value: cycles, unit: "cycles" },
        { key: "claimCap", value: etb(claimMinor), unit: "etb" },
        { key: "reserveClaimsCovered", value: claims, unit: "count" },
        { key: "medicalAdvanceAmount", value: etb(medicalMinor), unit: "etb" }
      ],
      citations: ["dercon2006"]
    }
  };
}

/**
 * Build the recommended clauses for one group. Throws `GovernanceError` for an
 * input the engine cannot reason about; it never guesses a default for a
 * missing figure.
 */
export function recommendGovernance(input: GovernanceInput): GovernanceRecommendation {
  const { contributionMinor, claimMinor, balanceMinor } = validate(input);

  const clauses: BylawClause[] = [];
  const warnings: GovernanceWarning[] = [];

  clauses.push(lateClause(input, contributionMinor));
  clauses.push(replacementClause(input, contributionMinor));

  if (input.groupType === "equb") {
    const reserve = defaultProtectionClause(input, contributionMinor);
    clauses.push(reserve.clause);
    if (reserve.guarantorThroughRound > 0) {
      warnings.push({
        code: "GUARANTOR_NEEDED",
        messageKey: "governance.warning.guarantor",
        vars: { round: reserve.guarantorThroughRound, total: input.memberCount }
      });
    }
  } else {
    const fund = emergencyFundClause(input, contributionMinor, claimMinor as bigint, balanceMinor);
    clauses.push(fund.clause);
    if (fund.cyclesToTarget > SLOW_FUND_CYCLES) {
      warnings.push({
        code: "SLOW_FUND",
        messageKey: "governance.warning.slowFund",
        vars: { cycles: fund.cyclesToTarget }
      });
    }
  }

  if (input.memberCount < SMALL_GROUP_THRESHOLD) {
    warnings.push({
      code: "SMALL_GROUP",
      messageKey: "governance.warning.smallGroup",
      vars: { members: input.memberCount }
    });
  }
  if (input.cycleLengthDays > LONG_CYCLE_DAYS) {
    warnings.push({
      code: "LONG_CYCLE",
      messageKey: "governance.warning.longCycle",
      vars: { days: input.cycleLengthDays }
    });
  }

  const citations: CitationId[] = [];
  for (const clause of clauses) {
    for (const id of clause.citations) {
      if (!citations.includes(id)) {
        citations.push(id);
      }
    }
  }

  return { advisoryOnly: true, input, clauses, warnings, citations };
}
