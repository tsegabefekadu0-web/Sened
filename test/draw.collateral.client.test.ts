import { describe, expect, it, vi } from "vitest";

import { drawErrorKey, readCollateral, sendGuarantee } from "@/lib/draw/clientDraw";
import { dictionaries } from "@/lib/i18n";

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const G = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";

const guarantee = {
  guaranteeId: G,
  cycleId: CYCLE,
  winnerMemberId: A,
  guarantorMemberId: B,
  proposedBy: A,
  proposedAt: T0,
  state: "proposed",
  stateAt: T0,
  stateBy: A,
  acceptedAt: null,
  reason: null,
  successorGuaranteeId: null
};
const view = {
  cycleId: CYCLE,
  groupId: GROUP,
  totalRounds: 3,
  contributionAmount: "100.00",
  potAmount: "300.00",
  reserveRatioBps: 1000,
  startedAt: T0,
  nextRound: 2,
  eligibleCount: 2,
  reserveRetained: "30.00",
  flaggedCount: 0,
  winners: []
};

function deps(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { deps: { getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch }, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readCollateral", () => {
  it("GETs the cycle's derived view with the Bearer token and validates it", async () => {
    const { deps: d, fetchImpl } = deps(json({ collateral: view }));
    const result = await readCollateral(CYCLE, d);
    expect(result).toMatchObject({ ok: true, data: { cycleId: CYCLE, reserveRetained: "30.00" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/draw/collateral?cycleId=${CYCLE}`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("refuses a malformed view rather than guessing, and passes server errors on", async () => {
    expect(await readCollateral(CYCLE, deps(json({ collateral: { cycleId: CYCLE } })).deps)).toMatchObject({ ok: false, code: "bad_response" });
    expect(await readCollateral(CYCLE, deps(json({ error: "forbidden" }, 403)).deps)).toMatchObject({ ok: false, status: 403, code: "forbidden" });
    expect(await readCollateral(CYCLE, deps(new Error("offline")).deps)).toMatchObject({ ok: false, code: "network" });
  });
});

describe("sendGuarantee", () => {
  it("POSTs each command as given, and an accept carries only the guarantee id", async () => {
    const { deps: d, fetchImpl } = deps(json({ guarantee, replayed: false }));
    const result = await sendGuarantee({ action: "accept", guaranteeId: G }, d);
    expect(result).toMatchObject({ ok: true, data: { replayed: false, guarantee: { guaranteeId: G, state: "proposed" } } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/draw/guarantees");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ action: "accept", guaranteeId: G });
  });

  it("refuses a response that is not a guarantee", async () => {
    expect(await sendGuarantee({ action: "accept", guaranteeId: G }, deps(json({ guarantee: { guaranteeId: G }, replayed: false })).deps)).toMatchObject({
      ok: false,
      code: "bad_response"
    });
  });

  it("carries the server's refusal code", async () => {
    expect(await sendGuarantee({ action: "accept", guaranteeId: G }, deps(json({ error: "collateral_state_conflict" }, 409)).deps)).toMatchObject({
      ok: false,
      status: 409,
      code: "collateral_state_conflict"
    });
  });
});

describe("drawErrorKey for the collateral refusals", () => {
  it("has a message, in both languages, for every code the routes can answer", () => {
    for (const code of [
      "collateral_winner_not_found",
      "collateral_no_remaining_rounds",
      "collateral_cycle_closed",
      "collateral_exists",
      "collateral_limit",
      "collateral_state_conflict",
      "collateral_member_not_found",
      "collateral_invalid_request"
    ]) {
      const key = drawErrorKey({ code, status: 409 });
      expect(key, code).not.toBe("drawLive.error.generic");
      expect(dictionaries.en[key], code).toBeTruthy();
      expect(dictionaries.am[key], code).toBeTruthy();
    }
  });
});
