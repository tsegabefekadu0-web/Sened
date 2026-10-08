export const DRAW_ROUND_STATES = ["committed", "revealed", "paid"] as const;
export type DrawRoundState = (typeof DRAW_ROUND_STATES)[number];

/**
 * Draw protocol versions.
 *
 * `v2` is the original member-seed protocol. It sealed member nonces before the
 * treasurer committed, but the winner was derived only from values the treasurer
 * already knew at commit time (the sealed hashes, never the nonces), so the
 * treasurer could still grind `seed`/`commitmentNonce` offline until the winner
 * was who they wanted. It is kept ONLY so historical draws stay verifiable.
 *
 * `v3` folds a digest of the revealed member nonces into the transcript digest
 * that selects the winner. The nonces are the one input the treasurer does not
 * have at commit time, so the winner can no longer be searched for. New draws
 * are always `v3`; the database refuses a new `v2` commitment.
 */
export const DRAW_PROTOCOL_VERSIONS = ["v2", "v3"] as const;
export type DrawProtocolVersion = (typeof DRAW_PROTOCOL_VERSIONS)[number];
export const DRAW_CURRENT_PROTOCOL_VERSION: DrawProtocolVersion = "v3";

export function isDrawProtocolVersion(value: unknown): value is DrawProtocolVersion {
  return typeof value === "string" && (DRAW_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

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
  /** A member tried to seal while not on this round's eligible roster (for example, they already won). */
  "NOT_ELIGIBLE",
  /** A nonce was submitted before the commitment that fixes everything else was published. */
  "NONCE_TOO_EARLY",
  /** Every round of the cycle has been drawn, or the cycle is closed. */
  "CYCLE_COMPLETE",
  /**
   * The cycle's contribution gate is `block` and an active member has a flagged
   * round before the one being opened, and no override reason was given.
   */
  "CONTRIBUTION_GATE_BLOCKED",
  "IDEMPOTENCY_CONFLICT",
  /** A committed draw that is not revealed or cancelled already exists for this round: no re-roll. */
  "ROUND_HAS_LIVE_DRAW",
  /** The draw was cancelled; it takes no seal, nonce, commit or reveal. */
  "DRAW_CANCELLED",
  /** Cancel before the seal or nonce-release deadline. */
  "CANCEL_TOO_EARLY",
  /** The reveal was opened, so the draw must be finished and cannot be cancelled. */
  "CANCEL_REVEAL_OPENED",
  /** Every member responded; there is nothing to cancel for. */
  "CANCEL_NOTHING_MISSED",
  /** Two cancels in this round already; only a group owner may go further. */
  "CANCEL_LIMIT_REACHED",
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
   * Which derivation this draw was committed under. Bound into the commitment
   * hash itself (`sened-draw-commit-v3`), pinned by the database at commit time,
   * and never changed afterwards, so a verifier cannot be talked into checking a
   * v3 draw under the weaker v2 rules.
   */
  readonly protocolVersion: DrawProtocolVersion;
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

/** A non-fatal governance concern, as data (see {@link DrawVerificationResult.warningItems}). */
export type DrawVerificationWarning =
  | { readonly code: "abandoned_commitments"; readonly count: number }
  | { readonly code: "recorded_winner_mismatch" }
  | { readonly code: "recorded_digest_mismatch" };

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
  /** The same concerns as `warnings`, structured so the screen can localise them. */
  readonly warningItems?: readonly DrawVerificationWarning[];
  readonly winnerMemberId: string | null;
  readonly winningTicket: string | null;
  readonly selectedIndex: number | null;
  readonly transcriptDigest: string | null;
  /**
   * Digest of the verified member nonces that fed the winner selection. `null`
   * for a v2 draw (which has none) and whenever the nonces did not all verify.
   */
  readonly nonceDigest?: string | null;
  readonly recomputedCommitment: string | null;
  readonly errors: readonly DrawVerificationError[];
}

/**
 * One line of reasoning behind the reserve, as data, so the screen can say it in
 * the member's language. The English `notes` strings are kept alongside for
 * logs and for callers that predate this field.
 */
export type DrawRiskNote =
  | { readonly code: "base_reserve"; readonly amount: string; readonly bps: number }
  | { readonly code: "member_exposure"; readonly amount: string }
  | { readonly code: "final_round" }
  | { readonly code: "capped"; readonly needed: string; readonly ceilingBps: number }
  | { readonly code: "coverage"; readonly percent: string; readonly owed: string }
  | { readonly code: "cannot_absorb" }
  | { readonly code: "exposure_uncovered"; readonly exposure: string; readonly reserve: string };

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
  /** The same reasoning as `notes`, structured for localisation. */
  readonly noteItems?: readonly DrawRiskNote[];
}

