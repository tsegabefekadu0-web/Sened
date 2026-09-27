import { describe, expect, it } from "vitest";

import { computeMemberDigest } from "@/lib/draw/canonical";
import {
  createCommitment,
  openReveal,
  resolveMemberDigest,
  sealMemberContribution,
  sortMemberContributions
} from "@/lib/draw/engine";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import type { DrawMember, DrawMemberCommitment } from "@/lib/draw/types";

/**
 * M4.3 — the treasurer can no longer choose the winner.
 *
 * `sened-draw-commit-v1` bound a seed the treasurer picked. A commitment only
 * means something if the party making it could not have searched for the outcome
 * first, and that was never true: the treasurer could try seeds until one handed
 * the pot to a friend and then commit to that one. The reveal would be perfectly
 * consistent, every member's independent check would pass, and the draw would be
 * completely rigged. Nothing could detect it afterwards, because by then the
 * seed is simply the seed.
 *
 * These tests are the property that fixes it. A member seals a nonce before the
 * treasurer commits, only its hash is published, and the nonce enters the
 * commitment. The treasurer cannot search over a value they do not have.
 *
 * What this does **not** claim: it does not stop a treasurer from *colluding*
 * with a member, and a single contribution is a floor rather than a quorum. A
 * group that wants real resistance to a colluding treasurer should require
 * several contributions — `minMemberCommitments` exists for exactly that. One is
 * the minimum that makes unilateral grinding impossible.
 */

const hasher = nodeDrawHasher;
const groupId = "22222222-2222-4222-8222-222222222222";
const cycleId = "77777777-7777-4777-8777-777777777777";
const treasurer = "11111111-1111-4111-8111-111111111111";
const drawId = "55555555-5555-4555-8555-555555555555";
const TREASURER_SEED = "treasurer-seed-0123456789-ABC";
const MEMBER_NONCE = "member-nonce-0123456789-QQQ";

function member(index: number): DrawMember {
  return {
    memberId: `${String(index).padStart(4, "0")}4444-4444-8444-8444-444444444444`,
    displayName: `Member ${index}`,
    status: "active",
    contributionAmount: "5000.00"
  };
}

const roster: DrawMember[] = [member(1), member(2), member(3), member(4), member(5)];

function commitRequest(
  overrides: Partial<Parameters<typeof createCommitment>[0]> = {}
): Parameters<typeof createCommitment>[0] {
  return {
    groupId,
    cycleId,
    round: 1,
    totalRounds: 5,
    drawId,
    commitmentNonce: "nonce-0123456789abcdef-XYZ",
    seed: TREASURER_SEED,
    potAmount: "25000.00",
    reserveRatioBps: 1000,
    members: roster,
    memberCommitments: [],
    priorWinnerIds: [],
    committedBy: treasurer,
    committedAt: "2026-09-26T09:00:00.000Z",
    idempotencyKey: "draw-commit-1",
    ...overrides
  };
}

async function seal(
  memberId: string,
  nonce: string = MEMBER_NONCE
): Promise<DrawMemberCommitment> {
  return sealMemberContribution({ drawId, memberId, nonce }, hasher);
}

async function commitWith(
  contributions: readonly DrawMemberCommitment[],
  overrides: Partial<Parameters<typeof createCommitment>[0]> = {}
) {
  return createCommitment(
    commitRequest({ ...overrides, memberCommitments: contributions }),
    hasher
  );
}

