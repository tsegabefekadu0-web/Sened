import { describe, expect, it } from "vitest";

import {
  canonicalSerializeCommit,
  canonicalSerializeRoster,
  computeRosterDigest,
  MAX_SELECTION_ROUNDS,
  selectWinnerIndex,
  toVerificationTranscript
} from "@/lib/draw/canonical";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { DrawError } from "@/lib/draw/errors";
import {
  createCommitment,
  openReveal,
  sealMemberContribution,
  verifyRound,
  verifyTranscript
} from "@/lib/draw/engine";
import {
  assertNotPriorWinner,
  excludePriorWinners,
  rotationExhausted
} from "@/lib/draw/rotation";
import type {
  DrawMember,
  DrawMemberCommitment,
  DrawMemberNonce,
  DrawRound
} from "@/lib/draw/types";

const hasher = nodeDrawHasher;
const groupId = "22222222-2222-4222-8222-222222222222";
const cycleId = "77777777-7777-4777-8777-777777777777";
const treasurer = "11111111-1111-4111-8111-111111111111";
const SEED = "seed-0123456789abcdef-ABC";
const REVEALED_AT = "2026-09-26T09:30:00.000Z";

function member(index: number, overrides: Partial<DrawMember> = {}): DrawMember {
  const hex = String(index).padStart(4, "0");
  return {
    memberId: `${hex}4444-4444-8444-8444-444444444444`,
    displayName: `Member ${index}`,
    status: "active",
    contributionAmount: "5000.00",
    ...overrides
  };
}

const roster: DrawMember[] = [member(1), member(2), member(3), member(4), member(5)];

const drawId = "55555555-5555-4555-8555-555555555555";
/** A member's nonce. Chosen by the member, never by the treasurer. */
const MEMBER_NONCE = "member-nonce-0123456789-QQQ";

/**
 * Seal a member's contribution.
 *
 * Every existing draw test now needs one, because a round can no longer commit
 * without it. That is the point of the change: the fixtures had to be rewritten
 * to include randomness the treasurer does not control, which is exactly the
 * thing that used to be missing.
 */
async function sealOne(
  memberId: string = roster[0]!.memberId,
  nonce: string = MEMBER_NONCE
): Promise<DrawMemberCommitment> {
  return sealMemberContribution({ drawId, memberId, nonce }, hasher);
}

async function noncesFor(
  commitments: readonly DrawMemberCommitment[]
): Promise<DrawMemberNonce[]> {
  return Promise.all(
    commitments.map(async (contribution) => ({
      memberId: contribution.memberId,
      nonce: contribution.memberId === roster[0]!.memberId ? MEMBER_NONCE : `${contribution.memberId}-nonce`
    }))
  );
}

async function reveal(
  commitment: Awaited<ReturnType<typeof createCommitment>>,
  seed = SEED
) {
  return openReveal(
    commitment,
    { seed, memberNonces: await noncesFor(commitment.memberCommitments), revealedBy: treasurer, revealedAt: REVEALED_AT },
    hasher
  );
}

function commitRequest(overrides: Partial<Parameters<typeof createCommitment>[0]> = {}) {
  return {
    groupId,
    cycleId,
    round: 1,
    totalRounds: 5,
    drawId,
    commitmentNonce: "nonce-0123456789abcdef-XYZ",
    seed: SEED,
    potAmount: "25000.00",
    reserveRatioBps: 1000,
    members: roster,
    priorWinnerIds: [],
    committedBy: treasurer,
    committedAt: "2026-09-26T09:00:00.000Z",
    idempotencyKey: "draw-commit-1",
    ...overrides
  };
}

/** `commitRequest` with one member's contribution already sealed. */
async function commitRequestWithMember(
  overrides: Partial<Parameters<typeof createCommitment>[0]> = {}
) {
  // Seal from a member who is still eligible. A member already drawn is off the
  // roster, and refusing their contribution is the product working.
  const priorWinners = overrides.priorWinnerIds ?? [];
  const eligible =
    roster.find((entry) => !priorWinners.includes(entry.memberId))?.memberId ?? roster[0]!.memberId;
  return {
    ...commitRequest(overrides),
    memberCommitments: [await sealOne(eligible)]
  };
}

