import { describe, expect, it, vi } from "vitest";

import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";
import { sealMemberContribution, openReveal } from "@/lib/draw/engine";
import { createCommitment } from "@/lib/draw/engine";
import { isDrawError } from "@/lib/draw/errors";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository, SupabaseDrawRepository } from "@/lib/draw/repository";
import { assessDrawRisk, planDrawReserve } from "@/lib/draw/risk";
import { drawCommitRequestSchema, drawPayoutRequestSchema, drawRevealRequestSchema } from "@/lib/draw/schemas";
import { DrawService } from "@/lib/draw/service";
import { DrawError } from "@/lib/draw/errors";
import type { DrawActorContext } from "@/lib/draw/repository";
import type { DrawErrorCode, DrawPayout, DrawRound } from "@/lib/draw/types";
import { DRAW_CANCEL_LIMIT } from "@/lib/draw/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The draw-integrity fixes (20261014100000_draw_integrity.sql), against the in-memory double of the
 * SQL and the real service. The SQL itself is proven by `scripts/verify-migrations.sql`
 * (DRAW-INTEGRITY); these tests pin the TypeScript side to the same rules:
 *
 *   1  the winner is derived, never typed        5  the payout split is the cycle's ratio
 *   2  one live draw per round, no re-roll       6  seed and nonce are required
 *   3  every eligible member must seal           7  a payout retry is a replay
 *   4  the deadline-bound cancel path            10 the commit time is the database's
 */

const hasher = nodeDrawHasher;
const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const OWNER = "11111111-1111-4111-8111-111111111111";
const TREASURER = "11111111-1111-4111-8111-1111111111ee";
const M1 = "33333333-3333-4333-8333-333333333333";
const M2 = "55555555-5555-4555-8555-555555555555";
const CASH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEED = "treasurer-seed-0123456789-xyz";
const COMMIT_NONCE = "treasurer-commit-nonce-0123456789";
const START = new Date("2026-10-01T10:00:00.000Z");

const as = (userId: string): DrawActorContext => ({ userId });
const everyone = [OWNER, TREASURER, M1, M2];

class FlakyPayoutRepository extends InMemoryDrawRepository {
  failNextPayout = false;
  override async savePayout(payout: DrawPayout, context: DrawActorContext): Promise<DrawRound> {
    if (this.failNextPayout) {
      this.failNextPayout = false;
      throw new DrawError("UNAVAILABLE", "the connection dropped after the ledger was written");
    }
    return super.savePayout(payout, context);
  }
}

function build() {
  const state = { now: new Date(START) };
  const clock = () => new Date(state.now);
  const advanceHours = (hours: number) => {
    state.now = new Date(state.now.getTime() + hours * 3_600_000);
  };
  const repository = new FlakyPayoutRepository({
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
    clock
  });
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [
      { id: CASH, groupId: GROUP, code: "POT_CASH", name: "Pot cash", type: "asset" },
      { id: EXPENSE, groupId: GROUP, code: "PAYOUT_EXPENSE", name: "Payout", type: "expense" }
    ],
    clock
  });
  const service = new DrawService(repository, new LedgerService(ledger), { hasher, clock });
  return { repository, ledger, service, advanceHours };
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

async function cycle(built: Built, extra: { sealWindowHours?: number; nonceWindowHours?: number } = {}) {
  return (
    await built.service.createCycle(
      {
        groupId: GROUP,
        name: "Cycle",
        contributionAmount: "1000.00",
        totalRounds: 3,
        reserveRatioBps: 1000,
        idempotencyKey: key("cyc"),
        ...extra
      },
      as(TREASURER)
    )
  ).cycle;
}

const open = (built: Built, cycleId: string, who = TREASURER, extra: { excludeMissed?: boolean } = {}) =>
  built.service.openDraw({ cycleId, idempotencyKey: key("open"), ...extra }, as(who));

async function secret(drawId: string, memberId: string) {
  const nonce = `nonce-${memberId.slice(0, 8)}-${drawId.slice(0, 8)}-0123456789`;
  return { nonce, sealed: (await sealMemberContribution({ drawId, memberId, nonce }, hasher)).sealed };
}

async function seal(built: Built, drawId: string, members: readonly string[]) {
  for (const memberId of members) {
    await built.service.submitSeal({ drawId, sealed: (await secret(drawId, memberId)).sealed }, as(memberId));
  }
}

