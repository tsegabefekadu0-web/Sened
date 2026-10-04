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

import type { SupabaseClient } from "@supabase/supabase-js";

import { GET } from "@/app/api/draw/contributions/route";
import { POST as GATE_POST } from "@/app/api/draw/gate/route";
import { DrawError } from "@/lib/draw/errors";
import { InMemoryDrawRepository, SupabaseDrawRepository, drawErrorStatus } from "@/lib/draw/repository";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import {
  createCycleCreateHandler,
  createDrawOpenHandler,
  createGateSetHandler
} from "@/lib/draw/routeHandlers";
import { DrawService } from "@/lib/draw/service";
import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";
import {
  drawContributionsQuerySchema,
  drawCycleCreateRequestSchema,
  drawGateRequestSchema,
  drawOpenRequestSchema,
  parse
} from "@/lib/validation";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const CYCLE = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-10-10T09:00:00.000Z";
const REASON = "Members agreed to pay on Friday";

function request(path: string, init: { method?: string; body?: unknown; bearer?: string | null } = {}): Request {
  const bearer = init.bearer === undefined ? "token" : init.bearer;
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "POST",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
}

/** A real service over the in-memory draw repository, with a scripted stand-in for the ledger-derived flags. */
function setup(options: { flagged?: readonly { memberId: string; round: number }[] } = {}) {
  const repository = new InMemoryDrawRepository({
    groups: [
      {
        groupId: GROUP,
        members: [
          { userId: OWNER, role: "owner" },
          { userId: MEMBER, role: "member" },
          { userId: OTHER, role: "member" }
        ]
      }
    ],
    hasher: nodeDrawHasher,
    clock: () => new Date(NOW),
    contributionFlags: () => options.flagged ?? []
  });
  const ledger = new InMemoryLedgerRepository({ groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: OWNER, role: "owner" }] }], accounts: [] });
  const service = new DrawService(repository, new LedgerService(ledger), { hasher: nodeDrawHasher, clock: () => new Date(NOW) });
  return { repository, service };
}

async function createCycle(service: DrawService, gate?: "off" | "warn" | "block") {
  const response = await createCycleCreateHandler(() => service)(
    request("/api/draw/cycles", {
      body: {
        groupId: GROUP,
        name: "Meskerem equb",
        contributionAmount: "100.00",
        totalRounds: 2,
        reserveRatioBps: 1000,
        idempotencyKey: `cycle-${gate ?? "default"}`,
        ...(gate === undefined ? {} : { contributionGate: gate })
      }
    })
  );
  return { response, body: (await response.json()) as { cycle: { cycleId: string; contributionGate: string } } };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: OWNER } }, error: null });
  mocks.rpc.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation", () => {
  it("accepts a gate at creation and refuses an unknown one", () => {
    const base = { groupId: GROUP, name: "x", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "k1" };
    for (const gate of ["off", "warn", "block"]) expect(parse(drawCycleCreateRequestSchema, { ...base, contributionGate: gate }).ok).toBe(true);
    expect(parse(drawCycleCreateRequestSchema, base).ok).toBe(true);
    expect(parse(drawCycleCreateRequestSchema, { ...base, contributionGate: "strict" }).ok).toBe(false);
  });

  it("an override reason is 10..1000 characters once trimmed, and only that field is added to the open", () => {
    const base = { cycleId: CYCLE, idempotencyKey: "k1" };
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: REASON }).ok).toBe(true);
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: "too short" }).ok).toBe(false);
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: "         short         " }).ok).toBe(false);
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: "x".repeat(1001) }).ok).toBe(false);
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: undefined }).ok).toBe(true);
    // Who overrides, and for whom, is never in the body.
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: REASON, actorId: OWNER }).ok).toBe(false);
    expect(parse(drawOpenRequestSchema, { ...base, overrideReason: REASON, flagged: [] }).ok).toBe(false);
  });

  it("the gate request carries a cycle, a policy and a reason, and nothing else", () => {
    expect(parse(drawGateRequestSchema, { cycleId: CYCLE, gate: "block", reason: REASON }).ok).toBe(true);
    expect(parse(drawGateRequestSchema, { cycleId: CYCLE, gate: "block", reason: "short" }).ok).toBe(false);
    expect(parse(drawGateRequestSchema, { cycleId: CYCLE, gate: "partial", reason: REASON }).ok).toBe(false);
    expect(parse(drawGateRequestSchema, { cycleId: CYCLE, gate: "block", reason: REASON, actorId: OWNER }).ok).toBe(false);
    expect(parse(drawContributionsQuerySchema, { cycleId: CYCLE }).ok).toBe(true);
    expect(parse(drawContributionsQuerySchema, { cycleId: CYCLE, memberId: OWNER }).ok).toBe(false);
  });
});

