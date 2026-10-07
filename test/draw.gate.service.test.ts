import { describe, expect, it } from "vitest";

import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";
import { sealMemberContribution } from "@/lib/draw/engine";
import { isDrawError } from "@/lib/draw/errors";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository } from "@/lib/draw/repository";
import { DrawService } from "@/lib/draw/service";
import type { DrawContributionGate, DrawGateFlag } from "@/lib/draw/types";

/**
 * The contribution gate against the in-memory double of the SQL (`open_draw_v1` in
 * `20261011100000_contribution_grid_and_gate.sql`; the SQL itself, including the real
 * derivation of which rounds are flagged, is proven by `scripts/verify-migrations.sql`).
 */

const hasher = nodeDrawHasher;
const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const OWNER = "11111111-1111-4111-8111-111111111111";
const TREASURER = "11111111-1111-4111-8111-1111111111ee";
const M1 = "33333333-3333-4333-8333-333333333333";
const M2 = "55555555-5555-4555-8555-555555555555";
const OUTSIDER = "66666666-6666-4666-8666-666666666666";
const SEED = "treasurer-seed-0123456789-xyz";
const REASON = "Members agreed to pay on Friday";

const as = (userId: string) => ({ userId });
let sequence = 0;
const key = (label: string) => `${label}.${(sequence += 1)}`;

function build(flags: { current: readonly DrawGateFlag[] }) {
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
    clock: () => new Date("2026-10-01T10:00:00.000Z"),
    contributionFlags: (_cycleId, beforeRound) => flags.current.filter((flag) => flag.round < beforeRound)
  });
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [],
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  const service = new DrawService(repository, new LedgerService(ledger), { hasher, clock: () => new Date("2026-10-01T10:00:00.000Z") });
  return { repository, service };
}

type Built = ReturnType<typeof build>;

async function cycle(built: Built, gate?: DrawContributionGate) {
  return (
    await built.service.createCycle(
      {
        groupId: GROUP,
        name: "Cycle",
        contributionAmount: "1000.00",
        totalRounds: 3,
        reserveRatioBps: 1000,
        idempotencyKey: key("cyc"),
        ...(gate === undefined ? {} : { contributionGate: gate })
      },
      as(TREASURER)
    )
  ).cycle;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isDrawError(error)) return error.code;
    throw error;
  }
  return "none";
}

/** Run round `round` of the cycle to its reveal. */
async function drawRound(built: Built, cycleId: string, extra: { overrideReason?: string } = {}) {
  const opened = await built.service.openDraw({ cycleId, idempotencyKey: key("open"), ...extra }, as(TREASURER));
  const session = opened.session;
  const secrets = new Map<string, string>();
  for (const id of session.eligible.filter((entry) => entry !== TREASURER).slice(0, 2)) {
    const nonce = `nonce-${id.slice(0, 8)}-${session.drawId.slice(0, 8)}-0123456789`;
    const sealed = (await sealMemberContribution({ drawId: session.drawId, memberId: id, nonce }, hasher)).sealed;
    await built.service.submitSeal({ drawId: session.drawId, sealed }, as(id));
    secrets.set(id, nonce);
  }
  await built.service.commitFromSession(
    { drawId: session.drawId, seed: SEED, commitmentNonce: "treasurer-commit-nonce-0123456789", idempotencyKey: `commit.${session.drawId}` },
    as(TREASURER)
  );
  for (const [id, nonce] of secrets) await built.service.submitNonce({ drawId: session.drawId, nonce }, as(id));
  await built.service.reveal({ drawId: session.drawId, seed: SEED }, as(TREASURER));
  return opened;
}