async function release(built: Built, drawId: string, members: readonly string[]) {
  for (const memberId of members) {
    await built.service.submitNonce({ drawId, nonce: (await secret(drawId, memberId)).nonce }, as(memberId));
  }
}

const commit = (built: Built, drawId: string, who = TREASURER) =>
  built.service.commitFromSession({ drawId, seed: SEED, commitmentNonce: COMMIT_NONCE, idempotencyKey: `commit.${drawId}` }, as(who));

/** Round 1 run to a committed draw with every nonce released. */
async function committedAndReleased(built: Built) {
  const made = await cycle(built);
  const session = (await open(built, made.cycleId)).session;
  await seal(built, session.drawId, everyone);
  await commit(built, session.drawId);
  await release(built, session.drawId, everyone);
  return { made, session };
}

describe("1. the winner is derived, never typed (the double mirrors the database)", () => {
  async function honestReveal(built: Built) {
    const { session } = await committedAndReleased(built);
    const opened = await built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
    const round = await built.service.getRound(session.drawId, as(TREASURER));
    const { reveal } = await openReveal(
      round,
      { seed: SEED, memberNonces: opened!.memberNonces, revealedBy: TREASURER, revealedAt: START.toISOString() },
      hasher
    );
    return { session, round, reveal };
  }

  it("refuses a forged index, winner, ticket, transcript digest or selection digest", async () => {
    const built = build();
    const { session, round, reveal } = await honestReveal(built);
    const other = round.participants.find((p) => p.memberId !== reveal.winnerMemberId)!;

    const forged = [
      { ...reveal, selectedIndex: (reveal.selectedIndex + 1) % round.participants.length },
      { ...reveal, winnerMemberId: other.memberId, winningTicket: other.ticket },
      { ...reveal, transcriptDigest: "7".repeat(64) },
      { ...reveal, selectionDigest: "8".repeat(64) },
      { ...reveal, winningTicket: other.ticket }
    ];
    for (const attempt of forged) {
      expect(await refusal(built.repository.saveReveal(attempt, as(TREASURER)))).toBe("INTEGRITY_FAILURE");
    }
    expect((await built.service.getRound(session.drawId, as(TREASURER))).state).toBe("committed");

    // The honest values are accepted, so the refusals above are about the values and not the path.
    expect((await built.repository.saveReveal(reveal, as(TREASURER))).state).toBe("revealed");
  });

  it("refuses a split that is not the cycle's ratio of the pot", async () => {
    const built = build();
    const { reveal } = await honestReveal(built);
    for (const [payoutAmount, reserveAmount] of [
      ["4000.00", "0.00"],
      ["3599.00", "401.00"],
      ["3700.00", "300.00"]
    ] as const) {
      expect(await refusal(built.repository.saveReveal({ ...reveal, payoutAmount, reserveAmount }, as(TREASURER)))).toBe("INTEGRITY_FAILURE");
    }
  });

  it("the service reveals with exactly the derived values", async () => {
    const built = build();
    const { session } = await committedAndReleased(built);
    const result = await built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
    expect(result.round.state).toBe("revealed");
    expect(result.verification.verified).toBe(true);
    expect(result.round.reveal).toMatchObject({ payoutAmount: "3600.00", reserveAmount: "400.00" });
  });
});

describe("2. one live draw per round, and one reveal per round", () => {
  it("refuses to open a round over a committed draw, however it is asked", async () => {
    const built = build();
    const made = await cycle(built);
    const first = (await open(built, made.cycleId)).session;
    await seal(built, first.drawId, everyone);
    await commit(built, first.drawId);

    expect(await refusal(open(built, made.cycleId))).toBe("ROUND_HAS_LIVE_DRAW");
    expect(await refusal(built.service.openDraw({ cycleId: made.cycleId, round: 1, idempotencyKey: key("open") }, as(OWNER)))).toBe("ROUND_HAS_LIVE_DRAW");
    // Not even with a half-finished draw: members still owe nonces, the draw is still THE draw.
    await release(built, first.drawId, [OWNER]);
    expect(await refusal(open(built, made.cycleId))).toBe("ROUND_HAS_LIVE_DRAW");
    expect((await built.service.getCycleDetail(made.cycleId, as(M1))).draws).toHaveLength(1);
  });

  it("a draw is revealed once: a second reveal of it is refused", async () => {
    const built = build();
    const { session } = await committedAndReleased(built);
    await built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
    expect(await refusal(built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER)))).toBe("ALREADY_REVEALED");
  });
});

