import { compareEtbAmounts } from "@/lib/ledger/money";
import { validateNormalizedBankProviderResult } from "./schemas";
import type {
  BankDirection,
  BankProviderResult,
  BankVerificationReasonCode,
  BankVerificationState
} from "./types";

export interface ExpectedBankEvidence {
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly senderFingerprint: string;
  readonly receiverFingerprint: string;
  readonly occurredAt: string;
  /**
   * Permitted clock skew, in seconds, between the declared contribution time
   * and the bank's own timestamp.
   *
   * Defaults to 0, which means exact instant equality. Real bank feeds publish
   * wall-clock timestamps at minute/second precision in EAT with no offset, and
   * a treasurer declares when they *believe* a payment happened, so exact
   * equality against a live feed would reject essentially every real
   * contribution. Adapters that talk to a live provider set this explicitly; the
   * default keeps every existing strict check unchanged.
   *
   * This tolerance applies to the timestamp dimension only. Amount, currency,
   * direction and both account fingerprints remain exact.
   */
  readonly timestampToleranceSeconds?: number;
}

export interface BankEvidenceAssessment {
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly mismatches: readonly BankVerificationReasonCode[];
  readonly evidence: BankProviderResult["evidence"];
  readonly retryAfterSeconds?: number;
}

function pending(
  reasonCode: BankVerificationReasonCode,
  evidence?: BankProviderResult["evidence"],
  retryAfterSeconds?: number
): BankEvidenceAssessment {
  return {
    state: "PENDING_RECONCILIATION",
    reasonCode,
    mismatches: [],
    evidence,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  };
}

export function isCompleteSettledEvidence(
  evidence: BankProviderResult["evidence"]
): evidence is NonNullable<BankProviderResult["evidence"]> {
  if (!evidence) {
    return false;
  }
  return (
    typeof evidence.providerTransactionId === "string" &&
    evidence.providerTransactionId.length > 0 &&
    typeof evidence.amount === "string" &&
    evidence.amount.length > 0 &&
    typeof evidence.currency === "string" &&
    evidence.currency.length === 3 &&
    (evidence.direction === "inbound" || evidence.direction === "outbound") &&
    typeof evidence.senderFingerprint === "string" &&
    evidence.senderFingerprint.length > 0 &&
    typeof evidence.receiverFingerprint === "string" &&
    evidence.receiverFingerprint.length > 0 &&
    typeof evidence.occurredAt === "string" &&
    !Number.isNaN(new Date(evidence.occurredAt).getTime()) &&
    typeof evidence.settledAt === "string" &&
    !Number.isNaN(new Date(evidence.settledAt).getTime())
  );
}

/**
 * Compares two timestamps, allowing an optional absolute skew in seconds.
 * A missing or unparseable tolerance-bearing timestamp is a mismatch, never a
 * pass: a receipt whose time we cannot read must not be accepted.
 */
function isWithinTimestampTolerance(
  actual: string,
  expected: string,
  toleranceSeconds?: number
): boolean {
  if (actual === expected) {
    return true;
  }
  if (toleranceSeconds === undefined || toleranceSeconds <= 0) {
    return false;
  }
  const actualMs = new Date(actual).getTime();
  const expectedMs = new Date(expected).getTime();
  if (Number.isNaN(actualMs) || Number.isNaN(expectedMs)) {
    return false;
  }
  return Math.abs(actualMs - expectedMs) <= toleranceSeconds * 1_000;
}

export function assessBankProviderResult(
  result: BankProviderResult,
  expected: ExpectedBankEvidence
): BankEvidenceAssessment {
  if (result.kind !== "settled") {
    return pending(
      result.kind === "rate_limited"
        ? "PROVIDER_RATE_LIMITED"
        : result.kind === "timeout"
          ? "PROVIDER_TIMEOUT"
          : result.kind === "not_found"
            ? "PROVIDER_NOT_FOUND"
            : result.kind === "unsettled"
              ? "PROVIDER_UNSETTLED"
              : result.kind === "provider_error"
                ? "PROVIDER_UNAVAILABLE"
                : "PROVIDER_RESPONSE_INVALID",
      undefined,
      result.retryAfterSeconds
    );
  }

  let normalizedResult: BankProviderResult;
  try {
    normalizedResult = validateNormalizedBankProviderResult(result.provider, result);
  } catch {
    return pending("PROVIDER_RESPONSE_INVALID", result.evidence);
  }

  if (!isCompleteSettledEvidence(normalizedResult.evidence)) {
    return pending("EVIDENCE_INCOMPLETE", normalizedResult.evidence);
  }

  const evidence = normalizedResult.evidence;
  const mismatches: BankVerificationReasonCode[] = [];
  let amountMatches = false;
  try {
    amountMatches = compareEtbAmounts(evidence.amount, expected.amount) === 0;
  } catch {
    return pending("PROVIDER_RESPONSE_INVALID", evidence);
  }
  if (!amountMatches) {
    mismatches.push("AMOUNT_MISMATCH");
  }
  if (evidence.currency !== expected.currency) {
    mismatches.push("CURRENCY_MISMATCH");
  }
  if (evidence.direction !== expected.direction) {
    mismatches.push("DIRECTION_MISMATCH");
  }
  if (evidence.senderFingerprint !== expected.senderFingerprint) {
    mismatches.push("SENDER_MISMATCH");
  }
  if (evidence.receiverFingerprint !== expected.receiverFingerprint) {
    mismatches.push("RECEIVER_MISMATCH");
  }
  if (!isWithinTimestampTolerance(evidence.occurredAt, expected.occurredAt, expected.timestampToleranceSeconds)) {
    mismatches.push("TIMESTAMP_MISMATCH");
  }

  if (mismatches.length > 0) {
    return {
      state: "REJECTED",
      reasonCode: mismatches[0],
      mismatches,
      evidence
    };
  }

  return {
    state: "VERIFIED",
    reasonCode: "VERIFIED",
    mismatches: [],
    evidence
  };
}

export function matchBankEvidence(
  result: BankProviderResult,
  expected: ExpectedBankEvidence
): BankEvidenceAssessment {
  return assessBankProviderResult(result, expected);
}

export function publicReasonForAssessment(assessment: BankEvidenceAssessment): BankVerificationReasonCode {
  return assessment.reasonCode;
}
