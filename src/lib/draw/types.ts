export const DRAW_ROUND_STATES = ["committed", "revealed", "paid"] as const;
export type DrawRoundState = (typeof DRAW_ROUND_STATES)[number];

export const DRAW_MEMBER_STATUSES = ["active", "inactive"] as const;
export type DrawMemberStatus = (typeof DRAW_MEMBER_STATUSES)[number];

export const DRAW_VERIFICATION_CODES = [
  "ok",
  "commitment_mismatch",
  "roster_mismatch",
  "member_commitment_mismatch",
  "incomplete_transcript",
  "selection_mismatch",
  "suspicious_commitment_history"
] as const;
export type DrawVerificationCode = (typeof DRAW_VERIFICATION_CODES)[number];

export const DRAW_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_AMOUNT",
  "NOT_FOUND",
  "FORBIDDEN",
  "REPEAT_WINNER",
  "NO_ELIGIBLE_PARTICIPANTS",
  "COMMITMENT_MISMATCH",
  "MEMBER_COMMITMENT_MISSING",
  "MEMBER_COMMITMENT_MISMATCH",
  "ROUND_OUT_OF_ORDER",
  "ALREADY_COMMITTED",
  "ALREADY_REVEALED",
  "NOT_COMMITTED",
  "IDEMPOTENCY_CONFLICT",
  "UNIFORMITY_EXHAUSTED",
  "UNAVAILABLE",
  "STORAGE_FAILURE",
  "INTEGRITY_FAILURE"
] as const;
export type DrawErrorCode = (typeof DRAW_ERROR_CODES)[number];

/**
 * Hashing seam.
 *
 * The whole point of a commit-reveal draw is that a member can recompute the
 * outcome on their own phone without trusting this server. That means the
 * primitive must not be locked to Node: a browser verifies with
 * `crypto.subtle.digest`, the server and the test suite use
 * `node:crypto`'s `createHash`. Every pure function in this domain takes one.
 */
export type DrawHasher = (data: string) => Promise<string>;

export interface DrawMember {
  readonly memberId: string;
  readonly displayName: string;
  readonly status: DrawMemberStatus;
  /**
   * Per-cycle share in ETB with exactly two decimals. Members of a ROSCA
   * contribute the same amount by construction, but the model does not assume
   * it: the risk assessment reads each member's own share.
   */
  readonly contributionAmount: string;
}

/**
 * The minimum a roster digest covers. Deliberately excludes `displayName`: a
 * display name is presentation, and letting a renamed member silently break
 * every published commitment would be a poor trade for including it.
 */
export interface DrawRosterEntry {
  readonly memberId: string;
  readonly ticket: string;
  readonly contributionAmount: string;
}

export interface DrawParticipant extends DrawRosterEntry {
  readonly displayName: string;
}

export interface DrawCycle {
  readonly cycleId: string;
  readonly groupId: string;
  readonly name: string;
  readonly rounds: number;
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly startedAt: string;
  readonly closedAt: string | null;
}

/**
 * One member's sealed contribution to the draw.
 *
 * A member picks a nonce, publishes only its hash, and keeps the nonce until the
 * reveal. Because this is sealed *before* the treasurer commits, the treasurer
 * cannot search for a nonce that hands the pot to a chosen member — which is the
 * one thing a single treasurer-chosen seed could never prevent.
 */
export interface DrawMemberCommitment {
  readonly memberId: string;
  /** `SHA-256` of the member's nonce, bound to this draw. 64 lowercase hex. */
  readonly sealed: string;
}

/** The revealed half of a {@link DrawMemberCommitment}. */
export interface DrawMemberNonce {
  readonly memberId: string;
  readonly nonce: string;
}