async function committedDraw(overrides: Partial<Parameters<typeof createCommitment>[0]> = {}) {
  return createCommitment(await commitRequestWithMember(overrides), hasher);
}

function asRound(commitment: Awaited<ReturnType<typeof createCommitment>>): DrawRound {
  return {
    ...commitment,
    state: "committed",
    reveal: null,
    payout: null
  };
}

describe("canonical encoding", () => {
  it("is length-prefixed so a field boundary cannot be shifted without detection", () => {
    const serialized = canonicalSerializeCommit({
      groupId: "ab",
      cycleId: "c",
      round: 1,
      drawId: "d",
      rosterDigest: "e",
      commitmentNonce: "f",
      memberDigest: "0".repeat(64),
      seed: "g"
    });

    expect(serialized.startsWith("20:sened-draw-commit-v2")).toBe(true);
    expect(serialized).toContain("7:groupId\n2:ab");
    expect(serialized).toContain("7:cycleId\n1:c");
  });

  it("gives a different digest to a different roster ordering", async () => {
    const forward = roster.map((entry) => ({ memberId: entry.memberId, contributionAmount: entry.contributionAmount, ticket: "a".repeat(64) }));
    const reversed = [...forward].reverse();

    const forwardDigest = await computeRosterDigest(forward, hasher);
    const reversedDigest = await computeRosterDigest(reversed, hasher);

    expect(forwardDigest).not.toBe(reversedDigest);
  });

  it("is stable across repeated serialization", () => {
    const participants = roster.map((entry) => ({ memberId: entry.memberId, contributionAmount: "5000.00", ticket: "b".repeat(64) }));

    expect(canonicalSerializeRoster(participants)).toBe(canonicalSerializeRoster(participants));
  });
});

describe("winner selection", () => {
  it("rejects a roster with no eligible participants instead of inventing one", async () => {
    await expect(selectWinnerIndex({ transcriptDigest: "a".repeat(64), eligibleCount: 0 }, hasher)).rejects.toMatchObject({
      code: "NO_ELIGIBLE_PARTICIPANTS"
    });
  });

  it("always lands inside the roster", async () => {
    for (let size = 1; size <= 8; size += 1) {
      const selection = await selectWinnerIndex(
        { transcriptDigest: "c".repeat(64), eligibleCount: size },
        hasher
      );
      expect(selection.index).toBeGreaterThanOrEqual(0);
      expect(selection.index).toBeLessThan(size);
    }
  });

  it("is deterministic for the same transcript", async () => {
    const first = await selectWinnerIndex({ transcriptDigest: "d".repeat(64), eligibleCount: 5 }, hasher);
    const second = await selectWinnerIndex({ transcriptDigest: "d".repeat(64), eligibleCount: 5 }, hasher);

    expect(first).toEqual(second);
  });

  it("covers every candidate across many transcripts", async () => {
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      const selection = await selectWinnerIndex(
        { transcriptDigest: String(index).padStart(64, "0"), eligibleCount: 5 },
        hasher
      );
      seen.add(selection.index);
    }
    expect(seen.size).toBe(5);
  });

  it("keeps the rejection-sampling round budget bounded", () => {
    expect(MAX_SELECTION_ROUNDS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SELECTION_ROUNDS)).toBe(true);
  });
});

