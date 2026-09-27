import {
  computeCommitment,
  computeMemberCommitment,
  computeMemberDigest,
  computeRosterDigest,
  computeTranscriptDigest,
  deriveTicket,
  isHex64,
  orderParticipants,
  selectWinnerIndex,
  type DrawVerificationTranscript
} from "./canonical";
import { DrawError } from "./errors";
import { planReserve, assessDrawRisk, type ReservePlan } from "./risk";
import { buildParticipants, excludePriorWinners } from "./rotation";
import type {
  DrawCommitment,
  DrawHasher,
  DrawMember,
  DrawMemberCommitment,
  DrawMemberNonce,
  DrawReveal,
  DrawRiskAssessment,
  DrawRound,
  DrawVerificationCode,
  DrawVerificationError,
  DrawVerificationResult
} from "./types";

/**
 * How many members must seal a contribution before a round may commit.
 *
 * One is the minimum that makes grinding pointless: the treasurer can no longer
 * search for an outcome, because a value they do not have is inside the
 * commitment. More is better, and a group that trusts its members should raise
 * it — but refusing to run a draw because nobody could be bothered to seal a
 * nonce would push groups back to the treasurer-chosen seed, which is the thing
 * this exists to remove. One is the floor, not the target.
 */
export const MIN_MEMBER_COMMITMENTS = 1;

export interface CommitRequest {
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly totalRounds: number;
  readonly drawId: string;
  readonly commitmentNonce: string;
  readonly seed: string;
  /**
   * Sealed contributions from members, published as hashes. The nonces stay with
   * their owners until the reveal.
   */
  readonly memberCommitments: readonly DrawMemberCommitment[];
  /** Defaults to {@link MIN_MEMBER_COMMITMENTS}. */
  readonly minMemberCommitments?: number;
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly members: readonly DrawMember[];
  readonly priorWinnerIds: readonly string[];
  readonly committedBy: string;
  readonly committedAt: string;
  readonly idempotencyKey: string;
}

/**
 * Order contributions by member so the digest cannot depend on submission order.
 * Exported because the reveal and the member's own verification both need the
 * same ordering, and a second implementation of it would be a second bug.
 */
export function sortMemberContributions<T extends { readonly memberId: string }>(
  contributions: readonly T[]
): T[] {
  return [...contributions].sort((left, right) =>
    left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0
  );
}

/**
 * Validate a set of sealed member contributions.
 *
 * Every check here closes a way to make the count look satisfied without a
 * member having actually contributed: a duplicate id, an outsider, a value that
 * is not a digest.
 */
function assertMemberContributions(
  contributions: readonly DrawMemberCommitment[],
  eligibleMemberIds: ReadonlySet<string>,
  minimum: number
): DrawMemberCommitment[] {
  if (contributions.length < minimum) {
    throw new DrawError(
      "MEMBER_COMMITMENT_MISSING",
      `A draw needs at least ${minimum} sealed member contribution(s) before the treasurer can commit. ` +
        "Without one the treasurer chooses the winner by searching seeds."
    );
  }

  const seen = new Set<string>();
  for (const contribution of contributions) {
    if (!contribution.memberId || contribution.memberId.length > 64) {
      throw new DrawError("INVALID_REQUEST", "A member contribution has an invalid memberId");
    }
    if (seen.has(contribution.memberId)) {
      throw new DrawError(
        "INVALID_REQUEST",
        "A member may contribute once per round; a duplicate would let one member stand in for the quorum."
      );
    }
    seen.add(contribution.memberId);
    if (!eligibleMemberIds.has(contribution.memberId)) {
      throw new DrawError(
        "INVALID_REQUEST",
        "Only members on the eligible roster may contribute. An outsider's contribution is not the group's randomness."
      );
    }
    if (!isHex64(contribution.sealed)) {
      throw new DrawError(
        "INVALID_REQUEST",
        "A member contribution must be a 64-character lowercase SHA-256 digest"
      );
    }
  }

  return sortMemberContributions(contributions);
}