describe("3. every eligible member must seal", () => {
  it("is refused with a seal missing, at the double and at the service, and works at M of M", async () => {
    const built = build();
    const made = await cycle(built);
    const session = (await open(built, made.cycleId)).session;
    await seal(built, session.drawId, [OWNER, TREASURER, M1]);

    expect(await refusal(commit(built, session.drawId))).toBe("MEMBER_COMMITMENT_MISSING");
    // The quorum is the session's eligible set, not a number of seals.
    expect((await built.service.getSession(session.drawId, as(M1))).eligible).toHaveLength(4);
    await seal(built, session.drawId, [M2]);
    expect((await commit(built, session.drawId)).round.state).toBe("committed");
  });

  it("commits to every member's seal", async () => {
    const built = build();
    const { session } = await committedAndReleased(built);
    const round = await built.service.getRound(session.drawId, as(M1));
    expect(round.memberCommitments.map((entry) => entry.memberId).sort()).toEqual([...everyone].sort());
  });
});

describe("4. the cancel path", () => {
  const reason = "A member never answered within the window";

  it("is refused before the seal deadline, to a plain member, with a thin reason, and when nobody missed", async () => {
    const built = build();
    const made = await cycle(built);
    const session = (await open(built, made.cycleId)).session;
    // Everyone seals in time: after the deadline nobody could seal any more (see "7b").
    await seal(built, session.drawId, [OWNER, TREASURER, M1, M2]);

    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_TOO_EARLY");
    built.advanceHours(47);
    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_TOO_EARLY");
    built.advanceHours(2);
    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(M1)))).toBe("FORBIDDEN");
    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason: "short" }, as(TREASURER)))).toBe("INVALID_REQUEST");

    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_NOTHING_MISSED");
  });

  it("7b. refuses seals after the seal deadline, and cannot strand the round either way", async () => {
    // Somebody is missing: nobody can seal after the deadline, commit is refused, cancel works.
    const late = build();
    const lateMade = await cycle(late);
    const lateSession = (await open(late, lateMade.cycleId)).session;
    await seal(late, lateSession.drawId, [OWNER, TREASURER, M1]);
    late.advanceHours(49);
    const sealed = async (who: string) => (await secret(lateSession.drawId, who)).sealed;
    // the missing member, and a sealed member changing their seal, are both refused
    expect(await refusal(late.service.submitSeal({ drawId: lateSession.drawId, sealed: await sealed(M2) }, as(M2)))).toBe("SEAL_DEADLINE_PASSED");
    expect(await refusal(late.service.submitSeal({ drawId: lateSession.drawId, sealed: "e".repeat(64) }, as(OWNER)))).toBe("SEAL_DEADLINE_PASSED");
    // M2 is therefore still MISSED, and the cancel path ends the round's session
    expect(await refusal(commit(late, lateSession.drawId))).toBe("MEMBER_COMMITMENT_MISSING");
    const { cancellation } = await late.service.cancelDraw({ drawId: lateSession.drawId, reason }, as(TREASURER));
    expect(cancellation.missedMembers).toEqual([M2]);
    // a new session may leave out exactly the member who missed, so the round goes on
    const reopened = (await open(late, lateMade.cycleId, TREASURER, { excludeMissed: true })).session;
    expect(reopened.excluded).toEqual([M2]);

    // Everyone sealed in time and the deadline then passes: commit still works.
    const full = build();
    const fullMade = await cycle(full);
    const fullSession = (await open(full, fullMade.cycleId)).session;
    await seal(full, fullSession.drawId, [OWNER, TREASURER, M1, M2]);
    full.advanceHours(49);
    expect(await refusal(full.service.submitSeal({ drawId: fullSession.drawId, sealed: "e".repeat(64) }, as(M1)))).toBe("SEAL_DEADLINE_PASSED");
    await expect(commit(full, fullSession.drawId)).resolves.toBeDefined();
  });

  it("records who, when, why, the stage, the deadline and who missed; a repeat is a replay; the draw takes nothing more", async () => {
    const built = build();
    const made = await cycle(built);
    const session = (await open(built, made.cycleId)).session;
    await seal(built, session.drawId, [OWNER, M1]);
    built.advanceHours(49);

    const { cancellation, replayed } = await built.service.cancelDraw({ drawId: session.drawId, reason: `  ${reason}  ` }, as(TREASURER));
    expect(replayed).toBe(false);
    expect(cancellation).toMatchObject({
      drawId: session.drawId,
      round: 1,
      stage: "sealing",
      reason,
      cancelledBy: TREASURER,
      ownerDecision: false,
      deadlineAt: session.sealDeadline
    });
    expect([...cancellation.missedMembers].sort()).toEqual([TREASURER, M2].sort());
    expect(Date.parse(cancellation.cancelledAt)).toBe(START.getTime() + 49 * 3_600_000);

    expect((await built.service.cancelDraw({ drawId: session.drawId, reason }, as(OWNER))).replayed).toBe(true);
    expect(await refusal(built.service.submitSeal({ drawId: session.drawId, sealed: "a".repeat(64) }, as(M2)))).toBe("DRAW_CANCELLED");
    expect(await refusal(commit(built, session.drawId))).toBe("DRAW_CANCELLED");
    expect((await built.service.getSession(session.drawId, as(M1))).state).toBe("cancelled");

    // Visible to every member.
    const detail = await built.service.getCycleDetail(made.cycleId, as(M2));
    expect(detail.cancellations).toEqual([cancellation]);
    expect(detail.draws[0]).toMatchObject({ state: "cancelled" });
  });

  it("cannot be shortened: the deadline is the cycle's window, fixed at open", async () => {
    const built = build();
    const made = await cycle(built, { sealWindowHours: 6, nonceWindowHours: 12 });
    const session = (await open(built, made.cycleId)).session;
    expect(Date.parse(session.sealDeadline) - START.getTime()).toBe(6 * 3_600_000);
    expect(await refusal(built.service.createCycle({ groupId: GROUP, name: "x", contributionAmount: "1.00", totalRounds: 1, reserveRatioBps: 0, idempotencyKey: key("c"), sealWindowHours: 0 }, as(TREASURER)))).toBe("INVALID_REQUEST");
    // Nothing in the API moves it: a re-read gives the same instant.
    built.advanceHours(5);
    expect((await built.service.getSession(session.drawId, as(M1))).sealDeadline).toBe(session.sealDeadline);
    expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_TOO_EARLY");
  });

  it("a re-opened round may leave out ONLY the recorded non-responders, visibly, and nobody else", async () => {
    const built = build();
    const made = await cycle(built);
    // Excluding needs a recorded cancel for THIS round: with none there is nobody it could name.
    const untouched = await cycle(built);
    expect(await refusal(open(built, untouched.cycleId, TREASURER, { excludeMissed: true }))).toBe("INVALID_REQUEST");
    const first = (await open(built, made.cycleId)).session;
    await seal(built, first.drawId, [OWNER, TREASURER, M1]);
    built.advanceHours(49);
    await built.service.cancelDraw({ drawId: first.drawId, reason }, as(TREASURER));

    const second = (await open(built, made.cycleId, TREASURER, { excludeMissed: true })).session;
    expect(second.excluded).toEqual([M2]);
    expect([...second.eligible].sort()).toEqual([OWNER, TREASURER, M1].sort());
    expect(second.cancelsThisRound).toBe(1);
    expect(await refusal(built.service.submitSeal({ drawId: second.drawId, sealed: (await secret(second.drawId, M2)).sealed }, as(M2)))).toBe("NOT_ELIGIBLE");

    // Without the flag nobody is left out: the missed member can answer next time.
    const built2 = build();
    const made2 = await cycle(built2);
    const a = (await open(built2, made2.cycleId)).session;
    built2.advanceHours(49);
    await built2.service.cancelDraw({ drawId: a.drawId, reason }, as(TREASURER));
    const b = (await open(built2, made2.cycleId)).session;
    expect(b.excluded).toEqual([]);
    expect(b.eligible).toHaveLength(4);
  });

  it("is limited to two a round for a treasurer; a third needs an owner, and says so", async () => {
    const built = build();
    const made = await cycle(built);
    // Each attempt, one more member goes quiet: M2, then M1; the others keep answering.
    const answering = [[OWNER, TREASURER, M1], [OWNER, TREASURER]];
    for (let attempt = 0; attempt < DRAW_CANCEL_LIMIT; attempt += 1) {
      const session = (await open(built, made.cycleId, TREASURER, { excludeMissed: attempt > 0 })).session;
      await seal(built, session.drawId, answering[attempt]!);
      built.advanceHours(49);
      await built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER));
    }
    // A treasurer can neither open a third session nor cancel one.
    expect(await refusal(open(built, made.cycleId, TREASURER, { excludeMissed: true }))).toBe("CANCEL_LIMIT_REACHED");
    const third = (await open(built, made.cycleId, OWNER, { excludeMissed: true })).session;
    expect(third.cancelsThisRound).toBe(DRAW_CANCEL_LIMIT);
    await seal(built, third.drawId, [OWNER]);
    built.advanceHours(49);
    expect(await refusal(built.service.cancelDraw({ drawId: third.drawId, reason }, as(TREASURER)))).toBe("CANCEL_LIMIT_REACHED");
    const decided = await built.service.cancelDraw({ drawId: third.drawId, reason }, as(OWNER));
    expect(decided.cancellation.ownerDecision).toBe(true);
    expect((await built.service.getCycleDetail(made.cycleId, as(M1))).cancellations.map((entry) => entry.ownerDecision)).toEqual([false, false, true]);
  });

  describe("after the commit", () => {
    async function committed(built: Built) {
      const made = await cycle(built);
      const session = (await open(built, made.cycleId)).session;
      await seal(built, session.drawId, everyone);
      await commit(built, session.drawId);
      return { made, session };
    }

    it("never because of a result: too early, and nothing missed, are both refused", async () => {
      const built = build();
      const { session } = await committed(built);
      await release(built, session.drawId, [OWNER, TREASURER, M1]);
      expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_TOO_EARLY");
      built.advanceHours(49);
      await release(built, session.drawId, [M2]);
      expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_NOTHING_MISSED");
      expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(OWNER)))).toBe("CANCEL_NOTHING_MISSED");
    });

    it("is refused once the reveal is opened, even past the nonce deadline: the draw must be finished", async () => {
      const built = build();
      const { session } = await committed(built);
      await release(built, session.drawId, everyone);
      await built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
      built.advanceHours(49);
      expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER)))).toBe("CANCEL_REVEAL_OPENED");
      expect(await refusal(built.service.cancelDraw({ drawId: session.drawId, reason }, as(OWNER)))).toBe("CANCEL_REVEAL_OPENED");

      // Any manager can finish it, from the published seed, without the opener's device.
      const finished = await built.service.reveal({ drawId: session.drawId }, as(OWNER));
      expect(finished.round.state).toBe("revealed");
      expect(finished.verification.verified).toBe(true);
    });

    it("works with a nonce missing after the nonce deadline, records who missed, and the abandoned commitment stays on record", async () => {
      const built = build();
      const { made, session } = await committed(built);
      await release(built, session.drawId, [OWNER, TREASURER, M1]);
      built.advanceHours(49);
      const { cancellation } = await built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER));
      expect(cancellation).toMatchObject({ stage: "committed", missedMembers: [M2] });

      const again = (await open(built, made.cycleId, TREASURER, { excludeMissed: true })).session;
      await seal(built, again.drawId, [OWNER, TREASURER, M1]);
      await commit(built, again.drawId);
      // The verifier is told an earlier commitment for this round was abandoned.
      expect(await built.repository.countSupersededCommitments(again.drawId, as(M1))).toBe(1);
    });

    it("a cancelled draw cannot be revealed or have its reveal requested", async () => {
      const built = build();
      const { session } = await committed(built);
      built.advanceHours(49);
      await built.service.cancelDraw({ drawId: session.drawId, reason }, as(TREASURER));
      expect(await refusal(built.repository.requestReveal({ drawId: session.drawId, seed: SEED }, as(TREASURER)))).toBe("DRAW_CANCELLED");
      expect(await refusal(built.service.submitNonce({ drawId: session.drawId, nonce: (await secret(session.drawId, M1)).nonce }, as(M1)))).toBe("DRAW_CANCELLED");
    });
  });
});

