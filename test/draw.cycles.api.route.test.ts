import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mocks.getUser } }))
}));

import {
  createCycleCreateHandler,
  createCycleListHandler,
  createCycleReadHandler,
  createDrawOpenHandler,
  createNonceHandler,
  createSealHandler,
  createSessionHandler
} from "@/lib/draw/routeHandlers";
import { DrawError } from "@/lib/draw/errors";
import type { DrawService } from "@/lib/draw/service";
import type { DrawCycleRecord, DrawErrorCode, DrawSessionView } from "@/lib/draw/types";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const cycleId = "77777777-7777-4777-8777-777777777777";
const drawId = "55555555-5555-4555-8555-555555555555";
const otherMember = "33333333-3333-4333-8333-333333333333";
const NONCE = "member-secret-nonce-0123456789";

const cycle: DrawCycleRecord = {
  cycleId,
  groupId,
  name: "Meskerem equb",
  contributionAmount: "1000.00",
  potAmount: "3000.00",
  totalRounds: 3,
  reserveRatioBps: 1000,
  startedAt: "2026-10-01T10:00:00.000Z",
  closedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  roundsRevealed: 0,
  roundsPaid: 0,
  nextRound: 1
};

const session: DrawSessionView = {
  drawId,
  groupId,
  cycleId,
  round: 1,
  state: "committed",
  openedBy: actorId,
  openedAt: "2026-10-01T10:00:00.000Z",
  committedAt: "2026-10-01T10:05:00.000Z",
  cycle,
  eligible: [actorId, otherMember],
  seals: [{ memberId: otherMember, sealed: "a".repeat(64), sealedAt: "2026-10-01T10:01:00.000Z" }],
  nonces: [{ memberId: otherMember, released: true }],
  revealRequested: false
};

function fakeService() {
  return {
    createCycle: vi.fn().mockResolvedValue({ cycle, replayed: false }),
    listCycles: vi.fn().mockResolvedValue([cycle]),
    getCycleDetail: vi.fn().mockResolvedValue({
      cycle,
      draws: [
        {
          drawId,
          round: 1,
          state: "committed",
          openedAt: "2026-10-01T10:00:00.000Z",
          committedAt: null,
          revealedAt: null,
          winnerMemberId: null,
          sealCount: 1,
          nonceCount: 1,
          revealRequested: false,
          superseded: false,
          legacy: false
        }
      ]
    }),
    openDraw: vi.fn().mockResolvedValue({ session: { ...session, state: "sealing" }, replayed: false }),
    getSession: vi.fn().mockResolvedValue(session),
    submitSeal: vi.fn().mockResolvedValue({ memberId: actorId, sealed: "b".repeat(64), replaced: false }),
    submitNonce: vi.fn().mockResolvedValue({ memberId: actorId, replayed: false })
  } as unknown as DrawService;
}

function post(path: string, body: unknown, bearer = "token", contentType = "application/json"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function get(path: string, bearer = "token"): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: actorId } }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const cycleBody = {
  groupId,
  name: "Meskerem equb",
  contributionAmount: "1000.00",
  totalRounds: 3,
  reserveRatioBps: 1000,
  idempotencyKey: "cycle-create-1"
};

