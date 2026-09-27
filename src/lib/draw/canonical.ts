import { DrawError } from "./errors";
import type {
  DrawCommitment,
  DrawHasher,
  DrawParticipant,
  DrawReveal,
  DrawRosterEntry,
  DrawRound
} from "./types";

export const DRAW_COMMIT_SERIALIZATION_VERSION = "sened-draw-commit-v1";
export const DRAW_ROSTER_SERIALIZATION_VERSION = "sened-draw-roster-v1";
export const DRAW_TRANSCRIPT_SERIALIZATION_VERSION = "sened-draw-reveal-v1";
export const DRAW_TICKET_SERIALIZATION_VERSION = "sened-draw-ticket-v1";
export const DRAW_SELECTION_SERIALIZATION_VERSION = "sened-draw-selection-v1";

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

export function canonicalSerializeCommit(input: {
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly drawId: string;
  readonly rosterDigest: string;
  readonly commitmentNonce: string;
  readonly seed: string;
}): string {
  return joinVersion(DRAW_COMMIT_SERIALIZATION_VERSION, [
    canonicalLine("groupId", input.groupId),
    canonicalLine("cycleId", input.cycleId),
    canonicalLine("round", String(input.round)),
    canonicalLine("drawId", input.drawId),
    canonicalLine("rosterDigest", input.rosterDigest),
    canonicalLine("commitmentNonce", input.commitmentNonce),
    canonicalLine("seed", input.seed)
  ]);
}

export function canonicalSerializeTranscript(input: {
  readonly drawId: string;
  readonly commitment: string;
  readonly seed: string;
  readonly rosterDigest: string;
}): string {
  return joinVersion(DRAW_TRANSCRIPT_SERIALIZATION_VERSION, [
    canonicalLine("drawId", input.drawId),
    canonicalLine("commitment", input.commitment),
    canonicalLine("rosterDigest", input.rosterDigest),
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

export async function computeCommitment(
  input: {
    readonly groupId: string;
    readonly cycleId: string;
    readonly round: number;
    readonly drawId: string;
    readonly rosterDigest: string;
    readonly commitmentNonce: string;
    readonly seed: string;
  },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeCommit(input));
}

export async function computeTranscriptDigest(
  input: {
    readonly drawId: string;
    readonly commitment: string;
    readonly rosterDigest: string;
    readonly seed: string;
  },
  hasher: DrawHasher
): Promise<string> {
  return sha256With(hasher, canonicalSerializeTranscript(input));
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
  readonly rosterDigest: string;
  readonly commitmentNonce: string;
  readonly seed: string;
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
    rosterDigest: round.rosterDigest,
    commitmentNonce: round.commitmentNonce,
    seed: round.reveal?.seed ?? "",
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
