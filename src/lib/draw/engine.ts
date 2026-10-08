import {
  computeCommitment,
  computeMemberCommitment,
  computeMemberDigest,
  computeNonceDigest,
  computeRosterDigest,
  computeTranscriptDigest,
  deriveTicket,
  isHex64,
  orderParticipants,
  selectWinnerIndex,
  type DrawVerificationTranscript
} from "./canonical";
import { DRAW_CURRENT_PROTOCOL_VERSION } from "./types";
import { DrawError } from "./errors";
import { planDrawReserve, planReserve, assessDrawRisk, type ReservePlan } from "./risk";
import { buildParticipants, excludePriorWinners } from "./rotation";
import type {
  DrawCommitment,
  DrawHasher,
  DrawMember,
  DrawMemberCommitment,
  DrawMemberNonce,
  DrawProtocolVersion,
  DrawReveal,
  DrawRiskAssessment,
  DrawRound,
  DrawVerificationCode,
  DrawVerificationError,
  DrawVerificationResult,
  DrawVerificationWarning
} from "./types";

/**
 * The engine-level floor on sealed contributions. The ceremony itself (the database, and
 * `DrawService.commitFromSession`) requires a seal from EVERY eligible member, so this is only the
 * minimum the pure engine accepts when a caller passes no `minMemberCommitments`: one seal is the least
 * that makes grinding pointless, because the treasurer can no longer search for a value they do not hold.
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
   * Which derivation to commit under. Defaults to `v3`. `v2` exists only so
   * tests and migration tooling can build legacy fixtures; the service never
   * passes it and the database refuses a new v2 commitment.
   */
  readonly protocolVersion?: DrawProtocolVersion;
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
    nonceDigest: null,
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
  const protocolVersion = request.protocolVersion ?? DRAW_CURRENT_PROTOCOL_VERSION;
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
    protocolVersion,
    hasher
  );

  return {
    drawId: request.drawId,
    groupId: request.groupId,
    cycleId: request.cycleId,
    round: request.round,
    commitment,
    protocolVersion,
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
 * Check revealed nonces against the seals, without throwing.
 *
 * Returns the members whose opening is missing, wrong, repeated, or belongs to a
 * member who sealed nothing. Shared by the reveal (which refuses on any problem)
 * and by `verifyTranscript` (which reports it), so there is one definition of
 * "this nonce opens that seal" and the browser and server cannot disagree on it.
 */
export async function findBadOpenings(
  drawId: string,
  sealed: readonly DrawMemberCommitment[],
  nonces: readonly DrawMemberNonce[],
  hasher: DrawHasher
): Promise<string[]> {
  const bad = new Set<string>();
  const counts = new Map<string, number>();
  for (const entry of nonces) {
    counts.set(entry.memberId, (counts.get(entry.memberId) ?? 0) + 1);
  }
  const byMember = new Map(nonces.map((entry) => [entry.memberId, entry.nonce]));
  for (const contribution of sealed) {
    const nonce = byMember.get(contribution.memberId);
    if (nonce === undefined || nonce.length < 16 || (counts.get(contribution.memberId) ?? 0) !== 1) {
      bad.add(contribution.memberId);
      continue;
    }
    let recomputed: string | null;
    try {
      recomputed = await computeMemberCommitment(
        { drawId, memberId: contribution.memberId, nonce },
        hasher
      );
    } catch {
      recomputed = null;
    }
    if (recomputed !== contribution.sealed) bad.add(contribution.memberId);
  }
  for (const entry of nonces) {
    if (!sealed.some((contribution) => contribution.memberId === entry.memberId)) bad.add(entry.memberId);
  }
  return [...bad];
}

/**
 * Open every sealed member contribution.
 *
 * A member's nonce is only accepted if it hashes to what that member published
 * before the ceremony. Two digests come out:
 *
 *  - `memberDigest`: over the sealed hashes, which must equal the digest bound
 *    into the commitment (the set of contributors cannot have changed).
 *  - `nonceDigest`: over the verified `(memberId, nonce)` pairs. In protocol v3
 *    this feeds the transcript digest and therefore the winner, which is what
 *    stops a treasurer from grinding: the nonces are unknown at commit time.
 *
 * The opened set must equal the sealed set exactly. A duplicated member would
 * let a revealer repeat one nonce to hide that another was never opened — and
 * the unopened one is precisely the unknown the treasurer cannot grind over.
 */
export async function resolveMemberOpening(
  commitment: DrawCommitment,
  nonces: readonly DrawMemberNonce[],
  hasher: DrawHasher
): Promise<{ readonly memberDigest: string; readonly nonceDigest: string }> {
  if (nonces.length !== commitment.memberCommitments.length) {
    throw new DrawError(
      "MEMBER_COMMITMENT_MISSING",
      `The reveal opened ${nonces.length} member contribution(s) but ${commitment.memberCommitments.length} were sealed. The draw is refused.`
    );
  }

  const sealedByMember = new Map(
    commitment.memberCommitments.map((contribution) => [contribution.memberId, contribution.sealed])
  );

  const opened = new Set<string>();
  for (const entry of nonces) {
    const sealed = sealedByMember.get(entry.memberId);
    if (sealed === undefined) {
      throw new DrawError(
        "MEMBER_COMMITMENT_MISSING",
        "A revealed contribution belongs to a member who sealed nothing. The draw is refused."
      );
    }
    if (opened.has(entry.memberId)) {
      throw new DrawError(
        "MEMBER_COMMITMENT_MISSING",
        `The contribution of ${entry.memberId} was opened twice, so another sealed contribution was left unopened. The draw is refused.`
      );
    }
    opened.add(entry.memberId);
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
  // Every nonce above verified against its seal, so this digest covers only
  // verified nonces.
  const nonceDigest = await computeNonceDigest(
    { drawId: commitment.drawId, nonces },
    hasher
  );
  return { memberDigest, nonceDigest };
}

/** Back-compat wrapper: the digest over the sealed hashes. */
export async function resolveMemberDigest(
  commitment: DrawCommitment,
  nonces: readonly DrawMemberNonce[],
  hasher: DrawHasher
): Promise<string> {
  return (await resolveMemberOpening(commitment, nonces, hasher)).memberDigest;
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
  // winner is derived. In v3 this is the step that makes the draw fair: the
  // transcript digest that selects the winner includes a digest of these nonces,
  // which the treasurer did not have when they committed, so no seed search could
  // have targeted this outcome. (In legacy v2 the nonces were checked but did not
  // feed the winner — that was the grinding hole.)
  const { memberDigest, nonceDigest } = await resolveMemberOpening(
    commitment,
    input.memberNonces,
    hasher
  );

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
    commitment.protocolVersion,
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
      seed: input.seed,
      nonceDigest
    },
    commitment.protocolVersion,
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

  // v3 splits by the cycle's ratio (the database enforces it); v2 history was split by the exposure model.
  const planFor = commitment.protocolVersion === "v2" ? planReserve : planDrawReserve;
  const plan = planFor({
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
  // A transcript with no version predates versioning: v2. This cannot downgrade
  // a v3 draw, because the version is part of the commitment preimage.
  const protocolVersion: DrawProtocolVersion = transcript.protocolVersion ?? "v2";

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

  if (protocolVersion === "v3" && (transcript.memberNonces === undefined || transcript.memberNonces.length === 0)) {
    return unverified(
      ["incomplete_transcript"],
      [
        {
          code: "incomplete_transcript",
          detail:
            "The member nonces have not been published, and in a v3 draw they decide the winner, so the draw cannot be verified."
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

  // 3b. Does every revealed nonce open the seal it claims to? In v3 the nonce
  // digest feeds the winner, so it is computed only from nonces that verified:
  // an unverified nonce must never influence a selection a member then trusts.
  // For v2 the check runs whenever nonces are supplied (the legacy winner does
  // not depend on them, but a forged opening is still tampering).
  let nonceDigest: string | null = null;
  if (transcript.memberNonces !== undefined) {
    const bad = await findBadOpenings(
      transcript.drawId,
      transcript.memberCommitments,
      transcript.memberNonces,
      hasher
    );
    if (bad.length > 0) {
      codes.push("member_commitment_mismatch");
      errors.push({
        code: "member_commitment_mismatch",
        detail: `The revealed nonce for ${bad.join(", ")} is missing or does not open what that member sealed.`
      });
    } else if (protocolVersion === "v3") {
      nonceDigest = await computeNonceDigest(
        { drawId: transcript.drawId, nonces: transcript.memberNonces },
        hasher
      );
    }
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
    protocolVersion,
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

  // v3 without a verified nonce digest has no transcript digest at all: there
  // is nothing honest to compute it from.
  const transcriptDigest =
    protocolVersion === "v3" && nonceDigest === null
      ? null
      : await computeTranscriptDigest(
          {
            drawId: transcript.drawId,
            commitment: transcript.commitment,
            rosterDigest: transcript.rosterDigest,
            memberDigest: transcript.memberDigest,
            seed: transcript.seed,
            nonceDigest
          },
          protocolVersion,
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
      nonceDigest,
      recomputedCommitment,
      errors
    };
  }

  let selection;
  try {
    selection = await selectWinnerIndex(
      { transcriptDigest: transcriptDigest as string, eligibleCount: rosterParticipants.length },
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
      nonceDigest,
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
    nonceDigest,
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
      protocolVersion: round.protocolVersion,
      rosterDigest: round.rosterDigest,
      commitmentNonce: round.commitmentNonce,
      memberDigest: round.memberDigest,
      memberCommitments: round.memberCommitments.map((contribution) => ({
        memberId: contribution.memberId,
        sealed: contribution.sealed
      })),
      seed: round.reveal?.seed ?? "",
      memberNonces: (round.reveal?.memberNonces ?? []).map((entry) => ({
        memberId: entry.memberId,
        nonce: entry.nonce
      })),
      participants: round.participants.map((participant) => ({
        memberId: participant.memberId,
        ticket: participant.ticket,
        contributionAmount: participant.contributionAmount
      }))
    },
    hasher
  );

  const warnings = [...result.warnings];
  const warningItems: DrawVerificationWarning[] = [...(result.warningItems ?? [])];
  const codes = [...result.codes];

  if (round.reveal !== null && result.verified) {
    if (round.reveal.winnerMemberId !== result.winnerMemberId) {
      codes.push("selection_mismatch");
      warningItems.push({ code: "recorded_winner_mismatch" });
      warnings.push(
        `The recorded winner ${round.reveal.winnerMemberId} does not match the winner the published values produce (${result.winnerMemberId}).`
      );
    } else if (round.reveal.transcriptDigest !== result.transcriptDigest) {
      codes.push("selection_mismatch");
      warningItems.push({ code: "recorded_digest_mismatch" });
      warnings.push("The recorded transcript digest does not match the recomputed transcript.");
    }
  }

  if ((input.supersededCommitmentCount ?? 0) > 0) {
    codes.push("suspicious_commitment_history");
    warningItems.push({ code: "abandoned_commitments", count: input.supersededCommitmentCount ?? 0 });
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

  return { ...result, verified: result.verified && arithmeticPassed, codes, warnings, warningItems };
}