function unverified(
  codes: readonly DrawVerificationCode[],
  errors: readonly DrawVerificationError[],
  warnings: readonly string[] = []
): DrawVerificationResult {
  return {
    verified: false,
    codes,
    warnings,
    winnerMemberId: null,
    winningTicket: null,
    selectedIndex: null,
    transcriptDigest: null,
    recomputedCommitment: null,
    errors
  };
}

/**
 * M4.1 step 1 — commit.
 *
 * Publishes the commitment, the eligible roster, and each member's ticket. The
 * seed never leaves this function's return value. Because `rosterDigest` and
 * `commitmentNonce` are both inside the hashed preimage, the treasurer cannot
 * later add a member, drop a member, change anyone's share, or re-derive the
 * commitment under a different nonce without the digest ceasing to match.
 */
export async function createCommitment(
  request: CommitRequest,
  hasher: DrawHasher
): Promise<DrawCommitment> {
  if (!Number.isInteger(request.round) || request.round < 1) {
    throw new DrawError("INVALID_REQUEST", "round must be a positive integer");
  }
  if (
    !Number.isInteger(request.totalRounds) ||
    request.totalRounds < 1 ||
    request.round > request.totalRounds
  ) {
    throw new DrawError(
      "INVALID_REQUEST",
      "totalRounds must be a positive integer and the round must fall within it"
    );
  }
  if (request.seed.length < 16) {
    throw new DrawError(
      "INVALID_REQUEST",
      "The seed must carry at least 16 characters of entropy"
    );
  }
  if (request.commitmentNonce.length < 16) {
    throw new DrawError(
      "INVALID_REQUEST",
      "The commitment nonce must carry at least 16 characters of entropy"
    );
  }
  if (request.commitmentNonce === request.seed) {
    throw new DrawError(
      "INVALID_REQUEST",
      "The commitment nonce must differ from the seed"
    );
  }

  const eligible = excludePriorWinners(request.members, request.priorWinnerIds);
  const participants = await buildParticipants(
    eligible,
    { groupId: request.groupId, cycleId: request.cycleId },
    hasher
  );
  const rosterDigest = await computeRosterDigest(participants, hasher);

  const minimum = Math.max(
    MIN_MEMBER_COMMITMENTS,
    Math.floor(request.minMemberCommitments ?? MIN_MEMBER_COMMITMENTS)
  );
  const memberCommitments = assertMemberContributions(
    request.memberCommitments,
    new Set(participants.map((participant) => participant.memberId)),
    minimum
  );
  const memberDigest = await computeMemberDigest(
    { drawId: request.drawId, contributions: memberCommitments },
    hasher
  );
  const commitment = await computeCommitment(
    {
      groupId: request.groupId,
      cycleId: request.cycleId,
      round: request.round,
      drawId: request.drawId,
      rosterDigest,
      commitmentNonce: request.commitmentNonce,
      memberDigest,
      seed: request.seed
    },
    hasher
  );

  return {
    drawId: request.drawId,
    groupId: request.groupId,
    cycleId: request.cycleId,
    round: request.round,
    commitment,
    commitmentNonce: request.commitmentNonce,
    memberDigest,
    memberCommitments,
    rosterDigest,
    participants,
    potAmount: request.potAmount,
    totalRounds: request.totalRounds,
    reserveRatioBps: request.reserveRatioBps,
    committedBy: request.committedBy,
    committedAt: request.committedAt,
    idempotencyKey: request.idempotencyKey
  };
}

export interface RevealResult {
  readonly reveal: DrawReveal;
  readonly risk: DrawRiskAssessment;
  readonly plan: ReservePlan;
}

/**
 * M4.1 step 2 — reveal.
 *
 * The seed is published and immediately re-hashed against the commitment that
 * was locked in before the ceremony. A mismatch throws `COMMITMENT_MISMATCH`:
 * the draw is refused, not "flagged and paid anyway". That is the fail-closed
 * behaviour §12.5 requires.
 */
