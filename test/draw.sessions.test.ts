import { describe, expect, it } from "vitest";

import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";
import { computeMemberCommitment } from "@/lib/draw/canonical";
import { createCommitment, sealMemberContribution } from "@/lib/draw/engine";
import { isDrawError } from "@/lib/draw/errors";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository } from "@/lib/draw/repository";
import { DrawService } from "@/lib/draw/service";
import type { DrawErrorCode } from "@/lib/draw/types";

/**
 * The server-created draw lifecycle, against the in-memory double of the SQL
 * (`20261005100000_draw_cycles_and_member_seals.sql`; the SQL itself is proven by
 * `scripts/verify-migrations.sql`).
 *
 *   sealing --commit--> committed --request reveal + reveal--> revealed --> paid
 */

const hasher = nodeDrawHasher;
const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const OWNER = "11111111-1111-4111-8111-111111111111";
const TREASURER = "11111111-1111-4111-8111-1111111111ee";
const M1 = "33333333-3333-4333-8333-333333333333";
const M2 = "55555555-5555-4555-8555-555555555555";
const OUTSIDER = "66666666-6666-4666-8666-666666666666";
const CASH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEED = "treasurer-seed-0123456789-xyz";

const as = (userId: string) => ({ userId });

function build() {
  const repository = new InMemoryDrawRepository({
    groups: [
      {
        groupId: GROUP,
        members: [
          { userId: OWNER, role: "owner" },
          { userId: TREASURER, role: "treasurer" },
          { userId: M1, role: "member" },
          { userId: M2, role: "member" }
        ]
      }
    ],
    hasher,
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [
      { id: CASH, groupId: GROUP, code: "POT_CASH", name: "Pot cash", type: "asset" },
      { id: EXPENSE, groupId: GROUP, code: "PAYOUT_EXPENSE", name: "Payout", type: "expense" }
    ],
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  const service = new DrawService(repository, new LedgerService(ledger), {
    hasher,
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  return { repository, service };
}

type Built = ReturnType<typeof build>;

async function refusal(promise: Promise<unknown>): Promise<DrawErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (isDrawError(error)) return error.code;
    throw error;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

let sequence = 0;
const key = (label: string) => `${label}.${(sequence += 1)}`;

async function cycle(built: Built, rounds = 3) {
  const result = await built.service.createCycle(
    { groupId: GROUP, name: "Cycle", contributionAmount: "1000.00", totalRounds: rounds, reserveRatioBps: 1000, idempotencyKey: key("cyc") },
    as(TREASURER)
  );
  return result.cycle;
}

async function openRound(built: Built, cycleId: string) {
  return (await built.service.openDraw({ cycleId, idempotencyKey: key("open") }, as(TREASURER))).session;
}

/** A member's device: makes the nonce and the seal. Only the seal is ever sent first. */
async function memberSeal(drawId: string, memberId: string) {
  const nonce = `nonce-${memberId.slice(0, 8)}-${drawId.slice(0, 8)}-0123456789`;
  const sealed = (await sealMemberContribution({ drawId, memberId, nonce }, hasher)).sealed;
  return { nonce, sealed };
}

async function sealAs(built: Built, drawId: string, memberId: string) {
  const mine = await memberSeal(drawId, memberId);
  await built.service.submitSeal({ drawId, sealed: mine.sealed }, as(memberId));
  return mine;
}

const commit = (built: Built, drawId: string, by = TREASURER) =>
  built.service.commitFromSession(
    { drawId, seed: SEED, commitmentNonce: "treasurer-commit-nonce-0123456789", idempotencyKey: `commit.${drawId}` },
    as(by)
  );

describe("cycles", () => {
  it("lets an owner or treasurer create one, with the pot computed from the contribution and the members", async () => {
    const built = build();
    const created = await built.service.createCycle(
      { groupId: GROUP, name: "  Meskerem  ", contributionAmount: "250.50", totalRounds: 4, reserveRatioBps: 500, idempotencyKey: "cyc-a" },
      as(OWNER)
    );

    expect(created.replayed).toBe(false);
    expect(created.cycle).toMatchObject({
      name: "Meskerem",
      contributionAmount: "250.50",
      potAmount: "1002.00",
      totalRounds: 4,
      reserveRatioBps: 500,
      roundsRevealed: 0,
      nextRound: 1
    });
    expect((await built.service.createCycle(
      { groupId: GROUP, name: "T", contributionAmount: "1.00", totalRounds: 1, reserveRatioBps: 0, idempotencyKey: "cyc-b" },
      as(TREASURER)
    )).replayed).toBe(false);
  });

  it("refuses a plain member and an outsider, and creates nothing", async () => {
    const built = build();
    for (const userId of [M1, OUTSIDER]) {
      expect(
        await refusal(
          built.service.createCycle(
            { groupId: GROUP, name: "x", contributionAmount: "10.00", totalRounds: 1, reserveRatioBps: 0, idempotencyKey: "cyc-x" },
            as(userId)
          )
        )
      ).toBe("FORBIDDEN");
    }
    expect(await built.service.listCycles(GROUP, as(OWNER))).toHaveLength(0);
  });

  it("refuses more rounds than members, a sub-cent contribution and a bad reserve", async () => {
    const built = build();
    const base = { groupId: GROUP, name: "x", contributionAmount: "10.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "k" };
    expect(await refusal(built.service.createCycle({ ...base, totalRounds: 5 }, as(OWNER)))).toBe("INVALID_REQUEST");
    expect(await refusal(built.service.createCycle({ ...base, contributionAmount: "10.001" }, as(OWNER)))).toBe("INVALID_REQUEST");
    expect(await refusal(built.service.createCycle({ ...base, reserveRatioBps: 3334 }, as(OWNER)))).toBe("INVALID_REQUEST");
    expect(await refusal(built.service.createCycle({ ...base, name: "   " }, as(OWNER)))).toBe("INVALID_REQUEST");
  });

  it("replays the same key and conflicts on the same key with different terms", async () => {
    const built = build();
    const terms = { groupId: GROUP, name: "x", contributionAmount: "10.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "same" };
    const first = await built.service.createCycle(terms, as(OWNER));
    const again = await built.service.createCycle(terms, as(OWNER));
    expect(again.replayed).toBe(true);
    expect(again.cycle.cycleId).toBe(first.cycle.cycleId);
    expect(await refusal(built.service.createCycle({ ...terms, contributionAmount: "20.00" }, as(OWNER)))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await built.service.listCycles(GROUP, as(M1))).toHaveLength(1);
  });

  it("lets any member list and read, and nobody outside the group", async () => {
    const built = build();
    const made = await cycle(built);
    expect(await built.service.listCycles(GROUP, as(M2))).toHaveLength(1);
    expect((await built.service.getCycleDetail(made.cycleId, as(M1))).cycle.cycleId).toBe(made.cycleId);
    expect(await refusal(built.service.listCycles(GROUP, as(OUTSIDER)))).toBe("FORBIDDEN");
    expect(await refusal(built.service.getCycleDetail(made.cycleId, as(OUTSIDER)))).toBe("FORBIDDEN");
  });
});

describe("opening a draw", () => {
  it("is for owner and treasurer; the server creates the id; it starts sealing", async () => {
    const built = build();
    const made = await cycle(built);
    expect(await refusal(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: "o1" }, as(M1)))).toBe("FORBIDDEN");
    expect(await refusal(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: "o2" }, as(OUTSIDER)))).toBe("FORBIDDEN");

    const { session, replayed } = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: "o3" }, as(OWNER));
    expect(replayed).toBe(false);
    expect(session).toMatchObject({ round: 1, state: "sealing", seals: [], nonces: [], revealRequested: false });
    expect([...session.eligible].sort()).toEqual([OWNER, TREASURER, M1, M2].sort());
    expect(session.drawId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("continues the draw already sealing for the round instead of creating a second", async () => {
    const built = build();
    const made = await cycle(built);
    const first = await openRound(built, made.cycleId);
    const second = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("again") }, as(OWNER));
    expect(second.session.drawId).toBe(first.drawId);
    expect(second.replayed).toBe(true);
  });

  it("refuses a round out of order", async () => {
    const built = build();
    const made = await cycle(built);
    expect(await refusal(built.service.openDraw({ cycleId: made.cycleId, round: 2, idempotencyKey: "r2" }, as(OWNER)))).toBe(
      "ROUND_OUT_OF_ORDER"
    );
  });

  it("lists each draw with its state", async () => {
    const built = build();
    const made = await cycle(built);
    await openRound(built, made.cycleId);
    const detail = await built.service.getCycleDetail(made.cycleId, as(M1));
    expect(detail.draws).toHaveLength(1);
    expect(detail.draws[0]).toMatchObject({ round: 1, state: "sealing", sealCount: 0, nonceCount: 0, superseded: false, legacy: false });
  });
});

describe("a member seals for themselves", () => {
  it("stores the seal under the caller, never under anyone else", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    const mine = await memberSeal(session.drawId, M1);

    const result = await built.service.submitSeal({ drawId: session.drawId, sealed: mine.sealed }, as(M1));

    expect(result).toEqual({ memberId: M1, sealed: mine.sealed, replaced: false });
    const view = await built.service.getSession(session.drawId, as(M2));
    expect(view.seals).toHaveLength(1);
    expect(view.seals[0]).toMatchObject({ memberId: M1, sealed: mine.sealed });
    // The request has nowhere to name anyone else: the service takes (drawId, sealed) only.
    expect(Object.keys({ drawId: session.drawId, sealed: mine.sealed })).toEqual(["drawId", "sealed"]);
  });

  it("refuses an outsider, a malformed seal, and a member who is not on the roster", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    expect(await refusal(built.service.submitSeal({ drawId: session.drawId, sealed: "a".repeat(64) }, as(OUTSIDER)))).toBe("FORBIDDEN");
    expect(await refusal(built.service.submitSeal({ drawId: session.drawId, sealed: "not-a-hash" }, as(M1)))).toBe("INVALID_REQUEST");
    expect((await built.service.getSession(session.drawId, as(M1))).seals).toHaveLength(0);
  });

  it("allows a replacement while sealing, and refuses any seal after the commit", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    const first = await memberSeal(session.drawId, M1);
    await built.service.submitSeal({ drawId: session.drawId, sealed: first.sealed }, as(M1));
    const replacement = await built.service.submitSeal({ drawId: session.drawId, sealed: "b".repeat(64) }, as(M1));
    expect(replacement.replaced).toBe(true);
    await built.service.submitSeal({ drawId: session.drawId, sealed: first.sealed }, as(M1));
    await commit(built, session.drawId);

    expect(await refusal(built.service.submitSeal({ drawId: session.drawId, sealed: "c".repeat(64) }, as(M2)))).toBe("ALREADY_COMMITTED");
  });
});

