import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc
  }))
}));

import { sealMemberContribution } from "@/lib/draw/engine";
import { DrawError, isDrawError } from "@/lib/draw/errors";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository, SupabaseDrawRepository, drawErrorStatus } from "@/lib/draw/repository";
import { createCommitHandler } from "@/lib/draw/routeHandlers";
import { drawCommitRequestSchema } from "@/lib/draw/schemas";
import { DrawService } from "@/lib/draw/service";
import { parseCycleContributions, previewCommitGate } from "@/lib/draw/contributions";
import type { DrawCommitment, DrawContributionGate, DrawGateFlag } from "@/lib/draw/types";
import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";

/**
 * The contribution gate at COMMIT (`commit_draw_from_seals_v1` in
 * `20261013100000_post_win_fill_and_commit_gate.sql`), against the in-memory double of the SQL.
 * The SQL itself (the real derivation of the flagged pairs, the override table, the roles) is
 * proven by `scripts/verify-migrations.sql`.
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
const NONCE = "treasurer-commit-nonce-0123456789";
const REASON = "Members agreed to pay on Friday";
const NOW = "2026-10-10T09:00:00.000Z";

const as = (userId: string) => ({ userId });
let sequence = 0;
const key = (label: string) => `${label}.${(sequence += 1)}`;
const flag = (memberId: string, round: number): DrawGateFlag => ({ memberId, round });

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
    clock: () => new Date(NOW),
    contributionFlags: (_cycleId, beforeRound) => flags.current.filter((entry) => entry.round < beforeRound)
  });
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [],
    clock: () => new Date(NOW)
  });
  const service = new DrawService(repository, new LedgerService(ledger), { hasher, clock: () => new Date(NOW) });
  return { repository, service };
}
type Built = ReturnType<typeof build>;

async function cycle(built: Built, gate: DrawContributionGate) {
  return (
    await built.service.createCycle(
      {
        groupId: GROUP,
        name: "Cycle",
        contributionAmount: "1000.00",
        totalRounds: 3,
        reserveRatioBps: 1000,
        idempotencyKey: key("cyc"),
        contributionGate: gate
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

async function sealTwo(built: Built, drawId: string, eligible: readonly string[]) {
  const secrets = new Map<string, string>();
  for (const id of eligible.filter((entry) => entry !== TREASURER).slice(0, 2)) {
    const nonce = `nonce-${id.slice(0, 8)}-${drawId.slice(0, 8)}-0123456789`;
    const sealed = (await sealMemberContribution({ drawId, memberId: id, nonce }, hasher)).sealed;
    await built.service.submitSeal({ drawId, sealed }, as(id));
    secrets.set(id, nonce);
  }
  return secrets;
}

/** Round 1 run to its reveal (nothing is flagged before round 1). */
async function drawRoundOne(built: Built, cycleId: string) {
  const opened = await built.service.openDraw({ cycleId, idempotencyKey: key("open") }, as(TREASURER));
  const secrets = await sealTwo(built, opened.session.drawId, opened.session.eligible);
  await built.service.commitFromSession(
    { drawId: opened.session.drawId, seed: SEED, commitmentNonce: NONCE, idempotencyKey: `commit.${opened.session.drawId}` },
    as(TREASURER)
  );
  for (const [id, nonce] of secrets) await built.service.submitNonce({ drawId: opened.session.drawId, nonce }, as(id));
  await built.service.reveal({ drawId: opened.session.drawId, seed: SEED }, as(TREASURER));
}

/** Round 2 opened (with `openOverride` if the gate asked) and sealed, ready to commit. */
async function roundTwoSealed(built: Built, cycleId: string, openOverride?: string) {
  await drawRoundOne(built, cycleId);
  const opened = await built.service.openDraw(
    { cycleId, idempotencyKey: key("open"), ...(openOverride === undefined ? {} : { overrideReason: openOverride }) },
    as(TREASURER)
  );
  await sealTwo(built, opened.session.drawId, opened.session.eligible);
  return opened.session;
}