describe("the policy is chosen at creation and defaults to off", () => {
  it("a cycle with no stated policy is off; a stated one is kept", async () => {
    const built = build({ current: [] });
    expect((await cycle(built)).contributionGate).toBe("off");
    expect((await cycle(built, "warn")).contributionGate).toBe("warn");
    expect((await cycle(built, "block")).contributionGate).toBe("block");
  });

  it("is listed with the cycle and with every draw's cycle", async () => {
    const built = build({ current: [] });
    const made = await cycle(built, "block");
    expect((await built.service.listCycles(GROUP, as(M1)))[0]?.contributionGate).toBe("block");
    expect((await built.service.getCycleDetail(made.cycleId, as(M1))).cycle.contributionGate).toBe("block");
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(opened.session.cycle.contributionGate).toBe("block");
  });
});

describe("opening a draw under each policy", () => {
  const flagged = (memberId: string, round: number): DrawGateFlag => ({ memberId, round });

  it("off never looks, however much is flagged", async () => {
    const built = build({ current: [flagged(M1, 1), flagged(M2, 1)] });
    const made = await cycle(built, "off");
    await drawRound(built, made.cycleId);
    const second = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(second.gate).toEqual({ policy: "off", flagged: [], overridden: false });
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("warn allows it and reports what is flagged; nothing is recorded as an override", async () => {
    const built = build({ current: [flagged(M1, 1)] });
    const made = await cycle(built, "warn");
    await drawRound(built, made.cycleId);
    const second = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(second.replayed).toBe(false);
    expect(second.gate).toEqual({ policy: "warn", flagged: [flagged(M1, 1)], overridden: false });
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("block refuses while a member has a flagged round before this one, naming who and which", async () => {
    const built = build({ current: [flagged(M1, 1), flagged(M2, 1)] });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    const refused = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER)).catch((error: unknown) => error);
    expect(isDrawError(refused) && refused.code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect(isDrawError(refused) && refused.flagged).toEqual([flagged(M1, 1), flagged(M2, 1)]);
    // No draw was opened by the refusal.
    expect((await built.service.getCycleDetail(made.cycleId, as(OWNER))).draws).toHaveLength(1);
  });

  it("block does not hold round 1: nothing is before it", async () => {
    const built = build({ current: [flagged(M1, 1)] });
    const made = await cycle(built, "block");
    const first = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(first.gate).toEqual({ policy: "block", flagged: [], overridden: false });
  });

  it("block lets nothing through once every earlier round is met", async () => {
    const flags = { current: [flagged(M1, 1)] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    expect(await code(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER)))).toBe("CONTRIBUTION_GATE_BLOCKED");
    flags.current = [];
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(opened.gate).toEqual({ policy: "block", flagged: [], overridden: false });
  });
});

describe("an override", () => {
  const flags = [
    { memberId: M1, round: 1 },
    { memberId: M2, round: 1 }
  ];

  it("opens the draw and is recorded with who, the reason (trimmed) and exactly which rounds", async () => {
    const built = build({ current: flags });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: `  ${REASON}  ` }, as(TREASURER));
    expect(opened.gate).toEqual({ policy: "block", flagged: flags, overridden: true });
    expect(built.repository.gateOverrides()).toEqual([
      { cycleId: made.cycleId, round: 2, drawId: opened.session.drawId, actorId: TREASURER, reason: REASON, flagged: flags, stage: "open" }
    ]);
  });

  it("needs a real reason: under 10 characters, blank or over 1000 is refused, and nothing is recorded", async () => {
    const built = build({ current: flags });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    for (const overrideReason of ["too short", "          ", "x".repeat(1001)]) {
      expect(await code(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason }, as(OWNER)))).toBe("INVALID_REQUEST");
    }
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("needs the role: a plain member or an outsider is refused before the reason is considered", async () => {
    const built = build({ current: flags });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    for (const who of [M1, OUTSIDER]) {
      expect(await code(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(who)))).toBe("FORBIDDEN");
    }
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("is not recorded when it is not needed (off, warn, nothing flagged)", async () => {
    for (const gate of ["off", "warn"] as const) {
      const built = build({ current: flags });
      const made = await cycle(built, gate);
      await drawRound(built, made.cycleId);
      await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(OWNER));
      expect(built.repository.gateOverrides()).toEqual([]);
    }
    const built = build({ current: [] });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(OWNER));
    expect(opened.gate?.overridden).toBe(false);
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("is recorded once: a replay and a continuation of the open draw do not record again", async () => {
    const built = build({ current: flags });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    const idempotencyKey = key("open");
    const first = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey, overrideReason: REASON }, as(OWNER));
    const replay = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey, overrideReason: REASON }, as(OWNER));
    const continued = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(OWNER));
    expect(replay).toMatchObject({ replayed: true, gate: null });
    expect(continued).toMatchObject({ replayed: true, gate: null });
    expect(continued.session.drawId).toBe(first.session.drawId);
    expect(built.repository.gateOverrides()).toHaveLength(1);
  });

  it("the recorded list is a copy: editing it changes nothing (append-only)", async () => {
    const built = build({ current: flags });
    const made = await cycle(built, "block");
    await drawRound(built, made.cycleId);
    await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(OWNER));
    (built.repository.gateOverrides() as unknown[]).length = 0;
    expect(built.repository.gateOverrides()).toHaveLength(1);
  });
});

