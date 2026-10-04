import { describe, expect, it } from "vitest";

import {
  parseCycleCollateral,
  parseGuarantee,
  planNextReserve,
  summarizeCollateral,
  type CycleCollateral
} from "@/lib/draw/collateral";
import { planReserve } from "@/lib/draw/risk";

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-10-10T09:00:00.000Z";

function guarantee(overrides: Record<string, unknown> = {}) {
  return {
    guaranteeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    cycleId: CYCLE,
    winnerMemberId: A,
    guarantorMemberId: B,
    proposedBy: C,
    proposedAt: T0,
    state: "proposed",
    stateAt: T0,
    stateBy: C,
    acceptedAt: null,
    reason: null,
    successorGuaranteeId: null,
    ...overrides
  };
}

function wire(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 4,
    contributionAmount: "100.00",
    potAmount: "500.00",
    reserveRatioBps: 1000,
    startedAt: T0,
    nextRound: 3,
    eligibleCount: 3,
    reserveRetained: "100.00",
    flaggedCount: 1,
    winners: [
      {
        memberId: A,
        round: 1,
        revealedAt: T0,
        owed: [
          { round: 2, status: "met", dueAt: T0, entryId: ENTRY, source: "treasurer" },
          { round: 3, status: "flagged", dueAt: T0, entryId: null, source: null },
          { round: 4, status: "not_due", dueAt: null, entryId: null, source: null }
        ],
        guarantees: [guarantee(), guarantee({ guaranteeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", guarantorMemberId: C, state: "accepted", acceptedAt: T0 })]
      },
      { memberId: B, round: 2, revealedAt: T0, owed: [{ round: 3, status: "not_due", dueAt: null, entryId: null, source: null }, { round: 4, status: "not_due", dueAt: null, entryId: null, source: null }], guarantees: [] }
    ],
    ...overrides
  };
}

function parsed(overrides: Record<string, unknown> = {}): CycleCollateral {
  const view = parseCycleCollateral(wire(overrides));
  if (view === null) throw new Error("fixture did not parse");
  return view;
}

describe("parseCycleCollateral", () => {
  it("accepts the database's view and keeps every field", () => {
    const view = parsed();
    expect(view.winners).toHaveLength(2);
    expect(view.winners[0]!.owed.map((round) => round.status)).toEqual(["met", "flagged", "not_due"]);
    expect(view.winners[0]!.owed[0]).toMatchObject({ entryId: ENTRY, source: "treasurer" });
    expect(view.reserveRetained).toBe("100.00");
  });

  it("allows a cycle with no contribution on record and a finished cycle", () => {
    expect(parseCycleCollateral(wire({ contributionAmount: null }))?.contributionAmount).toBeNull();
    expect(parseCycleCollateral(wire({ nextRound: null, eligibleCount: null }))).not.toBeNull();
  });

  it("allows a prepaid round (met although no draw is open) but not a flag without a due time", () => {
    const owed = (row: Record<string, unknown>) =>
      wire({ winners: [{ memberId: A, round: 1, revealedAt: T0, owed: [row], guarantees: [] }] });
    expect(parseCycleCollateral(owed({ round: 4, status: "met", dueAt: null, entryId: ENTRY, source: "bank_verification" }))).not.toBeNull();
    expect(parseCycleCollateral(owed({ round: 2, status: "flagged", dueAt: null, entryId: null, source: null }))).toBeNull();
    expect(parseCycleCollateral(owed({ round: 2, status: "not_due", dueAt: T0, entryId: null, source: null }))).toBeNull();
    // A met round must name its entry and source; the others must name neither.
    expect(parseCycleCollateral(owed({ round: 2, status: "met", dueAt: T0, entryId: null, source: null }))).toBeNull();
    expect(parseCycleCollateral(owed({ round: 2, status: "flagged", dueAt: T0, entryId: ENTRY, source: "treasurer" }))).toBeNull();
  });

  it("refuses anything malformed instead of guessing", () => {
    for (const bad of [
      wire({ cycleId: "nope" }),
      wire({ totalRounds: 0 }),
      wire({ contributionAmount: "100" }),
      wire({ potAmount: 500 }),
      wire({ reserveRetained: "-1.00" }),
      wire({ flaggedCount: -1 }),
      wire({ startedAt: "not a time" }),
      wire({ winners: "none" }),
      wire({ winners: [{ memberId: "nope", round: 1, revealedAt: T0, owed: [], guarantees: [] }] }),
      wire({ winners: [{ memberId: A, round: 1, revealedAt: T0, owed: [{ round: 2, status: "paid", dueAt: null, entryId: null, source: null }], guarantees: [] }] }),
      wire({ winners: [{ memberId: A, round: 1, revealedAt: T0, owed: [], guarantees: [guarantee({ state: "approved" })] }] }),
      null,
      [],
      "x"
    ]) {
      expect(parseCycleCollateral(bad)).toBeNull();
    }
  });

  it("drops fields it was not told about", () => {
    const view = parseCycleCollateral({ ...wire(), leaked: "yes" }) as unknown as Record<string, unknown>;
    expect(view.leaked).toBeUndefined();
  });
});

describe("parseGuarantee", () => {
  it("accepts each state and refuses an unknown one", () => {
    for (const state of ["proposed", "accepted", "declined", "released", "superseded"]) {
      expect(parseGuarantee(guarantee({ state }))?.state).toBe(state);
    }
    expect(parseGuarantee(guarantee({ state: "approved" }))).toBeNull();
    expect(parseGuarantee(guarantee({ guarantorMemberId: "nope" }))).toBeNull();
    expect(parseGuarantee(guarantee({ acceptedAt: "bad" }))).toBeNull();
  });
});

describe("summarizeCollateral", () => {
  it("derives each winner's rounds and exposure in exact minor units", () => {
    const summary = summarizeCollateral(parsed());
    const a = summary.winners.find((winner) => winner.memberId === A)!;
    expect(a).toMatchObject({
      winRound: 1,
      roundsOwed: 3,
      roundsMet: 1,
      roundsFlagged: 1,
      roundsNotDue: 1,
      // Unmet = flagged + not yet due: 2 x 100.00. Overdue = flagged only.
      outstanding: "200.00",
      overdue: "100.00",
      acceptedGuarantors: 1,
      pendingGuarantors: 1
    });
    const b = summary.winners.find((winner) => winner.memberId === B)!;
    expect(b).toMatchObject({ roundsOwed: 2, roundsFlagged: 0, outstanding: "200.00", overdue: "0.00", acceptedGuarantors: 0 });
    expect(summary.totalOutstanding).toBe("400.00");
    expect(summary.totalOverdue).toBe("100.00");
    expect(summary.flaggedCount).toBe(1);
  });

  it("compares the retained reserve with what is overdue", () => {
    expect(summarizeCollateral(parsed({ reserveRetained: "100.00" })).reserveCoversOverdue).toBe(true);
    expect(summarizeCollateral(parsed({ reserveRetained: "99.99" })).reserveCoversOverdue).toBe(false);
  });

  it("invents no amount when the cycle has no contribution on record", () => {
    const summary = summarizeCollateral(parsed({ contributionAmount: null }));
    expect(summary.totalOutstanding).toBeNull();
    expect(summary.totalOverdue).toBeNull();
    expect(summary.reserveCoversOverdue).toBeNull();
    expect(summary.winners.every((winner) => winner.outstanding === null && winner.overdue === null)).toBe(true);
    // The counts are still true.
    expect(summary.winners[0]).toMatchObject({ roundsFlagged: 1 });
  });

  it("is empty before anyone has won", () => {
    const summary = summarizeCollateral(parsed({ winners: [], flaggedCount: 0 }));
    expect(summary).toMatchObject({ winners: [], totalOutstanding: "0.00", totalOverdue: "0.00" });
  });
});

describe("planNextReserve", () => {
  it("is the existing reserve heuristic, planned for the next round with the roster that remains", () => {
    const view = parsed();
    const plan = planNextReserve(view)!;
    const direct = planReserve({
      drawId: CYCLE,
      round: 3,
      potAmount: "500.00",
      reserveRatioBps: 1000,
      totalRounds: 4,
      contributionAmount: "100.00",
      eligibleCount: 3
    });
    expect(plan.reserveMinor).toBe(direct.reserveMinor);
    expect(plan.payoutMinor).toBe(direct.payoutMinor);
  });

  it("is null, never invented, when the cycle is complete or lacks a figure", () => {
    expect(planNextReserve(parsed({ nextRound: null, eligibleCount: null }))).toBeNull();
    expect(planNextReserve(parsed({ contributionAmount: null }))).toBeNull();
    expect(planNextReserve(parsed({ eligibleCount: 0 }))).toBeNull();
  });
});