describe("a nonce is released only after the commitment, and only by its owner", () => {
  async function sealed() {
    const built = build();
    const made = await cycle(built);
    const session = await openRound(built, made.cycleId);
    const m1 = await sealAs(built, session.drawId, M1);
    const m2 = await sealAs(built, session.drawId, M2);
    return { built, session, m1, m2, made };
  }

  it("is refused before the commit, whatever the nonce", async () => {
    const { built, session, m1 } = await sealed();
    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1)))).toBe("NONCE_TOO_EARLY");
    expect((await built.service.getSession(session.drawId, as(M1))).nonces).toEqual([]);
  });

  it("is refused for a wrong nonce, another member's nonce, a member who never sealed, and an outsider", async () => {
    const { built, session, m1, m2 } = await sealed();
    await commit(built, session.drawId);

    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: "wrong-nonce-0123456789-xxxx" }, as(M1)))).toBe(
      "MEMBER_COMMITMENT_MISMATCH"
    );
    // M2's genuine nonce, submitted by M1: it opens M2's seal, not M1's.
    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: m2.nonce }, as(M1)))).toBe("MEMBER_COMMITMENT_MISMATCH");
    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(OWNER)))).toBe("MEMBER_COMMITMENT_MISSING");
    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(OUTSIDER)))).toBe("FORBIDDEN");
    expect((await built.service.getSession(session.drawId, as(M1))).nonces.every((entry) => !entry.released)).toBe(true);
  });

  it("is accepted once, idempotent on a repeat, and never echoed", async () => {
    const { built, session, m1 } = await sealed();
    await commit(built, session.drawId);

    const first = await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));
    const again = await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));

    expect(first).toEqual({ memberId: M1, replayed: false });
    expect(again).toEqual({ memberId: M1, replayed: true });
    expect(JSON.stringify(first)).not.toContain(m1.nonce);
    const view = await built.service.getSession(session.drawId, as(M2));
    expect(view.nonces.find((entry) => entry.memberId === M1)?.released).toBe(true);
    expect(view.nonces.find((entry) => entry.memberId === M2)?.released).toBe(false);
  });

  it("is refused once the reveal has been requested", async () => {
    const { built, session, m1, m2 } = await sealed();
    await commit(built, session.drawId);
    await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));
    await built.service.submitNonce({ drawId: session.drawId, nonce: m2.nonce }, as(M2));
    await built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));

    expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1)))).toBe("ALREADY_REVEALED");
  });
});

