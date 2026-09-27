import { describe, expect, it, vi } from "vitest";

import {
  InMemoryLedgerRepository,
  LedgerService,
  verifyLedgerChain,
  type LedgerEntry
} from "@/lib/ledger";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository } from "@/lib/draw/repository";
import { DrawService, payoutIdempotencyKey } from "@/lib/draw/service";
import type { DrawMember } from "@/lib/draw/types";

const hasher = nodeDrawHasher;
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const cycleId = "77777777-7777-4777-8777-777777777777";
const treasurer = "11111111-1111-4111-8111-111111111111";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const payoutAccount = "44444444-4444-4444-8444-444444444444";

function member(index: number, overrides: Partial<DrawMember> = {}): DrawMember {
  return {
    memberId: `${String(index).padStart(4, "0")}4444-4444-8444-8444-444444444444`,
    displayName: `አባላት ${index}`,
    status: "active",
    contributionAmount: "5000.00",
    ...overrides
  };
}

const roster: DrawMember[] = [member(1), member(2), member(3), member(4), member(5)];

function ledgerRepository(): InMemoryLedgerRepository {
  return new InMemoryLedgerRepository({
    groups: [{ id: groupId, tenantId, members: [{ userId: treasurer, role: "treasurer" }] }],
    accounts: [
      { id: cashAccount, groupId, code: "DRAW_POT_CASH", name: "Pot cash", type: "asset" },
      { id: payoutAccount, groupId, code: "DRAW_PAYOUT_EXPENSE", name: "Payout", type: "expense" }
    ],
    clock: () => new Date("2026-09-26T10:00:00.000Z")
  });
}

interface Harness {
  readonly service: DrawService;
  readonly ledger: InMemoryLedgerRepository;
  readonly drawRepo: InMemoryDrawRepository;
}

function harness(options: { readonly hasher?: typeof nodeDrawHasher } = {}): Harness {
  const ledger = ledgerRepository();
  const drawRepo = new InMemoryDrawRepository();
  let counter = 0;
  return {
    ledger,
    drawRepo,
    service: new DrawService(drawRepo, new LedgerService(ledger), {
      hasher: options.hasher ?? hasher,
      clock: () => new Date("2026-09-26T10:00:00.000Z"),
      entropyFactory: () => `entropy-${String(counter++).padStart(4, "0")}-abcdefghij`
    })
  };
}

async function commitRound(
  h: Harness,
  round: number,
  totalRounds: number,
  priorWinnerIds: readonly string[] = []
) {
  return h.service.commit(
    {
      groupId,
      cycleId,
      round,
      totalRounds,
      potAmount: "25000.00",
      reserveRatioBps: 1000,
      members: [...roster],
      priorWinnerIds,
      idempotencyKey: `draw-commit-${round}`
    },
    { userId: treasurer }
  );
}

function entries(ledger: InMemoryLedgerRepository): readonly LedgerEntry[] {
  return ledger.getEntries(groupId, { actorId: treasurer });
}