describe("every new route authenticates first", () => {
  const cases: [string, (service: DrawService) => (request: Request) => Promise<Response>, () => Request][] = [
    ["POST /api/draw/cycles", (service) => createCycleCreateHandler(() => service), () => post("/api/draw/cycles", cycleBody, "")],
    ["GET /api/draw/cycles", (service) => createCycleListHandler(() => service), () => get(`/api/draw/cycles?groupId=${groupId}`, "")],
    ["POST /api/draw/draws", (service) => createDrawOpenHandler(() => service), () => post("/api/draw/draws", { cycleId, idempotencyKey: "k" }, "")],
    ["POST /api/draw/seals", (service) => createSealHandler(() => service), () => post("/api/draw/seals", { drawId, sealed: "a".repeat(64) }, "")],
    ["POST /api/draw/nonces", (service) => createNonceHandler(() => service), () => post("/api/draw/nonces", { drawId, nonce: NONCE }, "")]
  ];

  for (const [name, handler, make] of cases) {
    it(`${name}: 401 without a Bearer token, and the service is never reached`, async () => {
      const service = fakeService();
      const response = await handler(service)(make());
      expect(response.status).toBe(401);
      expect(mocks.getUser).not.toHaveBeenCalled();
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    });
  }

  it("503s when Supabase is not configured, and when authentication is unavailable", async () => {
    const service = fakeService();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await createSealHandler(() => service)(post("/api/draw/seals", { drawId, sealed: "a".repeat(64) }))).status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    mocks.getUser.mockRejectedValue(new Error("down"));
    expect((await createNonceHandler(() => service)(post("/api/draw/nonces", { drawId, nonce: NONCE }))).status).toBe(503);
    expect(service.submitSeal).not.toHaveBeenCalled();
    expect(service.submitNonce).not.toHaveBeenCalled();
  });

  it("401s when the token is rejected", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("bad jwt") });
    const service = fakeService();
    const response = await createCycleListHandler(() => service)(get(`/api/draw/cycles?groupId=${groupId}`));
    expect(response.status).toBe(401);
    expect(service.listCycles).not.toHaveBeenCalled();
  });
});