describe("POST /api/draw/cycles with a gate", () => {
  it("defaults to off and records the chosen policy", async () => {
    const { service } = setup();
    expect((await createCycle(service)).body.cycle.contributionGate).toBe("off");
    const warn = await createCycle(service, "warn");
    expect(warn.response.status).toBe(201);
    expect(warn.body.cycle.contributionGate).toBe("warn");
  });

  it("a replay with a different policy is an idempotency conflict, not a silent change", async () => {
    const { service } = setup();
    await createCycleCreateHandler(() => service)(
      request("/api/draw/cycles", {
        body: { groupId: GROUP, name: "n", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "same", contributionGate: "block" }
      })
    );
    const again = await createCycleCreateHandler(() => service)(
      request("/api/draw/cycles", {
        body: { groupId: GROUP, name: "n", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "same", contributionGate: "off" }
      })
    );
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("idempotency_conflict");
  });

  it("only an owner or treasurer can create it", async () => {
    const { service } = setup();
    mocks.getUser.mockResolvedValue({ data: { user: { id: MEMBER } }, error: null });
    const response = await createCycleCreateHandler(() => service)(
      request("/api/draw/cycles", {
        body: { groupId: GROUP, name: "n", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "m1", contributionGate: "block" }
      })
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/draw/gate", () => {
  it("authenticates first", async () => {
    const { service } = setup();
    const response = await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId: CYCLE, gate: "block", reason: REASON }, bearer: null }));
    expect(response.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("changes the policy, records who and why, and answers 200", async () => {
    const { service, repository } = setup();
    const { body } = await createCycle(service);
    const cycleId = body.cycle.cycleId;
    const response = await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId, gate: "block", reason: `  ${REASON}  ` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: false, cycle: { cycleId, contributionGate: "block" } });
    expect(repository.gateEvents()).toEqual([{ cycleId, from: "off", to: "block", actorId: OWNER, reason: REASON }]);

    // The policy in force again is a replay and records nothing.
    const again = await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId, gate: "block", reason: REASON } }));
    expect((await again.json()).replayed).toBe(true);
    expect(repository.gateEvents()).toHaveLength(1);
  });

  it("refuses a plain member (403), a bad body (400) and an unknown cycle (403)", async () => {
    const { service, repository } = setup();
    const { body } = await createCycle(service);
    const cycleId = body.cycle.cycleId;
    mocks.getUser.mockResolvedValue({ data: { user: { id: MEMBER } }, error: null });
    expect((await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId, gate: "block", reason: REASON } }))).status).toBe(403);
    mocks.getUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null });
    expect((await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId, gate: "block", reason: "short" } }))).status).toBe(400);
    expect((await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId, gate: "nope", reason: REASON } }))).status).toBe(400);
    expect((await createGateSetHandler(() => service)(request("/api/draw/gate", { body: { cycleId: CYCLE, gate: "block", reason: REASON } }))).status).toBe(403);
    expect(repository.gateEvents()).toEqual([]);
  });

  it("the route module is wired to the handler", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("bad jwt") });
    expect((await GATE_POST(request("/api/draw/gate", { body: { cycleId: CYCLE, gate: "block", reason: REASON } }))).status).toBe(401);
  });
});