export function isDrawRoundState(value: string | null | undefined): value is DrawRoundState {
  return typeof value === "string" && (DRAW_ROUND_STATES as readonly string[]).includes(value);
}

export function isDrawVerificationCode(
  value: string | null | undefined
): value is DrawVerificationCode {
  return typeof value === "string" && (DRAW_VERIFICATION_CODES as readonly string[]).includes(value);
}

// -- cycles, draws and the sealing lifecycle ---------------------------------------

/**
 * Where a draw is. Derived in the database from which rows exist, never stored:
 * `sealing` (opened, members sealing) -> `committed` (sealed set frozen, nonces
 * may be released) -> `revealed` -> `paid`.
 */
export const DRAW_LIFECYCLE_STATES = ["sealing", "committed", "revealed", "paid", "cancelled"] as const;
export type DrawLifecycleState = (typeof DRAW_LIFECYCLE_STATES)[number];

export function isDrawLifecycleState(value: unknown): value is DrawLifecycleState {
  return typeof value === "string" && (DRAW_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The per-cycle contribution gate (`docs/architecture/draw.md` §18).
 *
 *   off    opening a draw never looks at contributions (every cycle created before the gate existed);
 *   warn   the screen lists the flagged rounds and asks for a confirmation; the server allows it;
 *   block  the server refuses to open a draw while an active member has a flagged round before
 *          the round being opened, unless an owner/treasurer gives a reason, which is recorded.
 */
export const DRAW_CONTRIBUTION_GATES = ["off", "warn", "block"] as const;
export type DrawContributionGate = (typeof DRAW_CONTRIBUTION_GATES)[number];

export function isDrawContributionGate(value: unknown): value is DrawContributionGate {
  return typeof value === "string" && (DRAW_CONTRIBUTION_GATES as readonly string[]).includes(value);
}

/** One (member, round) a gate looked at and found flagged. */
export interface DrawGateFlag {
  readonly memberId: string;
  readonly round: number;
}

/** What opening a draw found when it looked at contributions (absent when no new draw was opened). */
export interface DrawOpenGate {
  readonly policy: DrawContributionGate;
  /** The flagged (member, round) pairs before the round that was opened. Empty under `off`. */
  readonly flagged: readonly DrawGateFlag[];
  /** An owner/treasurer's recorded reason let the draw open despite `flagged`. */
  readonly overridden: boolean;
}

/** What committing a draw found when it looked at contributions again (absent on a replay). */
export interface DrawCommitGate {
  readonly policy: DrawContributionGate;
  /** The flagged (member, round) pairs before this draw's round at commit time. Empty under `off`. */
  readonly flagged: readonly DrawGateFlag[];
  /** An owner/treasurer's reason given AT COMMIT let the draw be committed despite `flagged`. */
  readonly overridden: boolean;
  /** `block`, something flagged, and the override given when the draw was opened still covered every pair. */
  readonly carriedOver: boolean;
}

/** A draw cycle as the database defines it. Amounts are ETB strings with two decimals. */
export interface DrawCycleRecord {
  readonly cycleId: string;
  readonly groupId: string;
  readonly name: string;
  /** Per-member contribution per round. Null only for a cycle that predates the column. */
  readonly contributionAmount: string | null;
  /** Contribution times the active members when the cycle was created. */
  readonly potAmount: string;
  readonly totalRounds: number;
  readonly reserveRatioBps: number;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly roundsRevealed: number;
  readonly roundsPaid: number;
  /** The round the next draw would be, or null when every round has been drawn. */
  readonly nextRound: number | null;
  /** The effective contribution gate: the latest policy change, else the policy chosen at creation. */
  readonly contributionGate: DrawContributionGate;
}

/** One draw in a cycle's listing. */
export interface DrawListEntry {
  readonly drawId: string;
  readonly round: number;
  readonly state: DrawLifecycleState;
  readonly openedAt: string;
  readonly committedAt: string | null;
  readonly revealedAt: string | null;
  readonly winnerMemberId: string | null;
  readonly sealCount: number;
  /** How many members have released a nonce. A count only; never a value. */
  readonly nonceCount: number;
  readonly revealRequested: boolean;
  /** A later draw was opened for the same round, so this one was abandoned. */
  readonly superseded: boolean;
  /** Committed before server-created draws existed. Readable, but not completable here. */
  readonly legacy: boolean;
}

/** A member's seal: the hash only. */
export interface DrawSessionSeal {
  readonly memberId: string;
  readonly sealed: string;
  readonly sealedAt?: string;
}

/**
 * Everything members may see of a draw in progress: the seal hashes, and for each
 * sealed member only whether they have released a nonce.
 */
export interface DrawSessionView {
  readonly drawId: string;
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly state: DrawLifecycleState;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly committedAt: string | null;
  readonly cycle: DrawCycleRecord;
  /** Members who may seal this round (active, not yet drawn this cycle). */
  readonly eligible: readonly string[];
  readonly seals: readonly DrawSessionSeal[];
  readonly nonces: readonly { readonly memberId: string; readonly released: boolean }[];
  /** The reveal was requested: the seed and nonces are public to the group. */
  readonly revealRequested: boolean;
  /** After this instant an owner/treasurer may cancel a draw that is still sealing. Fixed at open. */
  readonly sealDeadline: string;
  /** After this instant (and with a nonce missing, reveal not opened) a committed draw may be cancelled. */
  readonly nonceDeadline: string | null;
  /** Members excluded from this session as recorded non-responders of an earlier cancel of this round. */
  readonly excluded: readonly string[];
  /** Cancels already recorded for this cycle and round (the limit is {@link DRAW_CANCEL_LIMIT}). */
  readonly cancelsThisRound: number;
  readonly cancellation: DrawCancellation | null;
  /** Present once the reveal is opened: the published seed, so any manager can finish the draw. */
  readonly revealOpening: DrawRevealOpening | null;
}

/** The two stages at which a draw can be cancelled for members who did not respond. */
export type DrawCancelStage = "sealing" | "committed";

/**
 * One append-only cancellation: who, when, why, which stage, the deadline that had passed and
 * the members who missed it. Visible to every member of the group.
 */
export interface DrawCancellation {
  readonly cancellationId: string;
  readonly drawId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly stage: DrawCancelStage;
  readonly reason: string;
  readonly missedMembers: readonly string[];
  readonly deadlineAt: string;
  /** An owner made this call past the per-round limit. */
  readonly ownerDecision: boolean;
  readonly cancelledBy: string;
  readonly cancelledAt: string;
}

/** Published the moment the reveal is opened: the seed is public from then on. */
export interface DrawRevealOpening {
  readonly seed: string;
  readonly openedBy: string;
  readonly openedAt: string;
}

/**
 * Cancels allowed per round by a treasurer. A third needs a group owner. Mirrors
 * `sened_draw_cancel_limit()` in the database, which is the authority.
 */
export const DRAW_CANCEL_LIMIT = 2;
