import { DrawError } from "./errors";
import type {
  DrawCommitment,
  DrawHasher,
  DrawMemberNonce,
  DrawParticipant,
  DrawProtocolVersion,
  DrawReveal,
  DrawRosterEntry,
  DrawRound
} from "./types";

/**
 * Serialization versions, per protocol version.
 *
 * v2 strings are frozen: they are what every historical draw was hashed under,
 * and changing a byte would make those records unverifiable. v3 bumps both the
 * commit and the transcript tag. Binding the version into the *commitment* hash
 * matters: a v3 draw cannot be re-presented as v2 (its commitment would no longer
 * reproduce), so the weaker rules cannot be reached by relabelling.
 */
export const DRAW_COMMIT_SERIALIZATION_VERSION_V2 = "sened-draw-commit-v2";
export const DRAW_COMMIT_SERIALIZATION_VERSION_V3 = "sened-draw-commit-v3";
export const DRAW_TRANSCRIPT_SERIALIZATION_VERSION_V2 = "sened-draw-reveal-v2";
export const DRAW_TRANSCRIPT_SERIALIZATION_VERSION_V3 = "sened-draw-transcript-v3";
/** The current (v3) tags. */
export const DRAW_COMMIT_SERIALIZATION_VERSION = DRAW_COMMIT_SERIALIZATION_VERSION_V3;
export const DRAW_TRANSCRIPT_SERIALIZATION_VERSION = DRAW_TRANSCRIPT_SERIALIZATION_VERSION_V3;
export const DRAW_ROSTER_SERIALIZATION_VERSION = "sened-draw-roster-v1";
export const DRAW_NONCE_SET_SERIALIZATION_VERSION = "sened-draw-nonce-set-v1";
export const DRAW_TICKET_SERIALIZATION_VERSION = "sened-draw-ticket-v1";
export const DRAW_SELECTION_SERIALIZATION_VERSION = "sened-draw-selection-v1";
export const DRAW_MEMBER_COMMITMENT_SERIALIZATION_VERSION = "sened-draw-member-v1";
export const DRAW_MEMBER_SET_SERIALIZATION_VERSION = "sened-draw-member-set-v1";

export const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

const TWO_POW_256 = 1n << 256n;

/**
 * The number of extra hashes a single draw may burn before we declare the
 * hasher unable to produce a uniform draw. With an honest SHA-256 the chance
 * of ever reaching this is bounded by 2^-200 per round, so reaching it means
 * the hasher is broken. Failing closed beats looping forever.
 */
export const MAX_SELECTION_ROUNDS = 1_000;

/**
 * Length-prefixed encoding, byte-for-byte the same discipline as the ledger's
 * `canonical.ts`: every name and every value carries its own character count, so
 * no two distinct field sets can ever serialize to the same string. That is
 * what makes the commitment binding — a treasurer cannot move a field boundary
 * and land on the same digest.
 */
function encode(value: string): string {
  return `${Array.from(value).length}:${value}`;
}

function canonicalLine(name: string, value: string): string {
  return `${encode(name)}\n${encode(value)}`;
}

function joinVersion(version: string, lines: readonly string[]): string {
  return [encode(version), ...lines].join("\n");
}

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64_PATTERN.test(value);
}