/**
 * Recompute the member digest from revealed nonces, checking each against the
 * hash that was sealed at commit time.
 *
 * This is the heart of the fairness property. A member's nonce is only accepted
 * if it hashes to what that member published before the ceremony; the aggregate
 * is then compared with the digest bound into the commitment. Change one nonce
 * and the digest changes, so the commitment cannot be reproduced — which is
 * exactly what stops a treasurer from revealing a nonce of their own choosing.
 */
export async function resolveMemberDigest(
  commitment: DrawCommitment,
  nonces: readonly DrawMemberNonce[],
  hasher: DrawHasher
): Promise<string> {
  if (nonces.length !== commitment.memberCommitments.length) {
    throw new DrawError(
      "MEMBER_COMMITMENT_MISSING",
      `The reveal opened ${nonces.length} member contribution(s) but ${commitment.memberCommitments.length} were sealed. The draw is refused.`
    );
  }

  const sealedByMember = new Map(
    commitment.memberCommitments.map((contribution) => [contribution.memberId, contribution.sealed])
  );

  for (const entry of nonces) {
    const sealed = sealedByMember.get(entry.memberId);
    if (sealed === undefined) {
      throw new DrawError(
        "MEMBER_COMMITMENT_MISSING",
        "A revealed contribution belongs to a member who sealed nothing. The draw is refused."
      );
    }
    if (!entry.nonce || entry.nonce.length < 16) {
      throw new DrawError(
        "INVALID_REQUEST",
        "A revealed member nonce must carry at least 16 characters of entropy"
      );
    }
    const recomputed = await computeMemberCommitment(
      { drawId: commitment.drawId, memberId: entry.memberId, nonce: entry.nonce },
      hasher
    );
    if (recomputed !== sealed) {
      throw new DrawError(
        "MEMBER_COMMITMENT_MISMATCH",
        `The nonce revealed for ${entry.memberId} does not match what that member sealed. The draw is refused.`
      );
    }
  }

  const memberDigest = await computeMemberDigest(
    { drawId: commitment.drawId, contributions: commitment.memberCommitments },
    hasher
  );
  if (memberDigest !== commitment.memberDigest) {
    throw new DrawError(
      "MEMBER_COMMITMENT_MISMATCH",
      "The member contributions no longer hash to the committed digest. The draw is refused."
    );
  }
  return memberDigest;
}

/**
 * Seal one member's contribution.
 *
 * A member runs this on their own phone, publishes only the digest, and keeps
 * the nonce. The digest is what the treasurer commits against; the nonce is what
 * the ceremony reveals.
 */
export async function sealMemberContribution(
  input: { readonly drawId: string; readonly memberId: string; readonly nonce: string },
  hasher: DrawHasher
): Promise<DrawMemberCommitment> {
  if (!input.nonce || input.nonce.length < 16) {
    throw new DrawError(
      "INVALID_REQUEST",
      "A member nonce must carry at least 16 characters of entropy"
    );
  }
  return {
    memberId: input.memberId,
    sealed: await computeMemberCommitment(input, hasher)
  };
}