describe("the commit is over what the database holds", () => {
  it("is for owner and treasurer only", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    await sealAs(built, session.drawId, M1);
    expect(await refusal(commit(built, session.drawId, M2))).toBe("FORBIDDEN");
    expect(await refusal(commit(built, session.drawId, OUTSIDER))).toBe("FORBIDDEN");
    expect((await built.service.getSession(session.drawId, as(M1))).state).toBe("sealing");
  });

  it("needs a seal from someone other than the committer", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    expect(await refusal(commit(built, session.drawId))).toBe("MEMBER_COMMITMENT_MISSING");
    await sealAs(built, session.drawId, TREASURER);
    // The treasurer's own seal alone does not stop them choosing the winner.
    expect(await refusal(commit(built, session.drawId))).toBe("MEMBER_COMMITMENT_MISSING");
    await sealAs(built, session.drawId, M1);
    expect((await commit(built, session.drawId)).round.state).toBe("committed");
  });

  it("commits to exactly the stored seals, the cycle's terms, and the group's roster", async () => {
    const built = build();
    const made = await cycle(built);
    const session = await openRound(built, made.cycleId);
    const m1 = await sealAs(built, session.drawId, M1);
    const m2 = await sealAs(built, session.drawId, M2);

    const { round, replayed } = await commit(built, session.drawId);

    expect(replayed).toBe(false);
    expect(round.memberCommitments.map((entry) => entry.memberId).sort()).toEqual([M1, M2].sort());
    expect(round.memberCommitments.find((entry) => entry.memberId === M1)?.sealed).toBe(m1.sealed);
    expect(round.memberCommitments.find((entry) => entry.memberId === M2)?.sealed).toBe(m2.sealed);
    expect(round).toMatchObject({ potAmount: "4000.00", totalRounds: 3, reserveRatioBps: 1000, round: 1, groupId: GROUP, cycleId: made.cycleId });
    expect(round.participants.map((p) => p.memberId).sort()).toEqual([OWNER, TREASURER, M1, M2].sort());
    expect(round.participants.every((p) => p.contributionAmount === "1000.00")).toBe(true);
    // No email or name is published: members have not agreed to show it.
    expect(round.participants.every((p) => p.displayName.startsWith("Member "))).toBe(true);
  });

  it("replays a retry and refuses a second, different commit", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    await sealAs(built, session.drawId, M1);
    const first = await commit(built, session.drawId);
    const retry = await commit(built, session.drawId);
    expect(retry.replayed).toBe(true);
    expect(retry.round.commitment).toBe(first.round.commitment);

    const other = built.service.commitFromSession(
      { drawId: session.drawId, seed: "another-seed-0123456789-qqq", commitmentNonce: "another-nonce-0123456789", idempotencyKey: "different" },
      as(TREASURER)
    );
    expect(["ALREADY_COMMITTED", "IDEMPOTENCY_CONFLICT"]).toContain(await refusal(other));
  });

  it("refuses a commitment built over seals that are not the stored ones, a typed roster, or typed terms", async () => {
    const built = build();
    const made = await cycle(built);
    const session = await openRound(built, made.cycleId);
    const m1 = await sealAs(built, session.drawId, M1);

    // What the application would build, and then the same thing with one lie in it.
    const honest = await createCommitment(
      {
        groupId: GROUP,
        cycleId: made.cycleId,
        round: 1,
        totalRounds: 3,
        drawId: session.drawId,
        commitmentNonce: "treasurer-commit-nonce-0123456789",
        seed: SEED,
        memberCommitments: [{ memberId: M1, sealed: m1.sealed }],
        potAmount: made.potAmount,
        reserveRatioBps: 1000,
        members: session.eligible.map((memberId) => ({
          memberId,
          displayName: `Member ${memberId.slice(0, 8)}`,
          status: "active" as const,
          contributionAmount: "1000.00"
        })),
        priorWinnerIds: [],
        committedBy: TREASURER,
        committedAt: "2026-10-01T10:00:00.000Z",
        idempotencyKey: key("forge")
      },
      hasher
    );
    const forge = (patch: Record<string, unknown>) =>
      built.repository.saveCommitment({ ...honest, idempotencyKey: key("forge"), ...patch }, as(TREASURER));

    // Seals the caller made up: a member digest over a set that is not the stored one.
    const bogus = await createCommitment(
      {
        groupId: GROUP,
        cycleId: made.cycleId,
        round: 1,
        totalRounds: 3,
        drawId: session.drawId,
        commitmentNonce: "treasurer-commit-nonce-0123456789",
        seed: SEED,
        memberCommitments: [{ memberId: M2, sealed: "d".repeat(64) }],
        potAmount: made.potAmount,
        reserveRatioBps: 1000,
        members: session.eligible.map((memberId) => ({
          memberId,
          displayName: "x",
          status: "active" as const,
          contributionAmount: "1000.00"
        })),
        priorWinnerIds: [],
        committedBy: TREASURER,
        committedAt: "2026-10-01T10:00:00.000Z",
        idempotencyKey: key("forge")
      },
      hasher
    );
    expect(await refusal(forge({ memberDigest: bogus.memberDigest, memberCommitments: bogus.memberCommitments }))).toBe(
      "MEMBER_COMMITMENT_MISMATCH"
    );
    // A different pot, reserve or round count than the cycle's.
    expect(await refusal(forge({ potAmount: "1.00" }))).toBe("INVALID_REQUEST");
    expect(await refusal(forge({ reserveRatioBps: 3333 }))).toBe("INVALID_REQUEST");
    expect(await refusal(forge({ totalRounds: 2 }))).toBe("INVALID_REQUEST");
    // A roster that leaves a member out.
    expect(await refusal(forge({ participants: honest.participants.slice(1) }))).toBe("INVALID_REQUEST");
    // A ticket that does not derive from the member.
    expect(
      await refusal(forge({ participants: honest.participants.map((p, index) => (index === 0 ? { ...p, ticket: "0".repeat(64) } : p)) }))
    ).toBe("INVALID_REQUEST");
    // A contribution other than the cycle's.
    expect(
      await refusal(forge({ participants: honest.participants.map((p, index) => (index === 0 ? { ...p, contributionAmount: "5000.00" } : p)) }))
    ).toBe("INVALID_REQUEST");
    // The grindable protocol.
    expect(await refusal(forge({ protocolVersion: "v2" }))).toBe("INVALID_REQUEST");
    // A draw that was never opened on the server.
    expect(await refusal(forge({ drawId: "99999999-9999-4999-8999-999999999999" }))).toBe("NOT_FOUND");
    // Nothing above was recorded.
    expect((await built.service.getSession(session.drawId, as(M1))).state).toBe("sealing");

    // And the honest one, from the same inputs, is accepted.
    expect((await forge({})).round.state).toBe("committed");
  });

  it("drops a seal from a member who is no longer eligible, and commits to the rest", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    await sealAs(built, session.drawId, M1);
    await sealAs(built, session.drawId, M2);
    built.repository.setGroup({
      groupId: GROUP,
      members: [
        { userId: OWNER, role: "owner" },
        { userId: TREASURER, role: "treasurer" },
        { userId: M1, role: "member" },
        { userId: M2, role: "member", active: false }
      ]
    });

    const { round } = await commit(built, session.drawId);

    expect(round.memberCommitments.map((entry) => entry.memberId)).toEqual([M1]);
    expect(round.participants.map((p) => p.memberId)).not.toContain(M2);
  });
});