describe("the SQL error contract", () => {
  function repositoryWith(error: { code?: string; message: string; details?: string | null }) {
    const rpc = vi.fn().mockResolvedValue({ data: null, error });
    return { repository: new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient), rpc };
  }

  it("draw_contribution_gate_blocked carries who/which rounds from the DETAIL, and is a 409", async () => {
    const detail = JSON.stringify([
      { memberId: MEMBER, round: 1 },
      { memberId: OTHER, round: 2 },
      { memberId: "not-an-id-but-a-string", round: 2 },
      { nope: true }
    ]);
    const { repository, rpc } = repositoryWith({ code: "P0001", message: "draw_contribution_gate_blocked", details: detail });
    const error = await repository.openDraw({ cycleId: CYCLE, idempotencyKey: "k" }, { userId: OWNER }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DrawError);
    expect((error as DrawError).code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect((error as DrawError).flagged).toEqual([
      { memberId: MEMBER, round: 1 },
      { memberId: OTHER, round: 2 },
      { memberId: "not-an-id-but-a-string", round: 2 }
    ]);
    expect(drawErrorStatus("CONTRIBUTION_GATE_BLOCKED")).toBe(409);
    expect(rpc).toHaveBeenCalledWith("open_draw_v1", { p_cycle_id: CYCLE, p_round: null, p_idempotency_key: "k", p_override_reason: null });
  });

  it("an unreadable DETAIL still refuses (with no rounds), never opens", async () => {
    const { repository } = repositoryWith({ code: "P0001", message: "draw_contribution_gate_blocked", details: "not json" });
    const error = (await repository.openDraw({ cycleId: CYCLE, idempotencyKey: "k" }, { userId: OWNER }).catch((caught: unknown) => caught)) as DrawError;
    expect(error.code).toBe("CONTRIBUTION_GATE_BLOCKED");
    expect(error.flagged).toEqual([]);
  });

  it("the override reason and the policy travel as named parameters, and the bad-reason refusal is a request error", async () => {
    const { repository, rpc } = repositoryWith({ code: "P0001", message: "draw_override_reason_invalid" });
    const error = (await repository
      .openDraw({ cycleId: CYCLE, round: 2, idempotencyKey: "k", overrideReason: REASON }, { userId: OWNER })
      .catch((caught: unknown) => caught)) as DrawError;
    expect(error.code).toBe("INVALID_REQUEST");
    expect(rpc).toHaveBeenCalledWith("open_draw_v1", { p_cycle_id: CYCLE, p_round: 2, p_idempotency_key: "k", p_override_reason: REASON });

    const created = repositoryWith({ code: "P0001", message: "draw_invalid_request" });
    await created.repository
      .createCycle(
        { groupId: GROUP, name: "n", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "k", contributionGate: "block" },
        { userId: OWNER }
      )
      .catch(() => undefined);
    expect(created.rpc).toHaveBeenCalledWith(
      "create_draw_cycle_v1",
      expect.objectContaining({ p_contribution_gate: "block" })
    );
    const defaulted = repositoryWith({ code: "P0001", message: "draw_invalid_request" });
    await defaulted.repository
      .createCycle({ groupId: GROUP, name: "n", contributionAmount: "100.00", totalRounds: 2, reserveRatioBps: 0, idempotencyKey: "k" }, { userId: OWNER })
      .catch(() => undefined);
    expect(defaulted.rpc).toHaveBeenCalledWith("create_draw_cycle_v1", expect.objectContaining({ p_contribution_gate: "off" }));
  });

  it("set_draw_cycle_contribution_gate_v1 is called with the cycle, the policy and the reason only", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        cycle: {
          cycleId: CYCLE,
          groupId: GROUP,
          name: "n",
          contributionAmount: "100.00",
          potAmount: "300.00",
          totalRounds: 2,
          reserveRatioBps: 0,
          startedAt: NOW,
          closedAt: null,
          createdAt: NOW,
          roundsRevealed: 0,
          roundsPaid: 0,
          nextRound: 1,
          contributionGate: "block"
        },
        replayed: false
      },
      error: null
    });
    const repository = new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient);
    const result = await repository.setContributionGate({ cycleId: CYCLE, gate: "block", reason: REASON }, { userId: OWNER });
    expect(result.cycle.contributionGate).toBe("block");
    expect(rpc).toHaveBeenCalledWith("set_draw_cycle_contribution_gate_v1", { p_cycle_id: CYCLE, p_gate: "block", p_reason: REASON });
  });

  it("the open result carries what the gate saw; an absent contributionGate (a replay) is null", async () => {
    const session = {
      drawId: "55555555-5555-4555-8555-555555555555",
      groupId: GROUP,
      cycleId: CYCLE,
      round: 2,
      state: "sealing",
      openedBy: OWNER,
      openedAt: NOW,
      committedAt: null,
      cycle: {
        cycleId: CYCLE,
        groupId: GROUP,
        name: "n",
        contributionAmount: "100.00",
        potAmount: "300.00",
        totalRounds: 2,
        reserveRatioBps: 0,
        startedAt: NOW,
        closedAt: null,
        createdAt: NOW,
        roundsRevealed: 1,
        roundsPaid: 0,
        nextRound: 2,
        contributionGate: "block"
      },
      eligible: [OWNER],
      seals: [],
      nonces: [],
      revealRequested: false
    };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { session, replayed: false, contributionGate: { policy: "block", flagged: [{ memberId: MEMBER, round: 1 }], overridden: true } },
        error: null
      })
      .mockResolvedValueOnce({ data: { session, replayed: true }, error: null });
    const repository = new SupabaseDrawRepository({ rpc } as unknown as SupabaseClient);
    const first = await repository.openDraw({ cycleId: CYCLE, idempotencyKey: "k", overrideReason: REASON }, { userId: OWNER });
    expect(first.gate).toEqual({ policy: "block", flagged: [{ memberId: MEMBER, round: 1 }], overridden: true });
    expect(first.session.cycle.contributionGate).toBe("block");
    const second = await repository.openDraw({ cycleId: CYCLE, idempotencyKey: "k" }, { userId: OWNER });
    expect(second.gate).toBeNull();
  });
});