export function assertHex64(value: unknown, label: string): string {
  if (!isHex64(value)) {
    throw new DrawError("INVALID_REQUEST", `${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

/**
 * Browser implementation, used by the `/draw` route so a member can verify a
 * published draw on their own device. Falls closed if WebCrypto is missing
 * rather than substituting a weaker hash.
 *
 * The Node hasher lives in `./nodeHasher` and is deliberately not imported here:
 * this module is reachable from a client component, and a `node:crypto` import
 * anywhere in its graph makes `/draw` unbuildable.
 */
export const webDrawHasher: DrawHasher = async (data: string) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DrawError("UNAVAILABLE", "WebCrypto SHA-256 is unavailable on this device");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export function canonicalSerializeRoster(participants: readonly DrawRosterEntry[]): string {
  return joinVersion(
    DRAW_ROSTER_SERIALIZATION_VERSION,
    participants.map((participant, index) =>
      [
        canonicalLine(`participant.${index}.memberId`, participant.memberId),
        canonicalLine(`participant.${index}.ticket`, participant.ticket),
        canonicalLine(`participant.${index}.contributionAmount`, participant.contributionAmount)
      ].join("\n")
    )
  );
}

/**
 * One member's sealed contribution to the draw.
 *
 * This is the whole point of the second commitment. `sened-draw-commit-v1` bound
 * a seed the *treasurer* chose, which is not a commitment in any useful sense:
 * the treasurer can try seeds until one hands the pot to a friend, then commit
 * to that one. Nothing about the old scheme prevented it, and nothing in the
 * reveal can detect it afterwards — by then the seed is simply the seed.
 *
 * A member's contribution is chosen by the member and sealed before the
 * treasurer commits, so the treasurer cannot search for it. Binding the *hash*
 * here and revealing the nonce later is what makes that checkable by every
 * member on their own phone: nobody has to trust that a nonce was contributed,
 * only that the published one is the one that was sealed.
 */
export function canonicalSerializeMemberCommitment(input: {
  readonly drawId: string;
  readonly memberId: string;
  readonly nonce: string;
}): string {
  return joinVersion(DRAW_MEMBER_COMMITMENT_SERIALIZATION_VERSION, [
    canonicalLine("drawId", input.drawId),
    canonicalLine("memberId", input.memberId),
    canonicalLine("nonce", input.nonce)
  ]);
}

/**
 * The aggregate of every member contribution, in memberId order.
 *
 * Sorted here rather than trusting the caller's order, so two members submitting
 * in opposite orders produce the same digest. An unsorted list would let a
 * treasurer reorder contributions and land on a different commitment for the
 * same set.
 */
export function canonicalSerializeMemberSet(input: {
  readonly drawId: string;
  readonly contributions: readonly { readonly memberId: string; readonly sealed: string }[];
}): string {
  const ordered = [...input.contributions].sort((left, right) =>
    left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0
  );
  return joinVersion(DRAW_MEMBER_SET_SERIALIZATION_VERSION, [
    canonicalLine("drawId", input.drawId),
    ...ordered.map((contribution, index) =>
      [
        canonicalLine(`member.${index}.memberId`, contribution.memberId),
        canonicalLine(`member.${index}.sealed`, contribution.sealed)
      ].join("\n")
    )
  ]);
}

/**
 * The member nonce set: every revealed `(memberId, nonce)` pair, in memberId
 * order, bound to the draw.
 *
 * This is the value that makes the winner depend on randomness the treasurer
 * does not have when they commit. Callers must pass only nonces that have already
 * been checked against their seals; a duplicate member is refused rather than
 * silently collapsed, because collapsing would let a revealer drop a member's
 * nonce by repeating another's.
 */
export function canonicalSerializeNonceSet(input: {
  readonly drawId: string;
  readonly nonces: readonly DrawMemberNonce[];
}): string {
  const ordered = [...input.nonces].sort((left, right) =>
    left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.memberId === ordered[index - 1]!.memberId) {
      throw new DrawError(
        "MEMBER_COMMITMENT_MISMATCH",
        "A member nonce appears more than once in the revealed set. The draw is refused."
      );
    }
  }
  return joinVersion(DRAW_NONCE_SET_SERIALIZATION_VERSION, [
    canonicalLine("drawId", input.drawId),
    ...ordered.map((entry, index) =>
      [
        canonicalLine(`nonce.${index}.memberId`, entry.memberId),
        canonicalLine(`nonce.${index}.nonce`, entry.nonce)
      ].join("\n")
    )
  ]);
}

export function canonicalSerializeCommit(
  input: {
    readonly groupId: string;
    readonly cycleId: string;
    readonly round: number;
    readonly drawId: string;
    readonly rosterDigest: string;
    readonly commitmentNonce: string;
    readonly memberDigest: string;
    readonly seed: string;
  },
  protocolVersion: DrawProtocolVersion
): string {
  const version =
    protocolVersion === "v3"
      ? DRAW_COMMIT_SERIALIZATION_VERSION_V3
      : DRAW_COMMIT_SERIALIZATION_VERSION_V2;
  return joinVersion(version, [
    canonicalLine("groupId", input.groupId),
    canonicalLine("cycleId", input.cycleId),
    canonicalLine("round", String(input.round)),
    canonicalLine("drawId", input.drawId),
    canonicalLine("rosterDigest", input.rosterDigest),
    canonicalLine("commitmentNonce", input.commitmentNonce),
    canonicalLine("memberDigest", input.memberDigest),
    canonicalLine("seed", input.seed)
  ]);
}

/**
 * The transcript preimage whose digest selects the winner.
 *
 * v2: `(drawId, commitment, rosterDigest, memberDigest, seed)`. Every one of
 * those is known to the treasurer before they commit, which is the grinding hole.
 *
 * v3: adds `nonceDigest`, the digest of the revealed member nonces. The treasurer
 * does not know the nonces at commit time, so they cannot search for a winner.
 */
export function canonicalSerializeTranscript(
  input: {
    readonly drawId: string;
    readonly commitment: string;
    readonly rosterDigest: string;
    readonly memberDigest: string;
    readonly seed: string;
    /** Required for v3, ignored for v2. */
    readonly nonceDigest?: string | null;
  },
  protocolVersion: DrawProtocolVersion
): string {
  if (protocolVersion === "v2") {
    return joinVersion(DRAW_TRANSCRIPT_SERIALIZATION_VERSION_V2, [
      canonicalLine("drawId", input.drawId),
      canonicalLine("commitment", input.commitment),
      canonicalLine("rosterDigest", input.rosterDigest),
      canonicalLine("memberDigest", input.memberDigest),
      canonicalLine("seed", input.seed)
    ]);
  }
  if (!isHex64(input.nonceDigest)) {
    throw new DrawError(
      "INTEGRITY_FAILURE",
      "A v3 transcript needs the digest of the verified member nonces"
    );
  }
  return joinVersion(DRAW_TRANSCRIPT_SERIALIZATION_VERSION_V3, [
    canonicalLine("drawId", input.drawId),
    canonicalLine("commitment", input.commitment),
    canonicalLine("rosterDigest", input.rosterDigest),
    canonicalLine("memberDigest", input.memberDigest),
    canonicalLine("nonceDigest", input.nonceDigest),
    canonicalLine("seed", input.seed)
  ]);
}

export function canonicalSerializeTicket(input: {
  readonly groupId: string;
  readonly cycleId: string;
  readonly memberId: string;
}): string {
  return joinVersion(DRAW_TICKET_SERIALIZATION_VERSION, [
    canonicalLine("groupId", input.groupId),
    canonicalLine("cycleId", input.cycleId),
    canonicalLine("memberId", input.memberId)
  ]);
}

export function canonicalSerializeSelection(input: {
  readonly transcriptDigest: string;
  readonly attempt: number;
}): string {
  return joinVersion(DRAW_SELECTION_SERIALIZATION_VERSION, [
    canonicalLine("transcriptDigest", input.transcriptDigest),
    canonicalLine("attempt", String(input.attempt))
  ]);
}

export async function sha256With(
  hasher: DrawHasher,
  value: string
): Promise<string> {
  const digest = await hasher(value);
  if (!isHex64(digest)) {
    throw new DrawError(
      "INTEGRITY_FAILURE",
      "Hasher did not return 64 lowercase hexadecimal characters"
    );
  }
  return digest;
}

/**
 * A member's ticket is a function of their identity and the cycle alone. It
 * never depends on the seed, the pot, the round, or their position in any list
 * the treasurer controls, so the treasurer cannot choose a winner by choosing
 * who draws which ticket. The full 256-bit hash is the ticket; the UI truncates
 * for display but ordering always uses the whole value.
 */
export async function deriveTicket(
  input: { readonly groupId: string; readonly cycleId: string; readonly memberId: string },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeTicket(input));
}

export async function computeRosterDigest(
  participants: readonly DrawRosterEntry[],
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeRoster(participants));
}

export async function computeMemberCommitment(
  input: { readonly drawId: string; readonly memberId: string; readonly nonce: string },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeMemberCommitment(input));
}

export async function computeMemberDigest(
  input: {
    readonly drawId: string;
    readonly contributions: readonly { readonly memberId: string; readonly sealed: string }[];
  },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeMemberSet(input));
}

export async function computeNonceDigest(
  input: { readonly drawId: string; readonly nonces: readonly DrawMemberNonce[] },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeNonceSet(input));
}

export async function computeCommitment(
  input: {
    readonly groupId: string;
    readonly cycleId: string;
    readonly round: number;
    readonly drawId: string;
    readonly rosterDigest: string;
    readonly commitmentNonce: string;
    readonly memberDigest: string;
    readonly seed: string;
  },
  protocolVersion: DrawProtocolVersion,
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeCommit(input, protocolVersion));
}

export async function computeTranscriptDigest(
  input: {
    readonly drawId: string;
    readonly commitment: string;
    readonly rosterDigest: string;
    readonly memberDigest: string;
    readonly seed: string;
    readonly nonceDigest?: string | null;
  },
  protocolVersion: DrawProtocolVersion,
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeTranscript(input, protocolVersion));
}

/**
 * Rejection sampling for a bias-free winner.
 *
 * A plain `digest mod n` is very slightly biased: the first `2^256 mod n`
 * residues would be one candidate more likely than the rest. Rejecting any
 * digest at or above the largest multiple of `n` that fits in 256 bits removes
 * that entirely. It costs one extra SHA-256 with probability roughly
 * `n / 2^256` — for a roster of 200 that is about 10^-74, so in practice the
 * first hash always wins, but the rule is implemented honestly rather than
 * waved away.
 */
export async function selectWinnerIndex(
  input: { readonly transcriptDigest: string; readonly eligibleCount: number },
  hasher: DrawHasher
): Promise<{ readonly index: number; readonly digest: string; readonly attempts: number }> {
  const eligibleCount = input.eligibleCount;
  if (!Number.isInteger(eligibleCount) || eligibleCount < 1) {
    throw new DrawError(
      "NO_ELIGIBLE_PARTICIPANTS",
      "A draw needs at least one eligible participant"
    );
  }

  const modulus = BigInt(eligibleCount);
  const bound = TWO_POW_256 - (TWO_POW_256 % modulus);

  for (let attempt = 0; attempt <= MAX_SELECTION_ROUNDS; attempt += 1) {
    const digest = await sha256With(
      hasher,
      canonicalSerializeSelection({ transcriptDigest: input.transcriptDigest, attempt })
    );
    const value = BigInt(`0x${digest}`);
    if (value < bound) {
      return { index: Number(value % modulus), digest, attempts: attempt + 1 };
    }
  }

  throw new DrawError(
    "UNIFORMITY_EXHAUSTED",
    `Could not derive an unbiased winner within ${MAX_SELECTION_ROUNDS} attempts`
  );
}

/**
 * Canonical ordering used by every winner lookup. Tickets are unique by
 * construction, but sorting on `memberId` as a tie-break keeps the order total
 * even in the impossible case of a collision, so two members can never compute
 * two different orders for the same roster.
 */
export function orderParticipants<T extends { readonly ticket: string; readonly memberId: string }>(
  participants: readonly T[]
): T[] {
  return [...participants].sort((left, right) => {
    if (left.ticket === right.ticket) {
      return left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0;
    }
    return left.ticket < right.ticket ? -1 : 1;
  });
}

export function participantTickets(participants: readonly DrawParticipant[]): string[] {
  return orderParticipants(participants).map((participant) => participant.ticket);
}

/**
 * The minimum set of published values a member needs in order to recompute a
 * draw. This is the object a `/draw` screen renders and a member can read aloud
 * to a nother member. If a field is missing, verification returns
 * `incomplete_transcript` instead of guessing.
 */
export interface DrawVerificationTranscript {
  readonly drawId: string;
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly commitment: string;
  /**
   * Which derivation the draw was committed under. Absent means a transcript
   * published before versioning existed, i.e. `v2`. Absence can never be used to
   * downgrade a v3 draw: the version is bound into the commitment hash, so a v3
   * commitment does not reproduce under v2 rules.
   */
  readonly protocolVersion?: DrawProtocolVersion;
  readonly rosterDigest: string;
  readonly commitmentNonce: string;
  /**
   * The sealed member contributions and their digest.
   *
   * A member verifying a draw needs both: the digest proves what was committed,
   * and the commitments are what each revealed nonce is checked against. Without
   * them a verifier could only confirm the treasurer was consistent with
   * himself.
   */
  readonly memberDigest: string;
  readonly memberCommitments: readonly { readonly memberId: string; readonly sealed: string }[];
  readonly seed: string;
  /**
   * The nonces revealed with the seed. Optional for v2 (where they are checked
   * only when supplied); required for v3, where they decide the winner.
   */
  readonly memberNonces?: readonly DrawMemberNonce[];
  readonly participants: readonly {
    readonly memberId: string;
    readonly ticket: string;
    readonly contributionAmount: string;
  }[];
}

export function toVerificationTranscript(round: DrawRound): DrawVerificationTranscript {
  return {
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
  };
}

export function toPublicCommitment(round: DrawRound): Omit<DrawCommitment, "commitmentNonce"> {
  const { commitmentNonce: _commitmentNonce, ...rest } = round;
  return rest;
}

export function toPublicReveal(reveal: DrawReveal): Omit<DrawReveal, "seed"> {
  const { seed: _seed, ...rest } = reveal;
  return rest;
}