function commit(built: Built, drawId: string, extra: { overrideReason?: string; idempotencyKey?: string } = {}, who = TREASURER) {
  return built.service.commitFromSession(
    { drawId, seed: SEED, commitmentNonce: NONCE, idempotencyKey: extra.idempotencyKey ?? `commit.${drawId}`, ...(extra.overrideReason === undefined ? {} : { overrideReason: extra.overrideReason }) },
    as(who)
  );
}

describe("a flag that appears AFTER the draw was opened (block)", () => {
  it("refuses the commit with who is flagged for which round, and leaves the sealed seals valid", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    const sealsBefore = (await built.service.getSession(session.drawId, as(M1))).seals;
    expect(sealsBefore).toHaveLength(2);

    flags.current = [flag(M1, 1)];
    const error = await commit(built, session.drawId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DrawError);
    expect((error as DrawError).code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect((error as DrawError).flagged).toEqual([flag(M1, 1)]);
    expect(drawErrorStatus("CONTRIBUTION_GATE_BLOCKED")).toBe(409);

    // Nothing was written: still sealing, same seals, no override.
    const after = await built.service.getSession(session.drawId, as(M1));
    expect(after.state).toBe("sealing");
    expect(after.seals).toEqual(sealsBefore);
    expect(built.repository.gateOverrides()).toEqual([]);

    // The treasurer resolves the flag (the payment is recorded) and commits with no override.
    flags.current = [];
    const done = await commit(built, session.drawId);
    expect(done.replayed).toBe(false);
    expect(done.gate).toEqual({ policy: "block", flagged: [], overridden: false, carriedOver: false });
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("or the treasurer overrides at commit, and the override is recorded with the stage, the reason (trimmed) and exactly which pairs", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1), flag(M2, 1)];

    const done = await commit(built, session.drawId, { overrideReason: `  ${REASON}  ` });
    expect(done.gate).toEqual({ policy: "block", flagged: flags.current, overridden: true, carriedOver: false });
    expect(built.repository.gateOverrides()).toEqual([
      { cycleId: made.cycleId, round: 2, drawId: session.drawId, actorId: TREASURER, reason: REASON, flagged: flags.current, stage: "commit" }
    ]);

    // A replay (same key) commits and records nothing again, whatever reason it carries.
    const replay = await commit(built, session.drawId, { overrideReason: "A different reason entirely" });
    expect(replay.replayed).toBe(true);
    expect(built.repository.gateOverrides()).toHaveLength(1);
  });

  it("needs a real reason (10..1000 once trimmed) whether or not it ends up needed, and nothing is committed or recorded", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    for (const overrideReason of ["too short", "          ", "x".repeat(1001)]) {
      expect(await code(commit(built, session.drawId, { overrideReason }))).toBe("INVALID_REQUEST");
    }
    // not needed, still validated
    flags.current = [];
    expect(await code(commit(built, session.drawId, { overrideReason: "short" }))).toBe("INVALID_REQUEST");
    expect((await built.service.getSession(session.drawId, as(M1))).state).toBe("sealing");
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("needs the role: a plain member and an outsider are refused before the reason is considered", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    for (const who of [M1, M2, OUTSIDER]) {
      expect(await code(commit(built, session.drawId, { overrideReason: REASON }, who))).toBe("FORBIDDEN");
      expect(await code(commit(built, session.drawId, { overrideReason: "short" }, who))).toBe("FORBIDDEN");
    }
    expect(built.repository.gateOverrides()).toEqual([]);
    // the owner is a manager like the treasurer
    const done = await commit(built, session.drawId, { overrideReason: REASON }, OWNER);
    expect(done.gate?.overridden).toBe(true);
    expect(built.repository.gateOverrides()[0]?.actorId).toBe(OWNER);
  });
});