describe("5. the payout split is the cycle's ratio of the pot, rounded half up", () => {
  const request = (potAmount: string, reserveRatioBps: number, totalRounds = 3, round = 1) => ({
    drawId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    round,
    potAmount,
    reserveRatioBps,
    totalRounds,
    contributionAmount: "1000.00",
    eligibleCount: 4
  });

  it("reserve = ratio x pot, payout = pot - reserve, to the cent", () => {
    for (const [pot, bps, reserve, payout] of [
      ["4000.00", 1000, "400.00", "3600.00"],
      ["100.05", 333, "3.33", "96.72"],
      // Half a cent rounds UP: 1.5 cents -> 2, 4.5 cents -> 5, 1.5 cents -> 2.
      ["0.15", 1000, "0.02", "0.13"],
      ["0.45", 1000, "0.05", "0.40"],
      ["0.05", 3000, "0.02", "0.03"],
      ["12000.00", 3333, "3999.60", "8000.40"],
      ["1000.00", 0, "0.00", "1000.00"]
    ] as const) {
      const plan = planDrawReserve(request(pot, bps));
      const risk = assessDrawRisk(request(pot, bps), plan);
      expect({ reserve: risk.reserveAmount, payout: risk.payoutAmount }, `${pot} @ ${bps}`).toEqual({ reserve, payout });
    }
  });

  it("never rises with a member's exposure: it says the exposure is not covered instead", () => {
    // 4000.00 pot, 1000.00 share, round 1 of 3: one member still owes 2000.00 but the reserve stays 400.00.
    const plan = planDrawReserve(request("4000.00", 1000));
    expect(plan.reserveMinor).toBe(40_000n);
    expect(plan.noteItems).toContainEqual({ code: "exposure_uncovered", exposure: "2000.00", reserve: "400.00" });
    expect(assessDrawRisk(request("4000.00", 1000), plan).reserveAdequate).toBe(false);
    // The last round has no exposure to cover.
    expect(planDrawReserve(request("4000.00", 1000, 3, 3)).noteItems).toContainEqual({ code: "final_round" });
  });
});