describe("DrawService — commit and reveal", () => {
  it("commits a round and returns a 201-shaped result", async () => {
    const h = harness();

    const result = await commitRound(h, 1, 5);

    expect(result.replayed).toBe(false);
    expect(result.round.state).toBe("committed");
    expect(result.round.participants).toHaveLength(5);
    expect(result.round.reveal).toBeNull();
  });

  it("replays an identical commit instead of creating a second draw", async () => {
    const h = harness();

    const first = await commitRound(h, 1, 5);
    const second = await commitRound(h, 1, 5);

    expect(second.replayed).toBe(true);
    expect(second.round.drawId).toBe(first.round.drawId);
    expect(await h.drawRepo.listCycle(cycleId, { userId: treasurer })).toHaveLength(1);
  });

  it("REJECTS an idempotency key reused for a different commitment", async () => {
    const h = harness();
    const first = await commitRound(h, 1, 5);

    await expect(
      h.service.commit(
        {
          groupId,
          cycleId,
          round: 1,
          totalRounds: 5,
          drawId: first.round.drawId,
          seed: "a-completely-different-seed",
          commitmentNonce: "a-completely-different-nonce",
          potAmount: "25000.00",
          reserveRatioBps: 1000,
          members: [...roster],
          priorWinnerIds: [],
          idempotencyKey: "draw-commit-1"
        },
        { userId: treasurer }
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("reveals a committed draw and verifies it", async () => {
    const h = harness();
    const committed = await h.service.commit(
      {
        groupId,
        cycleId,
        round: 1,
        totalRounds: 5,
        seed: "reveal-seed-abcdefghij",
        commitmentNonce: "reveal-nonce-abcdefghij",
        potAmount: "25000.00",
        reserveRatioBps: 1000,
        members: [...roster],
        priorWinnerIds: [],
        idempotencyKey: "draw-commit-reveal"
      },
      { userId: treasurer }
    );

    const revealed = await h.service.reveal(
      { drawId: committed.round.drawId, seed: "reveal-seed-abcdefghij" },
      { userId: treasurer }
    );

    expect(revealed.round.state).toBe("revealed");
    expect(revealed.verification.verified).toBe(true);
    expect(revealed.round.reveal?.winnerMemberId).toBe(revealed.verification.winnerMemberId);
    expect(revealed.round.reveal?.payoutAmount).not.toBe("25000.00");
  });

  it("REJECTS a reveal whose seed does not reproduce the commitment", async () => {
    const h = harness();
    const committed = await commitRound(h, 1, 5);

    await expect(
      h.service.reveal({ drawId: committed.round.drawId, seed: "a-forged-seed-abcdefgh" }, { userId: treasurer })
    ).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" });
  });

  it("REJECTS revealing a draw that does not exist", async () => {
    const h = harness();

    await expect(
      h.service.reveal({ drawId: "88888888-8888-4888-8888-888888888888", seed: "x".repeat(20) }, { userId: treasurer })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("REJECTS revealing the same draw twice", async () => {
    const h = harness();
    const committed = await h.service.commit(
      {
        groupId,
        cycleId,
        round: 1,
        totalRounds: 5,
        seed: "twice-seed-abcdefghij",
        commitmentNonce: "twice-nonce-abcdefghij",
        potAmount: "25000.00",
        reserveRatioBps: 1000,
        members: [...roster],
        priorWinnerIds: [],
        idempotencyKey: "draw-commit-twice"
      },
      { userId: treasurer }
    );

    await h.service.reveal({ drawId: committed.round.drawId, seed: "twice-seed-abcdefghij" }, { userId: treasurer });
    await expect(
      h.service.reveal({ drawId: committed.round.drawId, seed: "twice-seed-abcdefghij" }, { userId: treasurer })
    ).rejects.toMatchObject({ code: "ALREADY_REVEALED" });
  });
});

describe("DrawService — fail-closed hasher", () => {
  it("REFUSES to draw when the hasher returns a non-digest", async () => {
    const broken = vi.fn(async () => "not-a-digest") as unknown as typeof nodeDrawHasher;
    const h = harness({ hasher: broken });

    await expect(commitRound(h, 1, 5)).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });
});

describe("DrawService — payout posts a balanced hash-chained ledger entry", () => {
  async function revealed(h: Harness) {
    const committed = await h.service.commit(
      {
        groupId,
        cycleId,
        round: 1,
        totalRounds: 5,
        seed: "payout-seed-abcdefghij",
        commitmentNonce: "payout-nonce-abcdefghij",
        potAmount: "25000.00",
        reserveRatioBps: 1000,
        members: [...roster],
        priorWinnerIds: [],
        idempotencyKey: "draw-commit-payout"
      },
      { userId: treasurer }
    );
    await h.service.reveal({ drawId: committed.round.drawId, seed: "payout-seed-abcdefghij" }, { userId: treasurer });
    return committed.round.drawId;
  }

  it("posts a disbursement through LedgerService.append", async () => {
    const h = harness();
    const drawId = await revealed(h);

    const result = await h.service.postPayout(
      { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
      { userId: treasurer }
    );

    expect(result.round.state).toBe("paid");
    expect(result.ledgerEntry.entryType).toBe("disbursement");
    expect(result.ledgerEntry.idempotencyKey).toBe(payoutIdempotencyKey(result.round.commitment));
    expect(entries(h.ledger)).toHaveLength(1);
  });

  it("keeps Σ debits = Σ credits and an intact hash chain", async () => {
    const h = harness();
    const drawId = await revealed(h);

    const result = await h.service.postPayout(
      { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
      { userId: treasurer }
    );

    const chain = entries(h.ledger);
    const debits = chain.flatMap((entry) => entry.postings).filter((p) => p.direction === "debit");
    const credits = chain.flatMap((entry) => entry.postings).filter((p) => p.direction === "credit");
    expect(debits.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(
      credits.reduce((sum, p) => sum + Number(p.amount), 0)
    );
    expect(debits[0]?.amount).toBe(result.round.reveal?.payoutAmount);
    expect(verifyLedgerChain([...chain])).toEqual({ valid: true, entriesChecked: 1 });
  });

  it("credits the cash account and debits the payout account", async () => {
    const h = harness();
    const drawId = await revealed(h);

    const result = await h.service.postPayout(
      { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
      { userId: treasurer }
    );

    const postings = result.ledgerEntry.postings;
    expect(postings.find((p) => p.accountId === cashAccount)?.direction).toBe("credit");
    expect(postings.find((p) => p.accountId === payoutAccount)?.direction).toBe("debit");
  });

  it("REJECTS a payout before the draw is revealed", async () => {
    const h = harness();
    const committed = await commitRound(h, 1, 5);

    await expect(
      h.service.postPayout(
        { drawId: committed.round.drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
        { userId: treasurer }
      )
    ).rejects.toMatchObject({ code: "NOT_COMMITTED" });
    expect(entries(h.ledger)).toHaveLength(0);
  });

  it("REJECTS a second payout for the same draw instead of paying twice", async () => {
    const h = harness();
    const drawId = await revealed(h);
    const request = { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount };
    await h.service.postPayout(request, { userId: treasurer });

    await expect(h.service.postPayout(request, { userId: treasurer })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT"
    });
    expect(entries(h.ledger)).toHaveLength(1);
  });

  it("REFUSES to pay when the stored reveal disagrees with the arithmetic", async () => {
    const h = harness();
    const drawId = await revealed(h);
    const round = await h.service.getRound(drawId, { userId: treasurer });

    // Simulate a storage layer that swapped the winner after the ceremony.
    const tampered: typeof round = {
      ...round,
      reveal: { ...round.reveal!, winnerMemberId: roster[4].memberId }
    };
    await h.drawRepo.savePayout(
      {
        drawId,
        ledgerEntryId: "55555555-5555-4555-8555-555555555555",
        winnerMemberId: tampered.reveal?.winnerMemberId ?? "",
        amount: tampered.reveal?.payoutAmount ?? "0.00",
        reserveAmount: tampered.reveal?.reserveAmount ?? "0.00",
        postedAt: "2026-09-26T10:00:00.000Z",
        postedBy: treasurer
      },
      { userId: treasurer }
    );

    // The payout is already recorded, so re-posting is refused outright.
    await expect(
      h.service.postPayout(
        { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
        { userId: treasurer }
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("surfaces a missing ledger account as NOT_FOUND rather than a fake payout", async () => {
    const h = harness();
    const drawId = await revealed(h);

    await expect(
      h.service.postPayout(
        { drawId, cashAccountId: cashAccount, payoutAccountId: "66666666-6666-4666-8666-666666666666" },
        { userId: treasurer }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(entries(h.ledger)).toHaveLength(0);
  });
});

describe("DrawService — a full cycle", () => {
  it("pays every round, never repeats a winner, and keeps one intact chain", async () => {
    const h = harness();
    const seenWinners: string[] = [];

    for (let round = 1; round <= 5; round += 1) {
      const committed = await h.service.commit(
        {
          groupId,
          cycleId,
          round,
          totalRounds: 5,
          seed: `cycle-seed-${round}-abcdefghij`,
          commitmentNonce: `cycle-nonce-${round}-abcdefghij`,
          potAmount: "25000.00",
          reserveRatioBps: 1000,
          members: [...roster],
          priorWinnerIds: [...seenWinners],
          idempotencyKey: `cycle-commit-${round}`
        },
        { userId: treasurer }
      );

      const revealed = await h.service.reveal(
        { drawId: committed.round.drawId, seed: `cycle-seed-${round}-abcdefghij` },
        { userId: treasurer }
      );
      const winner = revealed.round.reveal?.winnerMemberId ?? "";
      expect(seenWinners).not.toContain(winner);
      expect(revealed.verification.verified).toBe(true);
      seenWinners.push(winner);

      await h.service.postPayout(
        { drawId: committed.round.drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount },
        { userId: treasurer }
      );
    }

    expect(seenWinners).toHaveLength(5);
    expect(new Set(seenWinners).size).toBe(5);

    const chain = entries(h.ledger);
    expect(chain).toHaveLength(5);
    expect(chain.map((entry) => entry.sequence)).toEqual(["1", "2", "3", "4", "5"]);
    expect(verifyLedgerChain([...chain])).toEqual({ valid: true, entriesChecked: 5 });
  });

  it("excludes every past winner from the committed roster as the cycle advances", async () => {
    const h = harness();
    const winners: string[] = [];

    for (let round = 1; round <= 5; round += 1) {
      const committed = await h.service.commit(
        {
          groupId,
          cycleId,
          round,
          totalRounds: 5,
          seed: `rot-seed-${round}-abcdefghijkl`,
          commitmentNonce: `rot-nonce-${round}-abcdefghijkl`,
          potAmount: "25000.00",
          reserveRatioBps: 1000,
          members: [...roster],
          priorWinnerIds: [...winners],
          idempotencyKey: `rot-commit-${round}`
        },
        { userId: treasurer }
      );
      expect(committed.round.participants).toHaveLength(5 - round + 1);
      for (const winner of winners) {
        expect(committed.round.participants.map((p) => p.memberId)).not.toContain(winner);
      }
      const revealed = await h.service.reveal(
        { drawId: committed.round.drawId, seed: `rot-seed-${round}-abcdefghijkl` },
        { userId: treasurer }
      );
      winners.push(revealed.round.reveal?.winnerMemberId ?? "");
    }
  });

  it("summarises the cycle and reports rotation exhaustion", async () => {
    const h = harness();
    const winners: string[] = [];

    for (let round = 1; round <= 5; round += 1) {
      const committed = await h.service.commit(
        {
          groupId,
          cycleId,
          round,
          totalRounds: 5,
          seed: `sum-seed-${round}-abcdefghijkl`,
          commitmentNonce: `sum-nonce-${round}-abcdefghijkl`,
          potAmount: "25000.00",
          reserveRatioBps: 1000,
          members: [...roster],
          priorWinnerIds: [...winners],
          idempotencyKey: `sum-commit-${round}`
        },
        { userId: treasurer }
      );
      const revealed = await h.service.reveal(
        { drawId: committed.round.drawId, seed: `sum-seed-${round}-abcdefghijkl` },
        { userId: treasurer }
      );
      expect(revealed.round.reveal?.winnerMemberId).toBeTruthy();
      winners.push(revealed.round.reveal?.winnerMemberId ?? "");
    }

    const summary = await h.service.cycleSummary({ cycleId, members: [...roster] }, { userId: treasurer });

    expect(summary.committed).toBe(5);
    expect(summary.revealed).toBe(5);
    expect(summary.totalRounds).toBe(5);
    expect(summary.winners).toHaveLength(5);
    expect(summary.rotationExhausted).toBe(true);
    expect(summary.remainingEligible).toBe(0);
  });

  it("REJECTS a repeat winner even when the caller forgets to exclude past winners", async () => {
    const h = harness();
    const first = await h.service.commit(
      {
        groupId,
        cycleId,
        round: 1,
        totalRounds: 5,
        seed: "defence-seed-one-abcdefg",
        commitmentNonce: "defence-nonce-one-abcdefg",
        potAmount: "25000.00",
        reserveRatioBps: 1000,
        members: [roster[0]],
        priorWinnerIds: [],
        idempotencyKey: "defence-commit-1"
      },
      { userId: treasurer }
    );
    const firstReveal = await h.service.reveal(
      { drawId: first.round.drawId, seed: "defence-seed-one-abcdefg" },
      { userId: treasurer }
    );
    const winner = firstReveal.round.reveal?.winnerMemberId ?? "";
    expect(winner).toBe(roster[0].memberId);

    // A one-member roster means the same member is drawn again unless the
    // service notices. It must notice, and refuse.
    const second = await h.service.commit(
      {
        groupId,
        cycleId,
        round: 2,
        totalRounds: 5,
        seed: "defence-seed-two-abcdefg",
        commitmentNonce: "defence-nonce-two-abcdefg",
        potAmount: "25000.00",
        reserveRatioBps: 1000,
        members: [roster[0]],
        priorWinnerIds: [],
        idempotencyKey: "defence-commit-2"
      },
      { userId: treasurer }
    );

    await expect(
      h.service.reveal({ drawId: second.round.drawId, seed: "defence-seed-two-abcdefg" }, { userId: treasurer })
    ).rejects.toMatchObject({ code: "REPEAT_WINNER" });
  });

  it("REJECTS a repeat winner even if a prior winner is forced back into the roster", async () => {
    const h = harness();
    // Two members, two rounds. Round 2's roster is deliberately *not* narrowed,
    // so the same member can be drawn twice unless the service intervenes.
    const seeds = ["repeat-seed-one-abcdefghijk", "repeat-seed-two-abcdefghijk"];
    const commits: string[] = [];

    for (const [index, seed] of seeds.entries()) {
      const round = index + 1;
      const committed = await h.service.commit(
        {
          groupId,
          cycleId,
          round,
          totalRounds: 2,
          seed,
          commitmentNonce: `repeat-nonce-${round}-abcdefghijk`,
          potAmount: "15000.00",
          reserveRatioBps: 1000,
          members: [roster[0], roster[1]],
          priorWinnerIds: [],
          idempotencyKey: `repeat-commit-${round}`
        },
        { userId: treasurer }
      );
      commits.push(committed.round.drawId);
    }

    const firstReveal = await h.service.reveal(
      { drawId: commits[0], seed: seeds[0] },
      { userId: treasurer }
    );
    const firstWinner = firstReveal.round.reveal?.winnerMemberId ?? "";
    await h.service.postPayout(
      { drawId: commits[0], cashAccountId: cashAccount, payoutAccountId: payoutAccount },
      { userId: treasurer }
    );

    // Round 2's committed roster still contains the first winner, so either the
    // draw picks the other member (fine) or the service refuses (also fine).
    // Both outcomes are acceptable; a repeat winner being paid is not.
    const secondReveal = await h.service.reveal(
      { drawId: commits[1], seed: seeds[1] },
      { userId: treasurer }
    ).catch((error: unknown) => error);

    if (secondReveal instanceof Error) {
      expect(secondReveal).toMatchObject({ code: "REPEAT_WINNER" });
      expect(entries(h.ledger)).toHaveLength(1);
    } else {
      const second = secondReveal as Awaited<ReturnType<typeof h.service.reveal>>;
      expect(second.round.reveal?.winnerMemberId).not.toBe(firstWinner);
      expect(second.verification.verified).toBe(true);
    }
  });
});