describe("an override given when the draw was OPENED", () => {
  const named = [flag(M1, 1), flag(M2, 1)];

  async function openedWithOverride(flags: { current: readonly DrawGateFlag[] }) {
    flags.current = named;
    const built = build(flags);
    const made = await cycle(built, "block");
    await drawRoundOne(built, made.cycleId);
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open"), overrideReason: REASON }, as(TREASURER));
    await sealTwo(built, opened.session.drawId, opened.session.eligible);
    return { built, made, session: opened.session };
  }

  it("still stands when the flagged set is the same: no new reason, nothing new recorded", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const { built, session } = await openedWithOverride(flags);
    const done = await commit(built, session.drawId, { overrideReason: "Not needed but a real reason" });
    expect(done.gate).toEqual({ policy: "block", flagged: named, overridden: false, carriedOver: true });
    expect(built.repository.gateOverrides()).toHaveLength(1);
    expect(built.repository.gateOverrides()[0]?.stage).toBe("open");
  });

  it("still stands when the set shrank", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const { built, session } = await openedWithOverride(flags);
    flags.current = [flag(M2, 1)];
    const done = await commit(built, session.drawId);
    expect(done.gate).toEqual({ policy: "block", flagged: [flag(M2, 1)], overridden: false, carriedOver: true });
  });

  it("does NOT stand when the set gained a pair: refused, and a fresh reason records a second override (both stages on record)", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const { built, made, session } = await openedWithOverride(flags);
    flags.current = [...named, flag(OWNER, 1)];
    expect(await code(commit(built, session.drawId))).toBe("CONTRIBUTION_GATE_BLOCKED");
    const done = await commit(built, session.drawId, { overrideReason: "A fresh reason for the new flag" });
    expect(done.gate).toMatchObject({ overridden: true, carriedOver: false });
    expect(built.repository.gateOverrides().map((entry) => entry.stage)).toEqual(["open", "commit"]);
    expect(built.repository.gateOverrides()[1]).toMatchObject({ cycleId: made.cycleId, round: 2, flagged: flags.current });
  });

  it("does NOT stand when the set has the same size but a different pair", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const { built, session } = await openedWithOverride(flags);
    flags.current = [flag(M1, 1), flag(OWNER, 1)];
    expect(await code(commit(built, session.drawId))).toBe("CONTRIBUTION_GATE_BLOCKED");
  });
});

describe("the policy at commit", () => {
  it("warn allows the commit and reports the flagged pairs; no override is recorded, even for a supplied reason", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "warn");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    expect(await code(commit(built, session.drawId, { overrideReason: "short" }))).toBe("INVALID_REQUEST");
    const done = await commit(built, session.drawId, { overrideReason: REASON });
    expect(done.gate).toEqual({ policy: "warn", flagged: [flag(M1, 1)], overridden: false, carriedOver: false });
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("off computes nothing", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "off");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    const done = await commit(built, session.drawId);
    expect(done.gate).toEqual({ policy: "off", flagged: [], overridden: false, carriedOver: false });
  });

  it("a policy switched to block WHILE SEALING stops the commit; recording the payment clears it without any override", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "warn");
    await drawRoundOne(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    // opened under warn: allowed, nothing recorded
    const opened = await built.service.openDraw({ cycleId: made.cycleId, idempotencyKey: key("open") }, as(TREASURER));
    await sealTwo(built, opened.session.drawId, opened.session.eligible);
    expect(built.repository.gateOverrides()).toEqual([]);

    await built.service.setContributionGate({ cycleId: made.cycleId, gate: "block", reason: "Switching it on for everyone" }, as(TREASURER));
    const error = (await commit(built, opened.session.drawId).catch((caught: unknown) => caught)) as DrawError;
    expect(error.code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect(error.flagged).toEqual([flag(M1, 1)]);

    flags.current = [];
    const done = await commit(built, opened.session.drawId);
    expect(done.gate).toMatchObject({ policy: "block", flagged: [], overridden: false });
    expect(built.repository.gateOverrides()).toEqual([]);
  });

  it("block relaxed to off while sealing lets the commit through", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    await built.service.setContributionGate({ cycleId: made.cycleId, gate: "off", reason: "The group decided to relax this" }, as(OWNER));
    expect((await commit(built, session.drawId)).gate?.policy).toBe("off");
  });
});