describe("changing the policy", () => {
  it("an owner or treasurer changes it with a reason; it is audited and takes effect on the next open", async () => {
    const built = build({ current: [{ memberId: M1, round: 1 }] });
    const made = await cycle(built, "off");
    await drawRound(built, made.cycleId);

    const changed = await built.service.setContributionGate({ cycleId: made.cycleId, gate: "block", reason: `  ${REASON} ` }, as(TREASURER));
    expect(changed).toMatchObject({ replayed: false, cycle: { contributionGate: "block" } });
    expect(built.repository.gateEvents()).toEqual([{ cycleId: made.cycleId, from: "off", to: "block", actorId: TREASURER, reason: REASON }]);
    expect(await code(built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER)))).toBe("CONTRIBUTION_GATE_BLOCKED");

    await built.service.setContributionGate({ cycleId: made.cycleId, gate: "warn", reason: "The group decided to relax this" }, as(OWNER));
    expect(built.repository.gateEvents().map((event) => `${event.from}>${event.to}`)).toEqual(["off>block", "block>warn"]);
    expect((await built.service.getCycleDetail(made.cycleId, as(M1))).cycle.contributionGate).toBe("warn");
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(OWNER));
    expect(opened.gate?.policy).toBe("warn");
  });

  it("the policy already in force is a replay and records nothing", async () => {
    const built = build({ current: [] });
    const made = await cycle(built, "warn");
    const again = await built.service.setContributionGate({ cycleId: made.cycleId, gate: "warn", reason: REASON }, as(OWNER));
    expect(again.replayed).toBe(true);
    expect(built.repository.gateEvents()).toEqual([]);
  });

  it("needs the role and a reason; a plain member, an outsider, a short reason and an unknown cycle are refused", async () => {
    const built = build({ current: [] });
    const made = await cycle(built, "off");
    expect(await code(built.service.setContributionGate({ cycleId: made.cycleId, gate: "block", reason: REASON }, as(M1)))).toBe("FORBIDDEN");
    expect(await code(built.service.setContributionGate({ cycleId: made.cycleId, gate: "block", reason: REASON }, as(OUTSIDER)))).toBe("FORBIDDEN");
    expect(await code(built.service.setContributionGate({ cycleId: "77777777-7777-4777-8777-777777777777", gate: "block", reason: REASON }, as(OWNER)))).toBe("FORBIDDEN");
    expect(await code(built.service.setContributionGate({ cycleId: made.cycleId, gate: "block", reason: "short" }, as(OWNER)))).toBe("INVALID_REQUEST");
    expect(await code(built.service.setContributionGate({ cycleId: made.cycleId, gate: "nope" as DrawContributionGate, reason: REASON }, as(OWNER)))).toBe("INVALID_REQUEST");
    expect(built.repository.gateEvents()).toEqual([]);
    expect((await built.service.getCycleDetail(made.cycleId, as(OWNER))).cycle.contributionGate).toBe("off");
  });
});