export async function openReveal(
  commitment: DrawCommitment,
  input: {
    readonly seed: string;
    readonly memberNonces: readonly DrawMemberNonce[];
    readonly revealedBy: string;
    readonly revealedAt: string;
  },
  hasher: DrawHasher
): Promise<RevealResult> {
  // Every sealed contribution must be opened, and opened correctly, before the
  // winner is derived. This is the step that makes the draw fair: the winner
  // depends on nonces the treasurer chose not, so no seed search could have
  // reached this outcome.
  const memberDigest = await resolveMemberDigest(commitment, input.memberNonces, hasher);

  const recomputed = await computeCommitment(
    {
      groupId: commitment.groupId,
      cycleId: commitment.cycleId,
      round: commitment.round,
      drawId: commitment.drawId,
      rosterDigest: commitment.rosterDigest,
      commitmentNonce: commitment.commitmentNonce,
      memberDigest,
      seed: input.seed
    },
    hasher
  );

  if (recomputed !== commitment.commitment) {
    throw new DrawError(
      "COMMITMENT_MISMATCH",
      "The revealed seed and member contributions do not reproduce the published commitment. The draw is refused."
    );
  }

  const rosterDigest = await computeRosterDigest(commitment.participants, hasher);
  if (rosterDigest !== commitment.rosterDigest) {
    throw new DrawError(
      "COMMITMENT_MISMATCH",
      "The published roster does not match the roster digest committed to. The draw is refused."
    );
  }

  const transcriptDigest = await computeTranscriptDigest(
    {
      drawId: commitment.drawId,
      commitment: commitment.commitment,
      rosterDigest: commitment.rosterDigest,
      memberDigest,
      seed: input.seed
    },
    hasher
  );

  const selection = await selectWinnerIndex(
    { transcriptDigest, eligibleCount: commitment.participants.length },
    hasher
  );

  const ordered = orderParticipants(commitment.participants);
  const winner = ordered[selection.index];
  if (winner === undefined) {
    throw new DrawError("INTEGRITY_FAILURE", "Selection index falls outside the roster");
  }

  const share = commitment.participants[0]?.contributionAmount;
  if (share === undefined) {
    throw new DrawError("NO_ELIGIBLE_PARTICIPANTS", "The committed roster is empty");
  }

  const plan = planReserve({
    drawId: commitment.drawId,
    round: commitment.round,
    potAmount: commitment.potAmount,
    reserveRatioBps: commitment.reserveRatioBps,
    totalRounds: commitment.totalRounds,
    contributionAmount: share,
    eligibleCount: commitment.participants.length
  });
  const risk = assessDrawRisk(
    {
      drawId: commitment.drawId,
      round: commitment.round,
      potAmount: commitment.potAmount,
      reserveRatioBps: commitment.reserveRatioBps,
      totalRounds: commitment.totalRounds,
      contributionAmount: share,
      eligibleCount: commitment.participants.length
    },
    plan
  );

  return {
    reveal: {
      drawId: commitment.drawId,
      commitment: commitment.commitment,
      seed: input.seed,
      memberDigest,
      memberNonces: sortMemberContributions(input.memberNonces),
      transcriptDigest,
      selectionDigest: selection.digest,
      selectedIndex: selection.index,
      winnerMemberId: winner.memberId,
      winningTicket: winner.ticket,
      payoutAmount: risk.payoutAmount,
      reserveAmount: risk.reserveAmount,
      revealedBy: input.revealedBy,
      revealedAt: input.revealedAt
    },
    risk,
    plan
  };
}

/**
 * M4.1 step 3 — independent verification.
 *
 * This function is the product. It takes nothing but published values and a
 * SHA-256 implementation, so a member can run it on their own phone with no
 * server, no account, and no trust in the treasurer. It deliberately does not
 * throw on tampering: detecting that a draw was rigged is a *successful*
 * verification run, and the result has to say so in a shape a member can read.
 */
