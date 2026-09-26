import {
  computeCommitment,
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
  DrawReveal,
  DrawRiskAssessment,
  DrawRound,
  DrawVerificationCode,
  DrawVerificationError,
  DrawVerificationResult
} from "./types";

export interface CommitRequest {
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly totalRounds: number;
  readonly drawId: string;
  readonly commitmentNonce: string;
  readonly seed: string;
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly members: readonly DrawMember[];
  readonly priorWinnerIds: readonly string[];
  readonly committedBy: string;
  readonly committedAt: string;
  readonly idempotencyKey: string;
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
  const commitment = await computeCommitment(
    {
      groupId: request.groupId,
      cycleId: request.cycleId,
      round: request.round,
      drawId: request.drawId,
      rosterDigest,
      commitmentNonce: request.commitmentNonce,
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
export async function openReveal(
  commitment: DrawCommitment,
  input: { readonly seed: string; readonly revealedBy: string; readonly revealedAt: string },
  hasher: DrawHasher
): Promise<RevealResult> {
  const recomputed = await computeCommitment(
    {
      groupId: commitment.groupId,
      cycleId: commitment.cycleId,
      round: commitment.round,
      drawId: commitment.drawId,
      rosterDigest: commitment.rosterDigest,
      commitmentNonce: commitment.commitmentNonce,
      seed: input.seed
    },
    hasher
  );

  if (recomputed !== commitment.commitment) {
    throw new DrawError(
      "COMMITMENT_MISMATCH",
      "The revealed seed does not reproduce the published commitment. The draw is refused."
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
    ["rosterDigest", transcript.rosterDigest]
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

  // 3. Does the seed reproduce the commitment?
  const recomputedCommitment = await computeCommitment(
    {
      groupId: transcript.groupId,
      cycleId: transcript.cycleId,
      round: transcript.round,
      drawId: transcript.drawId,
      rosterDigest: transcript.rosterDigest,
      commitmentNonce: transcript.commitmentNonce,
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
