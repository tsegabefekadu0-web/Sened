import { describe, expect, it } from "vitest";

import { flaggedBefore, parseCycleContributions, previewGate, tallyMember } from "@/lib/draw/contributions";
import { isDrawContributionGate } from "@/lib/draw/types";

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";

type Status = "met" | "flagged" | "not_due";

function cell(round: number, status: Status, source: "treasurer" | "bank_verification" | null = null) {
  return {
    round,
    status,
    entryId: status === "met" ? ENTRY : null,
    source: status === "met" ? (source ?? "treasurer") : null
  };
}

function member(memberId: string, statuses: readonly Status[], extra: Record<string, unknown> = {}) {
  return { memberId, active: true, winRound: null, cells: statuses.map((status, index) => cell(index + 1, status)), ...extra };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 3,
    contributionAmount: "100.00",
    startedAt: T0,
    contributionGate: "block",
    nextRound: 3,
    flaggedCount: 3,
    rounds: [
      { round: 1, dueAt: T0, revealedAt: T0 },
      { round: 2, dueAt: T0, revealedAt: null },
      { round: 3, dueAt: null, revealedAt: null }
    ],
    members: [
      member(A, ["met", "flagged", "not_due"], { winRound: 1 }),
      member(B, ["flagged", "flagged", "not_due"]),
      member(C, ["met", "met", "not_due"])
    ],
    gateEvents: [],
    overrides: [],
    ...overrides
  };
}

describe("parseCycleContributions", () => {
  it("accepts the shape the database returns and lowercases ids", () => {
    const parsed = parseCycleContributions(view({ cycleId: CYCLE.toUpperCase() }));
    expect(parsed).not.toBeNull();
    expect(parsed?.cycleId).toBe(CYCLE);
    expect(parsed?.members).toHaveLength(3);
    expect(parsed?.members[0]?.cells.map((entry) => entry.status)).toEqual(["met", "flagged", "not_due"]);
    expect(parsed?.members[0]?.winRound).toBe(1);
    expect(parsed?.contributionGate).toBe("block");
  });

  it("is not a guess: anything malformed is null", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      view({ contributionGate: "strict" }),
      view({ totalRounds: 0 }),
      view({ contributionAmount: "100" }),
      view({ rounds: [] }),
      view({ rounds: [{ round: 2, dueAt: null, revealedAt: null }, { round: 1 }, { round: 3 }] }),
      view({ members: [member(A, ["met", "flagged"])] }),
      view({ members: [{ ...member(A, ["met", "flagged", "not_due"]), active: "yes" }] }),
      view({ members: [{ ...member(A, ["met", "flagged", "not_due"]), winRound: 9 }] }),
      // a met cell must name its entry and source; the others must name neither
      view({ members: [{ ...member(A, ["met", "met", "met"]), cells: [{ round: 1, status: "met", entryId: null, source: null }, cell(2, "met"), cell(3, "met")] }] }),
      view({ members: [{ ...member(A, ["met", "met", "met"]), cells: [cell(1, "met"), { round: 2, status: "flagged", entryId: ENTRY, source: "treasurer" }, cell(3, "met")] }] }),
      // a partial status does not exist
      view({ members: [{ ...member(A, ["met", "met", "met"]), cells: [cell(1, "met"), { round: 2, status: "partial", entryId: null, source: null }, cell(3, "met")] }] }),
      view({ gateEvents: [{ at: T0, actorId: A, from: "off", to: "nope", reason: "x" }] }),
      view({ overrides: [{ at: T0, actorId: A, round: 2, drawId: DRAW, reason: "r", flagged: [{ memberId: "x", round: 1 }] }] })
    ];
    for (const value of bad) expect(parseCycleContributions(value)).toBeNull();
  });

  it("parses the audit trail", () => {
    const parsed = parseCycleContributions(
      view({
        gateEvents: [{ at: T0, actorId: A, from: "off", to: "block", reason: "Switching it on for everyone" }],
        overrides: [{ at: T0, actorId: B, round: 2, drawId: DRAW, reason: "Members agreed to pay on Friday", flagged: [{ memberId: C, round: 1 }] }]
      })
    );
    expect(parsed?.gateEvents[0]).toMatchObject({ from: "off", to: "block" });
    expect(parsed?.overrides[0]).toMatchObject({ round: 2, flagged: [{ memberId: C, round: 1 }] });
  });
});

describe("flaggedBefore and previewGate", () => {
  const parsed = parseCycleContributions(view());
  if (parsed === null) throw new Error("fixture must parse");

  it("lists the flagged cells of active members strictly before the round, in round then member order", () => {
    expect(flaggedBefore(parsed, 3)).toEqual([
      { memberId: B, round: 1 },
      { memberId: A, round: 2 },
      { memberId: B, round: 2 }
    ]);
    expect(flaggedBefore(parsed, 2)).toEqual([{ memberId: B, round: 1 }]);
    expect(flaggedBefore(parsed, 1)).toEqual([]);
  });

  it("ignores inactive members, exactly as the database does", () => {
    const inactive = parseCycleContributions(
      view({ members: [member(B, ["flagged", "flagged", "not_due"], { active: false }), member(C, ["met", "met", "not_due"])] })
    );
    expect(flaggedBefore(inactive as NonNullable<typeof inactive>, 3)).toEqual([]);
  });

  it("block with something flagged needs an override; warn needs a confirmation; off needs nothing", () => {
    expect(previewGate(parsed)).toMatchObject({ policy: "block", round: 3, needsOverride: true, needsConfirm: false });
    const warn = parseCycleContributions(view({ contributionGate: "warn" }));
    expect(previewGate(warn as NonNullable<typeof warn>)).toMatchObject({ policy: "warn", needsOverride: false, needsConfirm: true });
    const off = parseCycleContributions(view({ contributionGate: "off" }));
    expect(previewGate(off as NonNullable<typeof off>)).toMatchObject({ policy: "off", flagged: [], needsOverride: false, needsConfirm: false });
  });

  it("asks for nothing when everything before the round is met, or the cycle is complete", () => {
    const met = parseCycleContributions(view({ members: [member(A, ["met", "met", "not_due"]), member(B, ["met", "met", "not_due"])] }));
    expect(previewGate(met as NonNullable<typeof met>)).toMatchObject({ flagged: [], needsOverride: false, needsConfirm: false });
    const done = parseCycleContributions(view({ nextRound: null }));
    expect(previewGate(done as NonNullable<typeof done>)).toMatchObject({ round: null, flagged: [], needsOverride: false });
  });

  it("tallies a member's row", () => {
    expect(tallyMember(parsed.members[0]!)).toEqual({ met: 1, flagged: 1, notDue: 1 });
  });
});

describe("the gate vocabulary", () => {
  it("is exactly off, warn and block", () => {
    expect(["off", "warn", "block"].every(isDrawContributionGate)).toBe(true);
    expect(isDrawContributionGate("partial")).toBe(false);
    expect(isDrawContributionGate(undefined)).toBe(false);
  });
});