describe("POST /api/draw/cycles", () => {
  it("creates a cycle: 201, and the acting user is the verified one", async () => {
    const service = fakeService();
    const response = await createCycleCreateHandler(() => service)(post("/api/draw/cycles", cycleBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ replayed: false, cycle: { cycleId, potAmount: "3000.00", contributionAmount: "1000.00" } });
    const call = (service.createCycle as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[1]).toEqual({ userId: actorId });
    expect(call[0]).toMatchObject({ groupId, contributionAmount: "1000.00", totalRounds: 3 });
  });

  it("answers 200 on a replay", async () => {
    const service = fakeService();
    (service.createCycle as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({ cycle, replayed: true });
    expect((await createCycleCreateHandler(() => service)(post("/api/draw/cycles", cycleBody))).status).toBe(200);
  });

  it("REJECTS (400) what the server computes or decides: a pot, a roster, a tenant, an unknown field", async () => {
    for (const smuggled of [
      { potAmount: "3000.00" },
      { memberCount: 3 },
      { tenantId: groupId },
      { createdBy: actorId },
      { members: [] }
    ]) {
      const service = fakeService();
      const response = await createCycleCreateHandler(() => service)(post("/api/draw/cycles", { ...cycleBody, ...smuggled }));
      expect(response.status).toBe(400);
      expect(service.createCycle).not.toHaveBeenCalled();
    }
  });

  it("REJECTS (400) numeric money, a bad reserve, zero rounds, a blank name, a bad content type", async () => {
    for (const bad of [
      { contributionAmount: 1000 },
      { contributionAmount: "0.00" },
      { contributionAmount: "10.5" },
      { reserveRatioBps: 3334 },
      { totalRounds: 0 },
      { name: "   " }
    ]) {
      const service = fakeService();
      expect((await createCycleCreateHandler(() => service)(post("/api/draw/cycles", { ...cycleBody, ...bad }))).status).toBe(400);
      expect(service.createCycle).not.toHaveBeenCalled();
    }
    const service = fakeService();
    expect((await createCycleCreateHandler(() => service)(post("/api/draw/cycles", cycleBody, "token", "text/plain"))).status).toBe(400);
  });

  it("403s when the database refuses the caller's role", async () => {
    const service = fakeService();
    (service.createCycle as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(new DrawError("FORBIDDEN", "draw_forbidden"));
    const response = await createCycleCreateHandler(() => service)(post("/api/draw/cycles", cycleBody));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });
});

describe("GET /api/draw/cycles and /api/draw/cycles/[cycleId]", () => {
  it("lists a group's cycles", async () => {
    const service = fakeService();
    const response = await createCycleListHandler(() => service)(get(`/api/draw/cycles?groupId=${groupId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cycles: [{ cycleId, name: "Meskerem equb" }] });
    expect(service.listCycles).toHaveBeenCalledWith(groupId, { userId: actorId });
  });

  it("REJECTS (400) a missing or malformed group, and an unknown query parameter", async () => {
    for (const query of ["", "?groupId=not-a-uuid", `?groupId=${groupId}&limit=5`, `?groupId=${groupId}&groupId=${groupId}`]) {
      const service = fakeService();
      expect((await createCycleListHandler(() => service)(get(`/api/draw/cycles${query}`))).status).toBe(400);
      expect(service.listCycles).not.toHaveBeenCalled();
    }
  });

  it("reads one cycle with its draws, and 404s a non-uuid", async () => {
    const service = fakeService();
    const response = await createCycleReadHandler(() => service)(get(`/api/draw/cycles/${cycleId}`), { params: { cycleId } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cycle: { cycleId }, draws: [{ drawId, state: "committed", nonceCount: 1 }] });
    expect((await createCycleReadHandler(() => service)(get("/api/draw/cycles/nope"), { params: { cycleId: "nope" } })).status).toBe(404);
  });

  it("403s a caller outside the group", async () => {
    const service = fakeService();
    (service.getCycleDetail as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(new DrawError("FORBIDDEN", "draw_forbidden"));
    expect((await createCycleReadHandler(() => service)(get(`/api/draw/cycles/${cycleId}`), { params: { cycleId } })).status).toBe(403);
  });
});

describe("POST /api/draw/draws and GET /api/draw/draws/[drawId]", () => {
  it("opens a draw: the server creates the id, 201, nothing about the draw id is accepted from the client", async () => {
    const service = fakeService();
    const response = await createDrawOpenHandler(() => service)(post("/api/draw/draws", { cycleId, idempotencyKey: "open-1" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ replayed: false, session: { drawId, state: "sealing" } });

    for (const smuggled of [{ drawId }, { groupId }, { eligible: [actorId] }]) {
      const rejected = fakeService();
      expect(
        (await createDrawOpenHandler(() => rejected)(post("/api/draw/draws", { cycleId, idempotencyKey: "open-2", ...smuggled }))).status
      ).toBe(400);
      expect(rejected.openDraw).not.toHaveBeenCalled();
    }
  });

  it("maps the lifecycle refusals", async () => {
    const table: [DrawErrorCode, number][] = [
      ["FORBIDDEN", 403],
      ["ROUND_OUT_OF_ORDER", 422],
      ["CYCLE_COMPLETE", 409],
      ["ALREADY_REVEALED", 409],
      ["IDEMPOTENCY_CONFLICT", 409]
    ];
    for (const [code, status] of table) {
      const service = fakeService();
      (service.openDraw as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(new DrawError(code, code));
      expect((await createDrawOpenHandler(() => service)(post("/api/draw/draws", { cycleId, idempotencyKey: "k" }))).status, code).toBe(status);
    }
  });

  it("reads a draw in progress: seal hashes and a boolean per member, never a nonce", async () => {
    const service = fakeService();
    // A service that (wrongly) carried a nonce on its objects still cannot leak it:
    // the projection copies named fields only.
    (service.getSession as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      ...session,
      nonces: [{ memberId: otherMember, released: true, nonce: NONCE }],
      seals: [{ memberId: otherMember, sealed: "a".repeat(64), nonce: NONCE }]
    });
    const response = await createSessionHandler(() => service)(get(`/api/draw/draws/${drawId}`), { params: { drawId } });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(NONCE);
    expect(JSON.parse(text)).toMatchObject({
      session: { drawId, state: "committed", nonces: [{ memberId: otherMember, released: true }], seals: [{ memberId: otherMember, sealed: "a".repeat(64) }] }
    });
    expect((await createSessionHandler(() => service)(get("/api/draw/draws/nope"), { params: { drawId: "nope" } })).status).toBe(404);
  });
});

describe("POST /api/draw/seals", () => {
  it("seals for the signed-in user: the service receives the verified identity, not a body field", async () => {
    const service = fakeService();
    const response = await createSealHandler(() => service)(post("/api/draw/seals", { drawId, sealed: "b".repeat(64) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drawId, memberId: actorId, sealed: "b".repeat(64), replaced: false });
    const call = (service.submitSeal as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toEqual({ drawId, sealed: "b".repeat(64) });
    expect(call[1]).toEqual({ userId: actorId });
  });

  it("REJECTS (400) a body that names a member: one member cannot seal for another", async () => {
    for (const smuggled of [{ memberId: otherMember }, { userId: otherMember }, { member: otherMember }, { actorId: otherMember }]) {
      const service = fakeService();
      const response = await createSealHandler(() => service)(post("/api/draw/seals", { drawId, sealed: "b".repeat(64), ...smuggled }));
      expect(response.status).toBe(400);
      expect(service.submitSeal).not.toHaveBeenCalled();
    }
  });

  it("REJECTS (400) a seal that is not a lowercase SHA-256 digest", async () => {
    for (const sealed of ["short", "B".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      const service = fakeService();
      expect((await createSealHandler(() => service)(post("/api/draw/seals", { drawId, sealed }))).status).toBe(400);
      expect(service.submitSeal).not.toHaveBeenCalled();
    }
  });

  it("maps the seal refusals", async () => {
    const table: [DrawErrorCode, number][] = [
      ["FORBIDDEN", 403],
      ["NOT_ELIGIBLE", 403],
      ["ALREADY_COMMITTED", 409],
      ["NOT_FOUND", 404]
    ];
    for (const [code, status] of table) {
      const service = fakeService();
      (service.submitSeal as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(new DrawError(code, code));
      expect((await createSealHandler(() => service)(post("/api/draw/seals", { drawId, sealed: "b".repeat(64) }))).status, code).toBe(status);
    }
  });
});

describe("POST /api/draw/nonces", () => {
  it("releases for the signed-in user and never echoes the nonce", async () => {
    const service = fakeService();
    const response = await createNonceHandler(() => service)(post("/api/draw/nonces", { drawId, nonce: NONCE }));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(NONCE);
    expect(JSON.parse(text)).toEqual({ drawId, memberId: actorId, released: true, replayed: false });
    const call = (service.submitNonce as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[1]).toEqual({ userId: actorId });
  });

  it("REJECTS (400) a body that names a member, and weak entropy", async () => {
    for (const body of [
      { drawId, nonce: NONCE, memberId: otherMember },
      { drawId, nonce: "short" },
      { drawId, nonce: "has a space in it 0123456789" }
    ]) {
      const service = fakeService();
      expect((await createNonceHandler(() => service)(post("/api/draw/nonces", body))).status).toBe(400);
      expect(service.submitNonce).not.toHaveBeenCalled();
    }
  });

  it("refuses a nonce before the commitment with 409 nonce_too_early, and does not echo it in the error", async () => {
    const service = fakeService();
    (service.submitNonce as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(
      new DrawError("NONCE_TOO_EARLY", "draw_nonce_too_early")
    );
    const response = await createNonceHandler(() => service)(post("/api/draw/nonces", { drawId, nonce: NONCE }));

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: "nonce_too_early" });
    expect(text).not.toContain(NONCE);
  });

  it("maps the other nonce refusals", async () => {
    const table: [DrawErrorCode, number][] = [
      ["FORBIDDEN", 403],
      ["MEMBER_COMMITMENT_MISMATCH", 422],
      ["MEMBER_COMMITMENT_MISSING", 422],
      ["ALREADY_REVEALED", 409]
    ];
    for (const [code, status] of table) {
      const service = fakeService();
      (service.submitNonce as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(new DrawError(code, code));
      expect((await createNonceHandler(() => service)(post("/api/draw/nonces", { drawId, nonce: NONCE }))).status, code).toBe(status);
    }
  });
});