export interface DrawCommitment {
  readonly drawId: string;
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly commitment: string;
  /**
   * Public half of the sealed entropy. It is published at commit time and is
   * part of the hashed preimage, so the commitment cannot be re-derived from a
   * different nonce — but publishing it early means the commitment is fixed
   * before the ceremony begins, which is the whole point.
   */
  readonly commitmentNonce: string;
  /**
   * Digest over every member contribution, in memberId order.
   *
   * This is what makes the draw fair rather than merely honest. With a
   * treasurer-chosen seed alone, the treasurer could try seeds until one
   * favoured a friend and commit to that one; the reveal would then be perfectly
   * consistent and completely rigged. The winner now depends on randomness the
   * treasurer does not have.
   */
  readonly memberDigest: string;
  readonly memberCommitments: readonly DrawMemberCommitment[];
  readonly rosterDigest: string;
  readonly participants: readonly DrawParticipant[];
  readonly potAmount: string;
  /**
   * Rounds in the whole cycle, published with the commitment. Post-win
   * exposure depends on how much of the cycle is left, not on how many members
   * happen to be in the roster, so it has to be part of what members can see.
   */
  readonly totalRounds: number;
  readonly reserveRatioBps: number;
  readonly committedBy: string;
  readonly committedAt: string;
  readonly idempotencyKey: string;
}

export interface DrawReveal {
  readonly drawId: string;
  readonly commitment: string;
  readonly seed: string;
  readonly memberDigest: string;
  /** The nonces behind every sealed member contribution. */
  readonly memberNonces: readonly DrawMemberNonce[];
  readonly transcriptDigest: string;
  readonly selectionDigest: string;
  readonly selectedIndex: number;
  readonly winnerMemberId: string;
  readonly winningTicket: string;
  readonly payoutAmount: string;
  readonly reserveAmount: string;
  readonly revealedBy: string;
  readonly revealedAt: string;
}

export interface DrawPayout {
  readonly drawId: string;
  readonly ledgerEntryId: string;
  readonly winnerMemberId: string;
  readonly amount: string;
  readonly reserveAmount: string;
  readonly postedAt: string;
  readonly postedBy: string;
}

export interface DrawRound extends DrawCommitment {
  readonly state: DrawRoundState;
  readonly reveal: DrawReveal | null;
  readonly payout: DrawPayout | null;
}

export interface DrawVerificationError {
  readonly code: DrawVerificationCode;
  readonly detail: string;
}

export interface DrawVerificationResult {
  /**
   * `true` only when every independent cryptographic check passed. A member may
   * rely on a `verified` outcome; anything else is a reason to escalate to a
   * human, and never a reason to pay.
   */
  readonly verified: boolean;
  readonly codes: readonly DrawVerificationCode[];
  /**
   * Non-fatal governance concerns. Kept separate from `codes` on purpose:
   * verification is a mathematical fact, while whether to pay out is a
   * decision the service applies policy to.
   */
  readonly warnings: readonly string[];
  readonly winnerMemberId: string | null;
  readonly winningTicket: string | null;
  readonly selectedIndex: number | null;
  readonly transcriptDigest: string | null;
  readonly recomputedCommitment: string | null;
  readonly errors: readonly DrawVerificationError[];
}

export interface DrawRiskAssessment {
  readonly drawId: string;
  readonly round: number;
  readonly potAmount: string;
  readonly payoutAmount: string;
  readonly reserveAmount: string;
  readonly reserveRatioBps: number;
  readonly participantsAfterWin: number;
  /**
   * Social collateral the winner still owes the cycle after being paid —
   * the remaining contributions they are committed to. A winner with a large
   * remaining stake is both better trusted and more exposed.
   */
  readonly winnerOutstandingMinor: string;
  /**
   * Worst-case single-member default the reserve can absorb, in minor units.
   * `0` means the reserve cannot absorb even one default.
   */
  readonly reserveCoversDefaults: number;
  readonly reserveAdequate: boolean;
  readonly notes: readonly string[];
}

export function isDrawRoundState(value: string | null | undefined): value is DrawRoundState {
  return typeof value === "string" && (DRAW_ROUND_STATES as readonly string[]).includes(value);
}

export function isDrawVerificationCode(
  value: string | null | undefined
): value is DrawVerificationCode {
  return typeof value === "string" && (DRAW_VERIFICATION_CODES as readonly string[]).includes(value);
}