describe("the request, the route and the RPC", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: TREASURER } }, error: null });
    mocks.rpc.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const request = (body: unknown, bearer: string | null = "token") =>
    new Request("http://localhost/api/draw/commits", {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body)
    });

  it("the body accepts an optional override reason of 10..1000 characters once trimmed, and still nothing about who or what", () => {
    const base = { drawId: DRAW, idempotencyKey: "k1" };
    expect(drawCommitRequestSchema.safeParse(base).success).toBe(true);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: REASON }).success).toBe(true);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: "too short" }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: "         short         " }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: "x".repeat(1001) }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: REASON, actorId: OWNER }).success).toBe(false);
    expect(drawCommitRequestSchema.safeParse({ ...base, overrideReason: REASON, flagged: [] }).success).toBe(false);
    expect(drawCommitRequestSchema.parse({ ...base, overrideReason: `  ${REASON} ` }).overrideReason).toBe(REASON);
  });

  it("authenticates first", async () => {
    const service = { commitFromSession: vi.fn() } as unknown as DrawService;
    const response = await createCommitHandler(() => service)(request({ drawId: DRAW, idempotencyKey: "k" }, null));
    expect(response.status).toBe(401);
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("answers a refused commit 409 contribution_gate_blocked with who is flagged for which round", async () => {
    const service = {
      commitFromSession: vi.fn().mockRejectedValue(
        new DrawError("CONTRIBUTION_GATE_BLOCKED", "draw_contribution_gate_blocked", undefined, [flag(M1, 1), flag(M2, 1)])
      )
    } as unknown as DrawService;
    const response = await createCommitHandler(() => service)(request({ drawId: DRAW, idempotencyKey: "k" }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "contribution_gate_blocked",
      message: "draw_contribution_gate_blocked",
      flagged: [flag(M1, 1), flag(M2, 1)]
    });
  });

  it("forwards the reason (trimmed) to the service and answers with what the gate saw; a replay answers null", async () => {
    const round = { drawId: DRAW, groupId: GROUP, cycleId: "c", round: 2, commitment: "a".repeat(64), protocolVersion: "v3", rosterDigest: "b".repeat(64), commitmentNonce: "n", memberDigest: "d", participants: [], memberCommitments: [], potAmount: "1.00", totalRounds: 3, reserveRatioBps: 0, committedBy: TREASURER, committedAt: NOW, idempotencyKey: "k", state: "committed", reveal: null, payout: null };
    const commitFromSession = vi
      .fn()
      .mockResolvedValueOnce({ round, replayed: false, gate: { policy: "block", flagged: [flag(M1, 1)], overridden: true, carriedOver: false } })
      .mockResolvedValueOnce({ round, replayed: true });
    const service = { commitFromSession } as unknown as DrawService;
    const first = await createCommitHandler(() => service)(request({ drawId: DRAW, idempotencyKey: "k", overrideReason: `  ${REASON} ` }));
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.contributionGate).toEqual({ policy: "block", flagged: [flag(M1, 1)], overridden: true, carriedOver: false });
    expect(commitFromSession.mock.calls[0]![0]).toEqual({ drawId: DRAW, idempotencyKey: "k", overrideReason: REASON });
    expect(commitFromSession.mock.calls[0]![1]).toEqual({ userId: TREASURER });
    const second = await createCommitHandler(() => service)(request({ drawId: DRAW, idempotencyKey: "k" }));
    expect(second.status).toBe(200);
    expect((await second.json()).contributionGate).toBeNull();
  });

  it("the route over the real service: a flag after the open is a 409, the override a 201", async () => {
    const flags = { current: [] as readonly DrawGateFlag[] };
    const built = build(flags);
    const made = await cycle(built, "block");
    const session = await roundTwoSealed(built, made.cycleId);
    flags.current = [flag(M1, 1)];
    const handler = createCommitHandler(() => built.service);
    const refused = await handler(request({ drawId: session.drawId, idempotencyKey: "k-route", seed: SEED, commitmentNonce: NONCE }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).flagged).toEqual([flag(M1, 1)]);
    const accepted = await handler(request({ drawId: session.drawId, idempotencyKey: "k-route", seed: SEED, commitmentNonce: NONCE, overrideReason: REASON }));
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).contributionGate).toMatchObject({ policy: "block", overridden: true });
  });

  function repositoryWith(result: { data?: unknown; error?: { code?: string; message: string; details?: string | null } | null }) {
    const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
    return { repository: new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient), rpc };
  }
  const commitment = {
    drawId: DRAW,
    groupId: GROUP,
    cycleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    round: 2,
    commitment: "a".repeat(64),
    commitmentNonce: NONCE,
    rosterDigest: "b".repeat(64),
    memberDigest: "c".repeat(64),
    participants: [],
    idempotencyKey: "k",
    committedAt: NOW,
    protocolVersion: "v3"
  } as unknown as DrawCommitment;

  it("sends p_override_reason by name (null when none), maps the refusal with its DETAIL and the bad reason", async () => {
    const detail = JSON.stringify([flag(M1, 1), { nope: true }, flag(M2, 1)]);
    const blocked = repositoryWith({ error: { code: "P0001", message: "draw_contribution_gate_blocked", details: detail } });
    const error = (await blocked.repository.saveCommitment(commitment, as(TREASURER)).catch((caught: unknown) => caught)) as DrawError;
    expect(error.code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect(error.flagged).toEqual([flag(M1, 1), flag(M2, 1)]);
    expect(blocked.rpc).toHaveBeenCalledWith("commit_draw_from_seals_v1", expect.objectContaining({ p_draw_id: DRAW, p_override_reason: null }));

    const invalid = repositoryWith({ error: { code: "P0001", message: "draw_override_reason_invalid" } });
    const bad = (await invalid.repository.saveCommitment(commitment, as(TREASURER), { overrideReason: "short" }).catch((caught: unknown) => caught)) as DrawError;
    expect(bad.code).toBe("INVALID_REQUEST");
    expect(invalid.rpc).toHaveBeenCalledWith("commit_draw_from_seals_v1", expect.objectContaining({ p_override_reason: "short" }));
  });

  it("reads what the gate saw from the result; a replay (no contributionGate) is null", async () => {
    const round = { state: "committed", commitment: { ...commitment }, reveal: null, payout: null };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: { round, replayed: false, contributionGate: { policy: "block", flagged: [flag(M1, 1)], overridden: false, carriedOver: true } }, error: null })
      .mockResolvedValueOnce({ data: { round, replayed: true }, error: null });
    const repository = new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient);
    const first = await repository.saveCommitment(commitment, as(TREASURER));
    expect(first.gate).toEqual({ policy: "block", flagged: [flag(M1, 1)], overridden: false, carriedOver: true });
    const second = await repository.saveCommitment(commitment, as(TREASURER));
    expect(second.gate).toBeNull();
  });
});