describe("6. seed and commitment nonce are required, and 10. the commit time is the database's", () => {
  const body = { drawId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", idempotencyKey: "k1", seed: SEED, commitmentNonce: COMMIT_NONCE };

  it("a commit without a seed or a commitment nonce is refused (the server would make one nobody holds)", () => {
    expect(drawCommitRequestSchema.safeParse(body).success).toBe(true);
    expect(drawCommitRequestSchema.safeParse({ ...body, seed: undefined }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...body, commitmentNonce: undefined }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...body, seed: "short" }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...body, commitmentNonce: SEED, seed: SEED }).success).toBe(false);
  });

  it("a client-supplied committedAt is refused: the commit time is clock_timestamp()", async () => {
    expect(drawCommitRequestSchema.safeParse({ ...body, committedAt: "2020-01-01T00:00:00.000Z" }).success).toBe(false);
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "draw_not_found" } });
    const repository = new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient);
    const built = build();
    const made = await cycle(built);
    const session = (await open(built, made.cycleId)).session;
    await seal(built, session.drawId, everyone);
    const { round } = await commit(built, session.drawId);
    await repository.saveCommitment(round, as(TREASURER)).catch(() => undefined);
    expect(rpc).toHaveBeenCalledWith("commit_draw_from_seals_v1", expect.not.objectContaining({ p_occurred_at: expect.anything() }));
    expect(Object.keys(rpc.mock.calls[0]![1] as object)).not.toContain("p_occurred_at");
  });

  it("the reveal may omit the seed (it is public once opened); the payout takes no time at all", () => {
    expect(drawRevealRequestSchema.safeParse({ drawId: body.drawId, idempotencyKey: "k" }).success).toBe(true);
    const payout = { drawId: body.drawId, cashAccountId: CASH, payoutAccountId: EXPENSE };
    expect(drawPayoutRequestSchema.safeParse(payout).success).toBe(true);
    expect(drawPayoutRequestSchema.safeParse({ ...payout, occurredAt: "2026-10-01T10:00:00.000Z" }).success).toBe(false);
  });
});

describe("7. a payout retry after a partial failure is a replay, not a conflict", () => {
  it("fails savePayout once after the ledger entry is written, then retries later and succeeds", async () => {
    const built = build();
    const { session } = await committedAndReleased(built);
    await built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
    const request = { drawId: session.drawId, cashAccountId: CASH, payoutAccountId: EXPENSE };

    built.repository.failNextPayout = true;
    expect(await refusal(built.service.postPayout(request, as(TREASURER)))).toBe("UNAVAILABLE");
    const after = await built.ledger.getEntries(GROUP, { actorId: TREASURER });
    expect(after).toHaveLength(1);

    // Minutes later the clock has moved. The retry must produce the SAME ledger request.
    built.advanceHours(1);
    const retried = await built.service.postPayout(request, as(TREASURER));
    expect(retried.replayed).toBe(true);
    expect(retried.round.state).toBe("paid");
    expect(await built.ledger.getEntries(GROUP, { actorId: TREASURER })).toHaveLength(1);
    // The ledger entry is dated by the reveal, never by whenever the payout was attempted.
    expect(retried.ledgerEntry!.occurredAt).toBe(retried.round.reveal!.revealedAt);
  });
});