export async function verifyTranscript(
  transcript: DrawVerificationTranscript,
  hasher: DrawHasher
): Promise<DrawVerificationResult> {
  const codes: DrawVerificationCode[] = [];
  const errors: DrawVerificationError[] = [];
  const warnings: string[] = [];

  if (transcript.participants.length === 0) {
    return unverified(
      ["incomplete_transcript"],
      [
        {
          code: "incomplete_transcript",
          detail: "The published transcript carries no participants, so no winner can be derived."
        }
      ]
    );
  }

  if (transcript.seed.length === 0) {
    return unverified(
      ["incomplete_transcript"],
      [
        {
          code: "incomplete_transcript",
          detail: "The seed has not been revealed yet, so the draw cannot be verified."
        }
      ]
    );
  }

  for (const [label, value] of [
    ["commitment", transcript.commitment],
    ["rosterDigest", transcript.rosterDigest],
    ["memberDigest", transcript.memberDigest]
  ] as const) {
    if (!isHex64(value)) {
      codes.push("incomplete_transcript");
      errors.push({
        code: "incomplete_transcript",
        detail: `${label} is missing or is not a 64-character SHA-256 digest.`
      });
    }
  }
  if (codes.length > 0) {
    return unverified(codes, errors);
  }

  const rosterParticipants: { memberId: string; displayName: string; contributionAmount: string; ticket: string }[] = [];
  for (const participant of transcript.participants) {
    if (!isHex64(participant.ticket)) {
      codes.push("incomplete_transcript");
      errors.push({
        code: "incomplete_transcript",
        detail: `The ticket for ${participant.memberId} is missing or is not a 64-character SHA-256 digest.`
      });
    }
    rosterParticipants.push({
      memberId: participant.memberId,
      displayName: participant.memberId,
      contributionAmount: participant.contributionAmount,
      ticket: isHex64(participant.ticket) ? participant.ticket : ""
    });
  }
  if (codes.length > 0) {
    return unverified(codes, errors, warnings);
  }

  // 1. Does the roster still hash to the digest that was committed to?
  const rosterDigest = await computeRosterDigest(rosterParticipants, hasher);
  if (rosterDigest !== transcript.rosterDigest) {
    codes.push("roster_mismatch");
    errors.push({
      code: "roster_mismatch",
      detail:
        "The published roster does not hash to the committed roster digest. Members or tickets were changed after the commitment."
    });
  }

  // 2. Does each ticket still derive from its owner's own identity? A ticket is
  // a function of (group, cycle, member) alone, so a swapped ticket is proof
  // that the published roster was reassembled after the ceremony.
  for (const participant of transcript.participants) {
    const expectedTicket = await deriveTicket(
      { groupId: transcript.groupId, cycleId: transcript.cycleId, memberId: participant.memberId },
      hasher
    );
    if (expectedTicket !== participant.ticket) {
      codes.push("roster_mismatch");
      errors.push({
        code: "roster_mismatch",
        detail: `The ticket published for ${participant.memberId} does not derive from that member's identity.`
      });
    }
  }

  // 3. Do the published member contributions still hash to the committed
  // member digest? Without this a treasurer could publish an empty contribution
  // set and be self-consistent, which is precisely the grinding attack this
  // digest exists to close.
  const publishedMemberDigest = await computeMemberDigest(
    { drawId: transcript.drawId, contributions: transcript.memberCommitments },
    hasher
  );
  if (publishedMemberDigest !== transcript.memberDigest) {
    codes.push("member_commitment_mismatch");
    errors.push({
      code: "member_commitment_mismatch",
      detail:
        "The published member contributions do not hash to the member digest inside the commitment. The set of contributing members was changed."
    });
  }

  // 4. Does the seed reproduce the commitment?
  const recomputedCommitment = await computeCommitment(
    {
      groupId: transcript.groupId,
      cycleId: transcript.cycleId,
      round: transcript.round,
      drawId: transcript.drawId,
      rosterDigest: transcript.rosterDigest,
      commitmentNonce: transcript.commitmentNonce,
      memberDigest: transcript.memberDigest,
      seed: transcript.seed
    },
    hasher
  );
  if (recomputedCommitment !== transcript.commitment) {
    codes.push("commitment_mismatch");
    errors.push({
      code: "commitment_mismatch",
      detail:
        "The revealed seed does not hash to the published commitment. The commitment was changed after the ceremony, or the seed is not the one that was committed."
    });
  }

  const transcriptDigest = await computeTranscriptDigest(
    {
      drawId: transcript.drawId,
      commitment: transcript.commitment,
      rosterDigest: transcript.rosterDigest,
      memberDigest: transcript.memberDigest,
      seed: transcript.seed
    },
    hasher
  );

  /**
   * Fail closed before naming anybody.
   *
   * If the roster or the commitment does not hold, the transcript is not a
   * legitimate basis for selecting a winner, so no winner is returned even
   * though the arithmetic would happily produce one. Handing a member a winner
   * alongside `commitment_mismatch` is exactly how a forged draw gets paid.
   */
  if (codes.length > 0) {
    return {
      verified: false,
      codes,
      warnings,
      winnerMemberId: null,
      winningTicket: null,
      selectedIndex: null,
      transcriptDigest,
      recomputedCommitment,
      errors
    };
  }

  let selection;
  try {
    selection = await selectWinnerIndex(
      { transcriptDigest, eligibleCount: rosterParticipants.length },
      hasher
    );
  } catch (error) {
    codes.push("selection_mismatch");
    errors.push({
      code: "selection_mismatch",
      detail:
        error instanceof DrawError
          ? error.message
          : "The winner could not be derived from the published values."
    });
    return {
      verified: false,
      codes,
      warnings,
      winnerMemberId: null,
      winningTicket: null,
      selectedIndex: null,
      transcriptDigest,
      recomputedCommitment,
      errors
    };
  }

  const ordered = orderParticipants(rosterParticipants);
  const winner = ordered[selection.index];
  if (winner === undefined) {
    codes.push("selection_mismatch");
    errors.push({
      code: "selection_mismatch",
      detail: "The derived index falls outside the published roster."
    });
  }

  const verified = codes.length === 0 && winner !== undefined;
  if (verified && codes.length === 0) {
    codes.push("ok");
  }

  return {
    verified,
    codes,
    warnings,
    winnerMemberId: winner?.memberId ?? null,
    winningTicket: winner?.ticket ?? null,
    selectedIndex: selection.index,
    transcriptDigest,
    recomputedCommitment,
    errors
  };
}