describe("previewCommitGate: what the screen predicts is what the database decides", () => {
  const CYCLE = "66666666-6666-4666-8666-666666666666";
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ENTRY = "55555555-5555-4555-8555-555555555555";
  const cells = (statuses: readonly string[]) =>
    statuses.map((status, index) => ({
      round: index + 1,
      status,
      entryId: status === "met" ? ENTRY : null,
      source: status === "met" ? "treasurer" : null
    }));
  function view(options: { gate: DrawContributionGate; flagged: readonly string[]; open?: readonly string[]; extra?: Record<string, unknown> }) {
    const wire = {
      cycleId: CYCLE,
      groupId: "22222222-2222-4222-8222-222222222222",
      totalRounds: 3,
      contributionAmount: "100.00",
      startedAt: NOW,
      contributionGate: options.gate,
      nextRound: 3,
      flaggedCount: options.flagged.length,
      rounds: [1, 2, 3].map((round) => ({ round, dueAt: round <= 2 ? NOW : null, revealedAt: round === 1 ? NOW : null })),
      members: [A, B, C].map((id) => ({ memberId: id, active: true, winRound: null, cells: cells([options.flagged.includes(id) ? "flagged" : "met", "met", "not_due"]) })),
      gateEvents: [],
      overrides:
        options.open === undefined
          ? []
          : [{ at: NOW, actorId: A, round: 2, drawId: DRAW, reason: REASON, flagged: options.open.map((id) => ({ memberId: id, round: 1 })), ...options.extra }]
    };
    const parsed = parseCycleContributions(wire);
    if (parsed === null) throw new Error("fixture must parse");
    return parsed;
  }

  it("a stage-less override (an older server) reads as an open override", () => {
    expect(view({ gate: "block", flagged: [B], open: [B] }).overrides[0]?.stage).toBe("open");
    expect(view({ gate: "block", flagged: [B], open: [B], extra: { stage: "commit" } }).overrides[0]?.stage).toBe("commit");
    expect(parseCycleContributions({ cycleId: CYCLE })).toBeNull();
  });

  it("block: nothing flagged needs nothing; a flagged pair with no open override needs a reason", () => {
    expect(previewCommitGate(view({ gate: "block", flagged: [] }), DRAW, 2)).toMatchObject({ needsOverride: false, carriedOver: false, flagged: [] });
    const preview = previewCommitGate(view({ gate: "block", flagged: [B] }), DRAW, 2);
    expect(preview).toMatchObject({ policy: "block", needsOverride: true, carriedOver: false, acknowledged: [] });
    expect(preview.flagged).toEqual([{ memberId: B, round: 1 }]);
  });

  it("block: the open override covers the same pairs, fewer pairs, but not a new pair (even at the same size)", () => {
    expect(previewCommitGate(view({ gate: "block", flagged: [A, B], open: [A, B] }), DRAW, 2)).toMatchObject({ needsOverride: false, carriedOver: true });
    expect(previewCommitGate(view({ gate: "block", flagged: [B], open: [A, B] }), DRAW, 2)).toMatchObject({ needsOverride: false, carriedOver: true });
    expect(previewCommitGate(view({ gate: "block", flagged: [A, B, C], open: [A, B] }), DRAW, 2)).toMatchObject({ needsOverride: true, carriedOver: false });
    expect(previewCommitGate(view({ gate: "block", flagged: [B, C], open: [A, B] }), DRAW, 2)).toMatchObject({ needsOverride: true, carriedOver: false });
  });

  it("an override of another draw, or one given at commit, covers nothing", () => {
    const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(previewCommitGate(view({ gate: "block", flagged: [B], open: [B] }), other, 2).needsOverride).toBe(true);
    expect(previewCommitGate(view({ gate: "block", flagged: [B], open: [B], extra: { stage: "commit" } }), DRAW, 2).needsOverride).toBe(true);
  });

  it("warn confirms, off looks at nothing", () => {
    expect(previewCommitGate(view({ gate: "warn", flagged: [B] }), DRAW, 2)).toMatchObject({ needsConfirm: true, needsOverride: false });
    expect(previewCommitGate(view({ gate: "off", flagged: [B] }), DRAW, 2)).toMatchObject({ needsConfirm: false, needsOverride: false, flagged: [] });
  });
});