describe("the reveal uses the stored nonces and publishes them only with a matching seed", () => {
  async function committed() {
    const built = build();
    const made = await cycle(built);
    const session = await openRound(built, made.cycleId);
    const m1 = await sealAs(built, session.drawId, M1);
    const m2 = await sealAs(built, session.drawId, M2);
    await commit(built, session.drawId);
    return { built, session, made, m1, m2 };
  }

  it("never returns a nonce from any read, before or after members release them", async () => {
    const { built, session, made, m1, m2 } = await committed();
    await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));

    const everything = async () =>
      JSON.stringify([
        await built.service.getSession(session.drawId, as(TREASURER)),
        await built.service.getCycleDetail(made.cycleId, as(TREASURER)),
        await built.service.listCycles(GROUP, as(TREASURER)),
        await built.service.getRound(session.drawId, as(TREASURER)),
        await built.service.verify(session.drawId, as(TREASURER))
      ]);
    for (const nonce of [m1.nonce, m2.nonce]) {
      expect(await everything()).not.toContain(nonce);
    }
    await built.service.submitNonce({ drawId: session.drawId, nonce: m2.nonce }, as(M2));
    for (const nonce of [m1.nonce, m2.nonce]) {
      expect(await everything()).not.toContain(nonce);
    }
  });

  it("refuses the request from a member, with the wrong seed, and while a nonce is missing: nothing is returned", async () => {
    const { built, session, m1 } = await committed();
    await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));

    expect(await refusal(built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(M1)))).toBe("FORBIDDEN");
    expect(await refusal(built.repository.requestReveal({ drawId: session.drawId, seed: "a-junk-seed-0123456789-qqqq" }, as(TREASURER)))).toBe(
      "COMMITMENT_MISMATCH"
    );
    // The right seed, but M2 has not released.
    expect(await refusal(built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER)))).toBe("MEMBER_COMMITMENT_MISSING");
    expect((await built.service.getSession(session.drawId, as(M1))).revealRequested).toBe(false);
  });

  it("through the service: waits for every nonce, ignores any nonce the caller supplies, and reveals", async () => {
    const { built, session, m1, m2 } = await committed();
    await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));
    expect(await refusal(built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER)))).toBe("MEMBER_COMMITMENT_MISSING");
    await built.service.submitNonce({ drawId: session.drawId, nonce: m2.nonce }, as(M2));

    const result = await built.service.reveal(
      // A forged opening supplied by the caller is not used on a server-created draw.
      { drawId: session.drawId, seed: SEED, memberNonces: [{ memberId: M1, nonce: "forged-nonce-0123456789-abcd" }] },
      as(TREASURER)
    );

    expect(result.verification.verified).toBe(true);
    expect(result.round.state).toBe("revealed");
    expect([...result.round.reveal!.memberNonces].sort((a, b) => (a.memberId < b.memberId ? -1 : 1))).toEqual(
      [
        { memberId: M1, nonce: m1.nonce },
        { memberId: M2, nonce: m2.nonce }
      ].sort((a, b) => (a.memberId < b.memberId ? -1 : 1))
    );
    // Only now are the seed and nonces in the published transcript.
    expect((await built.service.verify(session.drawId, as(M1))).transcript.seed).toBe(SEED);
  });

  it("refuses a reveal row that differs from the published opening", async () => {
    const { built, session, m1, m2 } = await committed();
    await built.service.submitNonce({ drawId: session.drawId, nonce: m1.nonce }, as(M1));
    await built.service.submitNonce({ drawId: session.drawId, nonce: m2.nonce }, as(M2));
    const round = await built.service.getRound(session.drawId, as(TREASURER));
    const opened = await built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));

    const reveal = {
      drawId: session.drawId,
      commitment: round.commitment,
      seed: SEED,
      memberDigest: round.memberDigest,
      memberNonces: opened!.memberNonces,
      transcriptDigest: "1".repeat(64),
      selectionDigest: "2".repeat(64),
      selectedIndex: 0,
      winnerMemberId: round.participants[0]!.memberId,
      winningTicket: round.participants[0]!.ticket,
      payoutAmount: "3600.00",
      reserveAmount: "400.00",
      revealedBy: TREASURER,
      revealedAt: "2026-10-01T10:00:00.000Z"
    };
    expect(await refusal(built.repository.saveReveal({ ...reveal, seed: "swapped-seed-0123456789-xxxx" }, as(TREASURER)))).toBe("COMMITMENT_MISMATCH");
    expect(
      await refusal(
        built.repository.saveReveal({ ...reveal, memberNonces: [{ memberId: M1, nonce: m1.nonce }, { memberId: M2, nonce: "forged-nonce-0123456789-abcd" }] }, as(TREASURER))
      )
    ).toBe("MEMBER_COMMITMENT_MISMATCH");
    expect((await built.service.getRound(session.drawId, as(TREASURER))).state).toBe("committed");
  });
});