/**
 * Verifies a stored round, and additionally cross-checks the winner the server
 * recorded. A server that reports a different winner than the arithmetic
 * produces is itself the tamper signal — the arithmetic wins.
 */
export async function verifyRound(
  round: DrawRound,
  input: { readonly supersededCommitmentCount?: number },
  hasher: DrawHasher
): Promise<DrawVerificationResult> {
  const result = await verifyTranscript(
    {
      drawId: round.drawId,
      groupId: round.groupId,
      cycleId: round.cycleId,
      round: round.round,
      commitment: round.commitment,
      rosterDigest: round.rosterDigest,
      commitmentNonce: round.commitmentNonce,
      memberDigest: round.memberDigest,
      memberCommitments: round.memberCommitments.map((contribution) => ({
        memberId: contribution.memberId,
        sealed: contribution.sealed
      })),
      seed: round.reveal?.seed ?? "",
      participants: round.participants.map((participant) => ({
        memberId: participant.memberId,
        ticket: participant.ticket,
        contributionAmount: participant.contributionAmount
      }))
    },
    hasher
  );

  const warnings = [...result.warnings];
  const codes = [...result.codes];

  if (round.reveal !== null && result.verified) {
    if (round.reveal.winnerMemberId !== result.winnerMemberId) {
      codes.push("selection_mismatch");
      warnings.push(
        `The recorded winner ${round.reveal.winnerMemberId} does not match the winner the published values produce (${result.winnerMemberId}).`
      );
    } else if (round.reveal.transcriptDigest !== result.transcriptDigest) {
      codes.push("selection_mismatch");
      warnings.push("The recorded transcript digest does not match the recomputed transcript.");
    }
  }

  if ((input.supersededCommitmentCount ?? 0) > 0) {
    codes.push("suspicious_commitment_history");
    warnings.push(
      `${input.supersededCommitmentCount ?? 0} commitment(s) for this round were created and then abandoned. Abandoned commitments are the signature of a treasurer searching seeds for a preferred winner, so this draw should be put to a member vote before the payout is treated as final.`
    );
  }

  /**
   * `verified` means the arithmetic reproduces the outcome. A recorded winner
   * that disagrees with the arithmetic is not a warning — the stored round is
   * wrong, and reporting it as verified would let a tampered server pass its
   * own check.
   */
  const arithmeticPassed = codes.every(
    (code) => code === "ok" || code === "suspicious_commitment_history"
  );

  return { ...result, verified: result.verified && arithmeticPassed, codes, warnings };
}