describe("commit", () => {
  it("publishes a commitment, roster digest, and one ticket per eligible member", async () => {
    const commitment = await committedDraw();

    expect(commitment.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment.rosterDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment.participants).toHaveLength(5);
    for (const participant of commitment.participants) {
      expect(participant.ticket).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("excludes prior winners from the committed roster", async () => {
    const commitment = await committedDraw({ priorWinnerIds: [roster[0].memberId, roster[2].memberId] });

    expect(commitment.participants.map((p) => p.memberId)).not.toContain(roster[0].memberId);
    expect(commitment.participants.map((p) => p.memberId)).not.toContain(roster[2].memberId);
    expect(commitment.participants).toHaveLength(3);
  });

  it("excludes inactive members", async () => {
    const commitment = await committedDraw({
      members: [...roster, member(6, { status: "inactive" })]
    });

    expect(commitment.participants).toHaveLength(5);
  });

  it("REJECTS a seed with too little entropy", async () => {
    await expect(committedDraw({ seed: "short" })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  it("REJECTS a commitment nonce equal to the seed", async () => {
    await expect(
      committedDraw({
        seed: "same-value-0123456789",
        commitmentNonce: "same-value-0123456789"
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("REJECTS a duplicate member in the roster", async () => {
    await expect(committedDraw({ members: [roster[0], roster[0]] })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  it("REJECTS a commit with no eligible participants", async () => {
    await expect(
      committedDraw({ members: [], priorWinnerIds: [] })
    ).rejects.toMatchObject({ code: "NO_ELIGIBLE_PARTICIPANTS" });
  });

  it("binds the commitment to the roster, so dropping a member changes it", async () => {
    const full = await committedDraw();
    const reduced = await committedDraw({ priorWinnerIds: [roster[0].memberId] });

    expect(reduced.commitment).not.toBe(full.commitment);
  });

  it("binds the commitment to the round, so the same seed cannot be reused", async () => {
    const first = await committedDraw({ round: 1 });
    const second = await committedDraw({ round: 2 });

    expect(second.commitment).not.toBe(first.commitment);
  });
});

describe("reveal", () => {
  it("derives a winner and sizes the payout below the pot", async () => {
    const commitment = await committedDraw();
    const { reveal: published, risk, plan } = await reveal(commitment);

    expect(published.winnerMemberId).toBeTruthy();
    expect(published.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(published.payoutAmount).not.toBe(commitment.potAmount);
    expect(
      BigInt(published.payoutAmount.replace(".", "")) + BigInt(published.reserveAmount.replace(".", ""))
    ).toBe(BigInt(commitment.potAmount.replace(".", "")));
    expect(plan.reserveMinor).toBeGreaterThan(0n);
    expect(risk.notes.length).toBeGreaterThan(0);
  });

  it("REJECTS a tampered seed and refuses to name a winner", async () => {
    const commitment = await committedDraw();

    await expect(reveal(commitment, "a-different-seed-0123456")).rejects.toMatchObject({
      code: "COMMITMENT_MISMATCH"
    });
  });

  it("REJECTS a roster edited after the commitment", async () => {
    const commitment = await committedDraw();
    const tampered = {
      ...commitment,
      participants: commitment.participants.slice(0, 4)
    };

    await expect(reveal(tampered)).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" });
  });

  it("REJECTS a ticket reassigned to a different member", async () => {
    const commitment = await committedDraw();
    const participants = [...commitment.participants];
    const swapped = {
      ...participants[0],
      ticket: participants[1].ticket
    };
    const tampered = { ...commitment, participants: [swapped, ...participants.slice(2)] };

    await expect(reveal(tampered)).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" });
  });
});

describe("independent verification", () => {
  it("reproduces the winner from published values alone", async () => {
    const commitment = await committedDraw();
    const { reveal: published } = await reveal(commitment);

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: commitment.commitment,
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: SEED,
        participants: commitment.participants.map((p) => ({
          memberId: p.memberId,
          ticket: p.ticket,
          contributionAmount: p.contributionAmount
        }))
      },
      hasher
    );

    expect(result.verified).toBe(true);
    expect(result.codes).toEqual(["ok"]);
    expect(result.winnerMemberId).toBe(published.winnerMemberId);
    expect(result.winningTicket).toBe(published.winningTicket);
    expect(result.transcriptDigest).toBe(published.transcriptDigest);
  });

  it("DETECTS a tampered seed", async () => {
    const commitment = await committedDraw();
    const { reveal: published } = await reveal(commitment);

    const result = await verifyTranscript(
      {
        ...toVerificationTranscript({ ...asRound(commitment), reveal: published }),
        seed: "a-forged-seed-01234567"
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("commitment_mismatch");
    expect(result.winnerMemberId).toBeNull();
  });

  it("DETECTS a tampered commitment", async () => {
    const commitment = await committedDraw();

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: "f".repeat(64),
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: SEED,
        participants: commitment.participants.map((p) => ({
          memberId: p.memberId,
          ticket: p.ticket,
          contributionAmount: p.contributionAmount
        }))
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("commitment_mismatch");
  });

  it("DETECTS a member removed from the published roster", async () => {
    const commitment = await committedDraw();

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: commitment.commitment,
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: SEED,
        participants: commitment.participants.slice(1).map((p) => ({
          memberId: p.memberId,
          ticket: p.ticket,
          contributionAmount: p.contributionAmount
        }))
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("roster_mismatch");
  });

  it("DETECTS a ticket swapped between two members", async () => {
    const commitment = await committedDraw();
    const participants = commitment.participants.map((p) => ({
      memberId: p.memberId,
      ticket: p.ticket,
      contributionAmount: p.contributionAmount
    }));
    const swapped = [...participants];
    const first = swapped[0].ticket;
    swapped[0] = { ...swapped[0], ticket: swapped[1].ticket };
    swapped[1] = { ...swapped[1], ticket: first };

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: commitment.commitment,
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: SEED,
        participants: swapped
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("roster_mismatch");
  });

  it("REJECTS verification before the seed is revealed instead of guessing", async () => {
    const commitment = await committedDraw();

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: commitment.commitment,
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: "",
        participants: commitment.participants.map((p) => ({
          memberId: p.memberId,
          ticket: p.ticket,
          contributionAmount: p.contributionAmount
        }))
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toEqual(["incomplete_transcript"]);
  });

  it("REJECTS a transcript whose commitment is not a digest", async () => {
    const commitment = await committedDraw();

    const result = await verifyTranscript(
      {
        drawId: commitment.drawId,
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        commitment: "not-a-hash",
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        memberCommitments: commitment.memberCommitments,
        seed: SEED,
        participants: commitment.participants.map((p) => ({
          memberId: p.memberId,
          ticket: p.ticket,
          contributionAmount: p.contributionAmount
        }))
      },
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toEqual(["incomplete_transcript"]);
  });

  it("DETECTS a server that reports a winner other than the arithmetic", async () => {
    const commitment = await committedDraw();
    const { reveal: published } = await reveal(commitment);
    const round: DrawRound = { ...asRound(commitment), reveal: published, state: "revealed" };

    // Pick a member who is demonstrably not the winner the arithmetic produces.
    const impostor = commitment.participants.find((p) => p.memberId !== published.winnerMemberId);
    expect(impostor).toBeDefined();

    const result = await verifyRound(
      { ...round, reveal: { ...published, winnerMemberId: impostor?.memberId ?? "" } },
      {},
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("selection_mismatch");
    expect(result.warnings.join(" ")).toMatch(/recorded winner/i);
  });

  it("DETECTS a server that reports a different transcript digest", async () => {
    const commitment = await committedDraw();
    const { reveal: published } = await reveal(commitment);
    const round: DrawRound = { ...asRound(commitment), reveal: published, state: "revealed" };

    const result = await verifyRound(
      { ...round, reveal: { ...published, transcriptDigest: "9".repeat(64) } },
      {},
      hasher
    );

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("selection_mismatch");
    expect(result.warnings.join(" ")).toMatch(/transcript digest/i);
  });

  it("flags abandoned commitments as a governance warning without failing the arithmetic", async () => {
    const commitment = await committedDraw();
    const { reveal: published } = await reveal(commitment);
    const round: DrawRound = { ...asRound(commitment), reveal: published, state: "revealed" };

    const result = await verifyRound(round, { supersededCommitmentCount: 3 }, hasher);

    expect(result.verified).toBe(true);
    expect(result.codes).toContain("suspicious_commitment_history");
    expect(result.warnings.join(" ")).toMatch(/member vote/i);
  });
});

describe("rotation", () => {
  it("excludes every prior winner of the cycle", () => {
    const remaining = excludePriorWinners(roster, [roster[0].memberId, roster[1].memberId]);

    expect(remaining.map((m) => m.memberId)).toEqual([roster[2].memberId, roster[3].memberId, roster[4].memberId]);
  });

  it("REJECTS a repeat winner", () => {
    expect(() => assertNotPriorWinner(roster[0].memberId, [roster[0].memberId])).toThrow(DrawError);
    expect(() => assertNotPriorWinner(roster[0].memberId, [roster[0].memberId])).toThrow(/already been drawn/i);
    expect(() => assertNotPriorWinner(roster[3].memberId, [roster[0].memberId])).not.toThrow();
  });

  it("reports rotation exhaustion rather than redrawing a winner", () => {
    expect(rotationExhausted(roster, roster.map((m) => m.memberId))).toBe(true);
    expect(rotationExhausted(roster, [roster[0].memberId])).toBe(false);
  });
});