describe("a whole cycle: rotation, order, and the state of every draw", () => {
  it("draws every member once, in order, never twice", async () => {
    const built = build();
    const made = await cycle(built, 4);
    const winners: string[] = [];

    for (let round = 1; round <= 4; round += 1) {
      const session = await openRound(built, made.cycleId);
      expect(session.round).toBe(round);
      // The roster shrinks by one each round: past winners are not eligible.
      expect(session.eligible).toHaveLength(4 - (round - 1));
      for (const winner of winners) {
        expect(session.eligible).not.toContain(winner);
        const mine = await memberSeal(session.drawId, winner);
        expect(await refusal(built.service.submitSeal({ drawId: session.drawId, sealed: mine.sealed }, as(winner)))).toBe("NOT_ELIGIBLE");
      }
      // The treasurer commits. Every other eligible member seals and releases; when
      // the treasurer is the only one left there is nothing to choose, so their own
      // seal is enough (the database allows exactly that case).
      const committer = TREASURER;
      const sealers = session.eligible.filter((id) => id !== committer);
      const secrets = new Map<string, string>();
      for (const id of sealers.length > 0 ? sealers : [committer]) secrets.set(id, (await sealAs(built, session.drawId, id)).nonce);
      await commit(built, session.drawId, committer);
      for (const [id, nonce] of secrets) await built.service.submitNonce({ drawId: session.drawId, nonce }, as(id));
      const { round: revealed } = await built.service.reveal({ drawId: session.drawId, seed: SEED }, as(committer));
      winners.push(revealed.reveal!.winnerMemberId);
    }

    expect(new Set(winners).size).toBe(4);
    const detail = await built.service.getCycleDetail(made.cycleId, as(M1));
    expect(detail.cycle).toMatchObject({ roundsRevealed: 4, nextRound: null });
    expect(detail.draws.map((entry) => entry.state)).toEqual(["revealed", "revealed", "revealed", "revealed"]);
    expect(await refusal(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("late") }, as(OWNER)))).toBe("CYCLE_COMPLETE");
  });

  it("marks an abandoned draw as superseded when a new one is opened for the round", async () => {
    const built = build();
    const made = await cycle(built);
    const first = await openRound(built, made.cycleId);
    await sealAs(built, first.drawId, M1);
    await commit(built, first.drawId);
    // The committed draw is abandoned (say a member lost their nonce); a fresh one is opened.
    const second = await openRound(built, made.cycleId);

    expect(second.drawId).not.toBe(first.drawId);
    const detail = await built.service.getCycleDetail(made.cycleId, as(M1));
    expect(detail.draws.find((entry) => entry.drawId === first.drawId)).toMatchObject({ state: "committed", superseded: true });
    expect(detail.draws.find((entry) => entry.drawId === second.drawId)).toMatchObject({ state: "sealing", superseded: false });
  });
});

describe("the double agrees with the engine on what a seal is", () => {
  it("accepts a nonce exactly when it hashes to the sealed value", async () => {
    const built = build();
    const session = await openRound(built, (await cycle(built)).cycleId);
    const nonce = "member-nonce-0123456789-abcdef";
    const sealed = await computeMemberCommitment({ drawId: session.drawId, memberId: M1, nonce }, hasher);
    await built.service.submitSeal({ drawId: session.drawId, sealed }, as(M1));
    await sealAs(built, session.drawId, M2);
    await commit(built, session.drawId);

    expect((await built.service.submitNonce({ drawId: session.drawId, nonce }, as(M1))).memberId).toBe(M1);
  });
});