describe("a round cannot commit without a member's sealed contribution", () => {
  it("REFUSES a commitment with no member contribution at all", async () => {
    // This is the exact shape the old protocol accepted, and the one that let a
    // treasurer grind seeds. It is now a refusal.
    await expect(commitWith([])).rejects.toMatchObject({
      code: "MEMBER_COMMITMENT_MISSING"
    });
  });

  it("names the reason, so a treasurer is told what to do rather than just refused", async () => {
    await expect(commitWith([])).rejects.toMatchObject({
      message: expect.stringMatching(/searching seeds/i)
    });
  });

  it("refuses a contribution from someone who is not on the eligible roster", async () => {
    const outsider = await seal("99994444-4444-8444-8444-444444444444");

    await expect(commitWith([outsider])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("refuses the same member counting twice toward the quorum", async () => {
    const once = await seal(roster[0]!.memberId);

    await expect(commitWith([once, once])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("refuses a value that is not a digest", async () => {
    await expect(
      commitWith([{ memberId: roster[0]!.memberId, sealed: "not-a-digest" }])
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("honours a higher quorum when a group asks for one", async () => {
    const single = await seal(roster[0]!.memberId);
    const second = await seal(roster[1]!.memberId, "member-nonce-two-0123456789");

    await expect(
      commitWith([single], { minMemberCommitments: 2 })
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISSING" });

    const both = await commitWith([single, second], { minMemberCommitments: 2 });
    expect(both.memberCommitments).toHaveLength(2);
  });
});

describe("the treasurer cannot search for a favourable outcome", () => {
  it("cannot reveal a member nonce they chose themselves", async () => {
    const sealed = await seal(roster[0]!.memberId);
    const commitment = await commitWith([sealed]);

    // The treasurer tries a different member nonce. Nothing about the ceremony
    // stops them from *attempting* it; the commitment is what makes it fail.
    await expect(
      openReveal(
        commitment,
        {
          seed: TREASURER_SEED,
          memberNonces: [
            { memberId: roster[0]!.memberId, nonce: "a-nonce-they-invented-1234" }
          ],
          revealedBy: treasurer,
          revealedAt: "2026-09-26T09:30:00.000Z"
        },
        hasher
      )
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISMATCH" });
  });

  it("cannot grind 200 seeds for the pot and land on a valid reveal", async () => {
    // The attack the old scheme permitted, run to completion. For each candidate
    // seed the treasurer computes the winner and keeps the one that pays their
    // friend — then commits. Here the member sealed first, so every one of those
    // seeds fails to reproduce the commitment.
    const sealed = await seal(roster[0]!.memberId);
    const commitment = await commitWith([sealed]);

    let forgedAccepted = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = `grind-seed-${String(attempt).padStart(4, "0")}-abcdefgh`;
      try {
        await openReveal(
          commitment,
          {
            seed: candidate,
            memberNonces: [{ memberId: roster[0]!.memberId, nonce: MEMBER_NONCE }],
            revealedBy: treasurer,
            revealedAt: "2026-09-26T09:30:00.000Z"
          },
          hasher
        );
        forgedAccepted += 1;
      } catch {
        // Expected: the commitment binds a value the search never varied.
      }
    }

    expect(forgedAccepted).toBe(0);
  });

  it("still refuses a wrong seed even with the right member nonce", async () => {
    const sealed = await seal(roster[0]!.memberId);
    const commitment = await commitWith([sealed]);

    await expect(
      openReveal(
        commitment,
        {
          seed: "a-different-seed-0123456789",
          memberNonces: [{ memberId: roster[0]!.memberId, nonce: MEMBER_NONCE }],
          revealedBy: treasurer,
          revealedAt: "2026-09-26T09:30:00.000Z"
        },
        hasher
      )
    ).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" });
  });

  it("opens the honest reveal", async () => {
    const sealed = await seal(roster[0]!.memberId);
    const commitment = await commitWith([sealed]);

    const opened = await openReveal(
      commitment,
      {
        seed: TREASURER_SEED,
        memberNonces: [{ memberId: roster[0]!.memberId, nonce: MEMBER_NONCE }],
        revealedBy: treasurer,
        revealedAt: "2026-09-26T09:30:00.000Z"
      },
      hasher
    );

    expect(opened.reveal.memberDigest).toBe(commitment.memberDigest);
    expect(opened.reveal.memberNonces).toHaveLength(1);
  });

  it("changes the outcome when a different member seals, which is the point", async () => {
    // Same treasurer, same seed, same roster. Only the member's contribution
    // differs — and with it the winner. If the outcome were determined by the
    // treasurer's entropy alone, these two would be identical.
    const fromFirst = await commitWith([await seal(roster[0]!.memberId)]);
    const fromSecond = await commitWith([
      await seal(roster[1]!.memberId, "a-different-member-nonce-987")
    ]);

    expect(fromFirst.commitment).not.toBe(fromSecond.commitment);
    expect(fromFirst.memberDigest).not.toBe(fromSecond.memberDigest);
  });
});

describe("a member's own check, on their own phone", () => {
  it("accepts the published set and rejects an edited one", async () => {
    const first = await seal(roster[0]!.memberId);
    const second = await seal(roster[1]!.memberId, "member-nonce-two-0123456789");
    const commitment = await commitWith([first, second]);

    const honest = await resolveMemberDigest(
      commitment,
      [
        { memberId: roster[0]!.memberId, nonce: MEMBER_NONCE },
        { memberId: roster[1]!.memberId, nonce: "member-nonce-two-0123456789" }
      ],
      hasher
    );
    expect(honest).toBe(commitment.memberDigest);

    await expect(
      resolveMemberDigest(
        commitment,
        [
          { memberId: roster[0]!.memberId, nonce: MEMBER_NONCE },
          { memberId: roster[1]!.memberId, nonce: "swapped-out-for-another-999" }
        ],
        hasher
      )
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISMATCH" });
  });

  it("refuses a reveal that opens only some of the sealed contributions", async () => {
    const first = await seal(roster[0]!.memberId);
    const second = await seal(roster[1]!.memberId, "member-nonce-two-0123456789");
    const commitment = await commitWith([first, second]);

    // Dropping one member's nonce would let the treasurer keep a partial
    // ceremony, where the randomness that decided the winner is not all public.
    await expect(
      resolveMemberDigest(commitment, [{ memberId: roster[0]!.memberId, nonce: MEMBER_NONCE }], hasher)
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISSING" });
  });

  it("refuses a nonce for a member who sealed nothing", async () => {
    const commitment = await commitWith([await seal(roster[0]!.memberId)]);

    await expect(
      resolveMemberDigest(
        commitment,
        [
          { memberId: roster[0]!.memberId, nonce: MEMBER_NONCE },
          { memberId: roster[4]!.memberId, nonce: "unsolicited-nonce-012345" }
        ],
        hasher
      )
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISSING" });
  });

  it("does not depend on the order contributions were submitted in", async () => {
    const first = await seal(roster[0]!.memberId);
    const second = await seal(roster[1]!.memberId, "member-nonce-two-0123456789");

    const forward = await computeMemberDigest(
      { drawId, contributions: sortMemberContributions([first, second]) },
      hasher
    );
    const backward = await computeMemberDigest(
      { drawId, contributions: sortMemberContributions([second, first]) },
      hasher
    );

    // Otherwise a treasurer could reorder the published set and land on a
    // different digest for the same contributions.
    expect(forward).toBe(backward);
  });

  it("binds each nonce to the draw, so one cannot be replayed into another", async () => {
    const sealedHere = await seal(roster[0]!.memberId);
    const sealedThere = await sealMemberContribution(
      { drawId: "66666666-6666-4666-8666-666666666666", memberId: roster[0]!.memberId, nonce: MEMBER_NONCE },
      hasher
    );

    // Same member, same nonce, different round. Without the drawId in the
    // preimage a contribution could be lifted from one draw into another.
    expect(sealedHere.sealed).not.toBe(sealedThere.sealed);
  });
});