describe("the route answer for a refused open", () => {
  it("is 409 contribution_gate_blocked with who is flagged for which round", async () => {
    const service = {
      openDraw: vi.fn().mockRejectedValue(
        new DrawError("CONTRIBUTION_GATE_BLOCKED", "draw_contribution_gate_blocked", undefined, [
          { memberId: MEMBER, round: 1 },
          { memberId: OTHER, round: 1 }
        ])
      )
    } as unknown as DrawService;
    const response = await createDrawOpenHandler(() => service)(request("/api/draw/draws", { body: { cycleId: CYCLE, idempotencyKey: "k" } }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "contribution_gate_blocked",
      message: "draw_contribution_gate_blocked",
      flagged: [
        { memberId: MEMBER, round: 1 },
        { memberId: OTHER, round: 1 }
      ]
    });
  });

  it("forwards the override reason to the service verbatim (trimmed), and nothing about who or what", async () => {
    const service = {
      openDraw: vi.fn().mockRejectedValue(new DrawError("CYCLE_COMPLETE", "draw_cycle_complete"))
    } as unknown as DrawService;
    await createDrawOpenHandler(() => service)(request("/api/draw/draws", { body: { cycleId: CYCLE, idempotencyKey: "k", overrideReason: `  ${REASON} ` } }));
    const call = (service.openDraw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toEqual({ cycleId: CYCLE, idempotencyKey: "k", overrideReason: REASON });
    expect(call[1]).toEqual({ userId: OWNER });
  });
});

describe("GET /api/draw/contributions", () => {
  const cells = (statuses: string[]) =>
    statuses.map((status, index) => ({
      round: index + 1,
      status,
      entryId: status === "met" ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : null,
      source: status === "met" ? "treasurer" : null
    }));
  const payload = {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 2,
    contributionAmount: "100.00",
    startedAt: NOW,
    contributionGate: "warn",
    nextRound: 2,
    flaggedCount: 1,
    rounds: [
      { round: 1, dueAt: NOW, revealedAt: NOW },
      { round: 2, dueAt: null, revealedAt: null }
    ],
    members: [
      { memberId: OWNER, active: true, winRound: 1, cells: cells(["met", "not_due"]) },
      { memberId: MEMBER, active: true, winRound: null, cells: cells(["flagged", "not_due"]) }
    ],
    gateEvents: [],
    overrides: []
  };

  it("401s without a token and never reaches the database", async () => {
    const response = await GET(request(`/api/draw/contributions?cycleId=${CYCLE}`, { method: "GET", bearer: null }));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a missing or malformed cycle id and any extra parameter", async () => {
    for (const query of ["", "?cycleId=nope", `?cycleId=${CYCLE}&memberId=${OWNER}`]) {
      expect((await GET(request(`/api/draw/contributions${query}`, { method: "GET" }))).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns the derived grid, uncached, from the SQL function with only the cycle id", async () => {
    mocks.rpc.mockResolvedValue({ data: payload, error: null });
    const response = await GET(request(`/api/draw/contributions?cycleId=${CYCLE}`, { method: "GET" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.contributions.members).toHaveLength(2);
    expect(body.contributions.members[1].cells[0].status).toBe("flagged");
    expect(mocks.rpc).toHaveBeenCalledWith("get_draw_cycle_contributions_v1", { p_cycle_id: CYCLE });
  });

  it("answers 403 when the database refuses (outsider or unknown cycle), 502 on a storage failure or a malformed answer", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "draw_forbidden" } });
    expect((await GET(request(`/api/draw/contributions?cycleId=${CYCLE}`, { method: "GET" }))).status).toBe(403);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await GET(request(`/api/draw/contributions?cycleId=${CYCLE}`, { method: "GET" }))).status).toBe(502);
    mocks.rpc.mockResolvedValue({ data: { ...payload, members: [{ memberId: OWNER, active: true, winRound: null, cells: [] }] }, error: null });
    expect((await GET(request(`/api/draw/contributions?cycleId=${CYCLE}`, { method: "GET" }))).status).toBe(502);
  });
});
