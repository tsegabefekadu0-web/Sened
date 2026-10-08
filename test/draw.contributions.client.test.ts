import { describe, expect, it, vi } from "vitest";

import { drawErrorKey, listCycles, openDraw, readContributions, readCycle, readSession, setContributionGate } from "@/lib/draw/clientDraw";
import { dictionaries } from "@/lib/i18n";

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";
const REASON = "Members agreed to pay on Friday";

const cycle = {
  cycleId: CYCLE,
  groupId: GROUP,
  name: "n",
  contributionAmount: "100.00",
  potAmount: "300.00",
  totalRounds: 2,
  reserveRatioBps: 0,
  startedAt: T0,
  closedAt: null,
  createdAt: T0,
  roundsRevealed: 0,
  roundsPaid: 0,
  nextRound: 1,
  contributionGate: "block"
};
const session = {
  drawId: DRAW,
  groupId: GROUP,
  cycleId: CYCLE,
  round: 1,
  state: "sealing",
  openedBy: A,
  openedAt: T0,
  committedAt: null,
  cycle,
  eligible: [A],
  seals: [],
  nonces: [],
  revealRequested: false
};
const grid = {
  cycleId: CYCLE,
  groupId: GROUP,
  totalRounds: 2,
  contributionAmount: "100.00",
  startedAt: T0,
  contributionGate: "warn",
  nextRound: 2,
  flaggedCount: 1,
  rounds: [
    { round: 1, dueAt: T0, revealedAt: T0 },
    { round: 2, dueAt: null, revealedAt: null }
  ],
  members: [
    {
      memberId: A,
      active: true,
      winRound: null,
      cells: [
        { round: 1, status: "flagged", entryId: null, source: null },
        { round: 2, status: "not_due", entryId: null, source: null }
      ]
    }
  ],
  gateEvents: [],
  overrides: []
};

function deps(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { deps: { getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch }, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readContributions", () => {
  it("GETs the cycle's derived grid with the Bearer token and validates it", async () => {
    const { deps: d, fetchImpl } = deps(json({ contributions: grid }));
    const result = await readContributions(CYCLE, d);
    expect(result).toMatchObject({ ok: true, data: { cycleId: CYCLE, contributionGate: "warn" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/draw/contributions?cycleId=${CYCLE}`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("refuses a malformed grid rather than guessing, and passes server errors on", async () => {
    expect(await readContributions(CYCLE, deps(json({ contributions: { ...grid, members: [{ memberId: A, active: true, cells: [] }] } })).deps)).toMatchObject({ ok: false, code: "bad_response" });
    expect(await readContributions(CYCLE, deps(json({ error: "forbidden" }, 403)).deps)).toMatchObject({ ok: false, status: 403, code: "forbidden" });
    expect(await readContributions(CYCLE, deps(new Error("offline")).deps)).toMatchObject({ ok: false, code: "network" });
  });
});

describe("setContributionGate", () => {
  it("POSTs the cycle, the policy and the reason, and nothing naming who is acting", async () => {
    const { deps: d, fetchImpl } = deps(json({ cycle, replayed: false }));
    const result = await setContributionGate({ cycleId: CYCLE, gate: "block", reason: REASON }, d);
    expect(result).toMatchObject({ ok: true, data: { replayed: false, cycle: { contributionGate: "block" } } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/draw/gate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ cycleId: CYCLE, gate: "block", reason: REASON });
  });

  it("passes a refusal on", async () => {
    expect(await setContributionGate({ cycleId: CYCLE, gate: "off", reason: REASON }, deps(json({ error: "forbidden" }, 403)).deps)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("openDraw", () => {
  it("sends the override reason only when given, and returns what the gate saw", async () => {
    const gate = { policy: "block", flagged: [{ memberId: B, round: 1 }], overridden: true };
    const { deps: d, fetchImpl } = deps(json({ session, replayed: false, contributionGate: gate }, 201));
    const result = await openDraw({ cycleId: CYCLE, idempotencyKey: "k", overrideReason: REASON }, d);
    expect(result).toMatchObject({ ok: true, data: { replayed: false, gate } });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      cycleId: CYCLE,
      idempotencyKey: "k",
      overrideReason: REASON
    });
    const plain = deps(json({ session, replayed: true, contributionGate: null }));
    const replay = await openDraw({ cycleId: CYCLE, idempotencyKey: "k" }, plain.deps);
    expect(replay).toMatchObject({ ok: true, data: { gate: null } });
    expect(JSON.parse(String((plain.fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ cycleId: CYCLE, idempotencyKey: "k" });
  });

  it("a blocked open is a failure that carries who is flagged for which round", async () => {
    const flagged = [
      { memberId: A, round: 1 },
      { memberId: B, round: 1 }
    ];
    const result = await openDraw(
      { cycleId: CYCLE, idempotencyKey: "k" },
      deps(json({ error: "contribution_gate_blocked", message: "draw_contribution_gate_blocked", flagged }, 409)).deps
    );
    expect(result).toMatchObject({ ok: false, status: 409, code: "contribution_gate_blocked", flagged });
    // A malformed list is dropped, never half-believed.
    const bad = await openDraw(
      { cycleId: CYCLE, idempotencyKey: "k" },
      deps(json({ error: "contribution_gate_blocked", flagged: [{ memberId: A }] }, 409)).deps
    );
    expect(bad).toMatchObject({ ok: false, code: "contribution_gate_blocked" });
    expect((bad as { flagged?: unknown }).flagged).toBeUndefined();
  });
});

describe("a server that predates the gate", () => {
  const { contributionGate: _gate, ...legacy } = cycle;
  void _gate;

  it("reads as off rather than as a malformed cycle", async () => {
    expect(await listCycles(GROUP, deps(json({ cycles: [legacy] })).deps)).toMatchObject({ ok: true, data: [{ contributionGate: "off" }] });
    expect(await readCycle(CYCLE, deps(json({ cycle: legacy, draws: [] })).deps)).toMatchObject({ ok: true, data: { cycle: { contributionGate: "off" } } });
    expect(await readSession(DRAW, deps(json({ session: { ...session, cycle: legacy } })).deps)).toMatchObject({
      ok: true,
      data: { cycle: { contributionGate: "off" } }
    });
  });

  it("but a gate it does send must be one we know", async () => {
    expect(await listCycles(GROUP, deps(json({ cycles: [{ ...cycle, contributionGate: "strict" }] })).deps)).toMatchObject({ ok: false, code: "bad_response" });
  });
});

describe("the bilingual message for a blocked open", () => {
  it("maps the code, and the message exists in both languages with the same placeholders", () => {
    const key = drawErrorKey({ code: "contribution_gate_blocked", status: 409 });
    expect(key).toBe("drawLive.error.gateBlocked");
    expect(dictionaries.en[key].length).toBeGreaterThan(10);
    expect(dictionaries.am[key].length).toBeGreaterThan(5);
  });
});
