import type { MessageKey } from "@/lib/i18n";
import type { CitationId } from "./citations";

export const GROUP_TYPES = ["equb", "iddir"] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

/** How well members know, and can socially pressure, one another. */
export const TRUST_LEVELS = ["close", "mixed", "new"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const MAX_MEMBERS = 500;
export const MAX_CYCLE_DAYS = 366;

export interface GovernanceInput {
  readonly groupType: GroupType;
  /** Members (Equb) or households (Iddir). */
  readonly memberCount: number;
  /** ETB per member per cycle, as a decimal string. */
  readonly contributionAmount: string;
  readonly cycleLengthDays: number;
  readonly trust: TrustLevel;
  /** Iddir only: the usual cost of one funeral claim, ETB. */
  readonly typicalClaimAmount?: string;
  /** Iddir only: what the emergency fund holds today, ETB. Defaults to 0. */
  readonly currentFundBalance?: string;
}

export const TOPICS = ["late_payment", "replacement", "default_protection", "emergency_fund"] as const;
export type Topic = (typeof TOPICS)[number];

export const CLAUSE_IDS = [
  "late.equb",
  "late.iddir",
  "replacement.equb",
  "replacement.iddir",
  "default.reserve",
  "emergency.fund"
] as const;
export type ClauseId = (typeof CLAUSE_IDS)[number];

export const PARAMETER_KEYS = [
  "graceDays",
  "penaltyBps",
  "penaltyAmount",
  "suspendAfterMissed",
  "claimsSuspendedAfterMissed",
  "voucherCount",
  "voteThresholdBps",
  "replacementDeadlineDays",
  "maxOutstandingAmount",
  "claimWaitingDays",
  "baseReserveBps",
  "round1ReserveAmount",
  "round1PayoutAmount",
  "guarantorThroughRound",
  "worstCaseExposure",
  "targetReserve",
  "currentBalance",
  "fundingGap",
  "perCycleCollection",
  "cyclesToTarget",
  "claimCap",
  "reserveClaimsCovered",
  "medicalAdvanceAmount"
] as const;
export type ParameterKey = (typeof PARAMETER_KEYS)[number];

export type ParameterUnit = "days" | "bps" | "etb" | "count" | "rounds" | "cycles";

export interface ClauseParameter {
  readonly key: ParameterKey;
  /** Money is a canonical two-decimal string; everything else is a number. */
  readonly value: string | number;
  readonly unit: ParameterUnit;
}

export interface BylawClause {
  readonly id: ClauseId;
  readonly topic: Topic;
  readonly titleKey: MessageKey;
  readonly summaryKey: MessageKey;
  readonly rationaleKey: MessageKey;
  /** Interpolation variables shared by the summary and rationale text. */
  readonly vars: Readonly<Record<string, string | number>>;
  readonly parameters: readonly ClauseParameter[];
  readonly citations: readonly CitationId[];
}

export const WARNING_CODES = ["SMALL_GROUP", "GUARANTOR_NEEDED", "SLOW_FUND", "LONG_CYCLE"] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface GovernanceWarning {
  readonly code: WarningCode;
  readonly messageKey: MessageKey;
  readonly vars: Readonly<Record<string, string | number>>;
}

export interface GovernanceRecommendation {
  /** Always true: recommendations never touch the ledger. */
  readonly advisoryOnly: true;
  readonly input: GovernanceInput;
  readonly clauses: readonly BylawClause[];
  readonly warnings: readonly GovernanceWarning[];
  /** Distinct citations across all clauses, in first-use order. */
  readonly citations: readonly CitationId[];
}
