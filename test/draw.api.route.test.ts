import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mocks.getUser } }))
}));

import {
  createCommitHandler,
  createPayoutHandler,
  createRevealHandler,
  createRoundHandler,
  createVerifyHandler
} from "@/lib/draw/routeHandlers";
import { DrawError } from "@/lib/draw/errors";
import type { DrawService } from "@/lib/draw/service";
import type { DrawErrorCode, DrawRound, DrawVerificationResult } from "@/lib/draw/types";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const cycleId = "77777777-7777-4777-8777-777777777777";
const drawId = "55555555-5555-4555-8555-555555555555";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const payoutAccount = "44444444-4444-4444-8444-444444444444";

const commitment = "a".repeat(64);
const rosterDigest = "b".repeat(64);
const memberDigest = "e".repeat(64);

const round: DrawRound = {
  drawId,
  groupId,
  cycleId,
  round: 1,
  commitment,
  protocolVersion: "v3",
  commitmentNonce: "nonce-abcdefghijklmnop",
  memberDigest,
  memberCommitments: [{ memberId: "00014444-4444-8444-8444-444444444444", sealed: "f".repeat(64) }],
  rosterDigest,
  participants: [
    {
      memberId: "00014444-4444-8444-8444-444444444444",
      displayName: "አባላት 1",
      contributionAmount: "5000.00",
      ticket: "c".repeat(64)
    }
  ],
  potAmount: "25000.00",
  totalRounds: 5,
  reserveRatioBps: 1000,
  committedBy: actorId,
  committedAt: "2026-09-26T09:00:00.000Z",
  idempotencyKey: "draw-commit-1",
  state: "committed",
  reveal: null,
  payout: null
};

const verification: DrawVerificationResult = {
  verified: true,
  codes: ["ok"],
  warnings: [],
  winnerMemberId: "00014444-4444-8444-8444-444444444444",
  winningTicket: "c".repeat(64),
  selectedIndex: 0,
  transcriptDigest: "d".repeat(64),
  recomputedCommitment: commitment,
  errors: []
};

function fakeService() {
  return {
    commit: vi.fn().mockResolvedValue({ round, replayed: false }),
    commitFromSession: vi.fn().mockResolvedValue({ round, replayed: false }),
    reveal: vi.fn().mockResolvedValue({
      round,
      risk: {
        drawId,
        round: 1,
        potAmount: "25000.00",
        payoutAmount: "22000.00",
        reserveAmount: "3000.00",
        reserveRatioBps: 1000,
        participantsAfterWin: 0,
        winnerOutstandingMinor: "2000000",
        reserveCoversDefaults: 1,
        reserveAdequate: true,
        notes: ["Base reserve is 2500.00 ETB."]
      },
      verification
    }),
    verify: vi.fn().mockResolvedValue({ round, verification, transcript: {} }),
    getRound: vi.fn().mockResolvedValue(round),
    listCycle: vi.fn().mockResolvedValue([]),
    postPayout: vi.fn().mockResolvedValue({
      round,
      ledgerEntry: { id: "e".repeat(8) + "-5555-4555-8555-555555555555", sequence: "1", entryHash: "f".repeat(64) },
      replayed: false
    })
  } as unknown as DrawService;
}

function request(body: unknown, bearer = "token", contentType = "application/json"): Request {
  return new Request("http://localhost/api/draw/commits", {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

/**
 * A commit names the draw and carries the treasurer's own entropy. Everything the
 * commitment covers (roster, pot, reserve, rounds, the sealed set) is read from
 * the database, so none of it is in the request.
 */
const commitBody = {
  drawId,
  idempotencyKey: "draw-commit-1"
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: actorId } },
    error: null
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/draw/commits", () => {
  it("401s without a Bearer token", async () => {
    const service = fakeService();
    const response = await createCommitHandler(() => service)(request(commitBody, ""));

    expect(response.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("503s when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const service = fakeService();

    const response = await createCommitHandler(() => service)(request(commitBody));

    expect(response.status).toBe(503);
  });

  it("503s when Supabase authentication is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("network unavailable"));
    const service = fakeService();

    const response = await createCommitHandler(() => service)(request(commitBody));

    expect(response.status).toBe(503);
  });

  it("403s when the database refuses the caller's role in the group", async () => {
    // Authorization is the caller's role in the group, enforced in SQL; the JWT
    // carries no role, so the route cannot and does not decide this itself.
    const service = fakeService();
    (service.commitFromSession as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(
      new DrawError("FORBIDDEN", "draw_forbidden")
    );

    const response = await createCommitHandler(() => service)(request(commitBody));

    expect(response.status).toBe(403);
    expect(service.commitFromSession).toHaveBeenCalledTimes(1);
  });

  it("REJECTS (400) a non-JSON content type before touching the service", async () => {
    const service = fakeService();

    const response = await createCommitHandler(() => service)(request(commitBody, "token", "text/plain"));

    expect(response.status).toBe(400);
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("REJECTS (400) a spoofed committedBy field", async () => {
    const service = fakeService();

    const response = await createCommitHandler(() => service)(
      request({ ...commitBody, committedBy: actorId, tenantId: groupId })
    );

    expect(response.status).toBe(400);
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("REJECTS (400) every field the server reads from the database instead of the client", async () => {
    // The roster, the pot (even as a number), the reserve, the rounds and above
    // all the sealed set are the database's, so a body that carries one is a
    // client believing it chose it.
    for (const smuggled of [
      { members: [{ memberId: actorId, displayName: "x", contributionAmount: "1.00" }] },
      { memberCommitments: [{ memberId: actorId, sealed: "e".repeat(64) }] },
      { potAmount: 25000 },
      { potAmount: "25000.00" },
      { reserveRatioBps: 1000 },
      { groupId, cycleId, round: 1, totalRounds: 5 }
    ]) {
      const service = fakeService();
      const response = await createCommitHandler(() => service)(request({ ...commitBody, ...smuggled }));

      expect(response.status).toBe(400);
      expect(service.commitFromSession).not.toHaveBeenCalled();
    }
  });

  it("REJECTS (400) a short seed rather than accepting weak entropy", async () => {
    const service = fakeService();

    const response = await createCommitHandler(() => service)(
      request({ ...commitBody, seed: "short" })
    );

    expect(response.status).toBe(400);
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("REJECTS (400) a commitment nonce equal to the seed", async () => {
    const service = fakeService();

    const response = await createCommitHandler(() => service)(
      request({ ...commitBody, seed: "same-value-0123456789", commitmentNonce: "same-value-0123456789" })
    );

    expect(response.status).toBe(400);
    expect(service.commitFromSession).not.toHaveBeenCalled();
  });

  it("creates a commitment and publishes the verification transcript", async () => {
    const service = fakeService();

    const response = await createCommitHandler(() => service)(request(commitBody));

    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.replayed).toBe(false);
    expect(payload.transcript).toMatchObject({ drawId, commitment, rosterDigest });
    const roundPayload = payload.round as Record<string, unknown>;
    expect(roundPayload).not.toHaveProperty("commitmentNonce");
    expect(roundPayload.participantCount).toBe(1);
  });

  it("never lets the client choose who committed the draw", async () => {
    const service = fakeService();

    await createCommitHandler(() => service)(request(commitBody));

    const call = (service.commitFromSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toMatchObject({ drawId, idempotencyKey: "draw-commit-1" });
    expect(call?.[1]).toEqual({ userId: actorId });
    expect((call?.[0] as Record<string, unknown>).committedBy).toBeUndefined();
    expect((call?.[0] as Record<string, unknown>).committedAt).toBeUndefined();
  });
});

describe("POST /api/draw/reveals", () => {
  const revealBody = {
    drawId,
    seed: "reveal-seed-abcdefghij",
    // No member nonces: the database holds the ones members released and hands
    // them over only together with a seed that matches the commitment.
    idempotencyKey: "draw-reveal-1"
  };

  it("REJECTS (400) memberNonces in the body: openings are the ones members released, never supplied", async () => {
    const service = fakeService();

    const response = await createRevealHandler(() => service)(
      request({
        ...revealBody,
        memberNonces: [{ memberId: "00014444-4444-8444-8444-444444444444", nonce: "member-nonce-0123456789" }]
      })
    );

    expect(response.status).toBe(400);
    expect(service.reveal).not.toHaveBeenCalled();
  });

  it("passes the seed and nothing else to the service", async () => {
    const service = fakeService();

    await createRevealHandler(() => service)(request(revealBody));

    const call = (service.reveal as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toEqual({ drawId, seed: "reveal-seed-abcdefghij" });
  });

  it("403s when the database refuses the caller's role in the group", async () => {
    const service = fakeService();
    (service.reveal as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(
      new DrawError("FORBIDDEN", "draw_forbidden")
    );

    const response = await createRevealHandler(() => service)(request(revealBody));

    expect(response.status).toBe(403);
    expect(service.reveal).toHaveBeenCalledTimes(1);
  });

  it("returns the winner, the risk assessment, and the transcript", async () => {
    const service = fakeService();

    const response = await createRevealHandler(() => service)(request(revealBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verification: { verified: true, winnerMemberId: "00014444-4444-8444-8444-444444444444" },
      risk: { payoutAmount: "22000.00", reserveAmount: "3000.00" }
    });
  });

  it.each([
    ["COMMITMENT_MISMATCH", 422],
    ["ALREADY_REVEALED", 409],
    ["REPEAT_WINNER", 409],
    ["NO_ELIGIBLE_PARTICIPANTS", 422],
    ["NOT_FOUND", 404],
    ["STORAGE_FAILURE", 502],
    ["UNAVAILABLE", 503]
  ])("maps %s to %i", async (code, status) => {
    const service = fakeService();
    (service.reveal as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(
      new DrawError(code as DrawErrorCode, `draw failed: ${code}`)
    );

    const response = await createRevealHandler(() => service)(request(revealBody));

    expect(response.status).toBe(status);
  });
});

describe("POST /api/draw/verify", () => {
  it("lets an ordinary member verify the draw", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: actorId } },
      error: null
    });
    const service = fakeService();

    const response = await createVerifyHandler(() => service)(request({ drawId }));

    expect(response.status).toBe(200);
    expect(service.verify).toHaveBeenCalledWith(drawId, { userId: actorId });
    // The browser re-checks every member opening, so the nonces are published
    // (empty until the reveal).
    expect(((await response.json()) as { memberNonces: unknown }).memberNonces).toEqual([]);
  });

  it("404s a malformed draw id rather than 400ing", async () => {
    const service = fakeService();

    const response = await createVerifyHandler(() => service)(request({ drawId: "not-a-uuid" }));

    expect(response.status).toBe(404);
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("401s without a Bearer token", async () => {
    const service = fakeService();

    const response = await createVerifyHandler(() => service)(request({ drawId }, ""));

    expect(response.status).toBe(401);
  });
});

describe("GET /api/draw/rounds/[roundId]", () => {
  it("returns the published round to any authenticated member", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: actorId } },
      error: null
    });
    const service = fakeService();

    const response = await createRoundHandler(() => service)(request({}, "token"), {
      params: { roundId: drawId }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ round: { drawId, state: "committed" } });
  });

  it("404s a malformed round id", async () => {
    const service = fakeService();

    const response = await createRoundHandler(() => service)(request({}, "token"), {
      params: { roundId: "nope" }
    });

    expect(response.status).toBe(404);
    expect(service.getRound).not.toHaveBeenCalled();
  });
});

describe("POST /api/draw/payouts", () => {
  const payoutBody = { drawId, cashAccountId: cashAccount, payoutAccountId: payoutAccount };

  it("403s when the database refuses the caller's role in the group", async () => {
    const service = fakeService();
    (service.postPayout as unknown as { mockRejectedValue: (e: unknown) => void }).mockRejectedValue(
      new DrawError("FORBIDDEN", "draw_forbidden")
    );

    const response = await createPayoutHandler(() => service)(request(payoutBody));

    expect(response.status).toBe(403);
    expect(service.postPayout).toHaveBeenCalledTimes(1);
  });

  it("REJECTS (400) a payout between the same account twice", async () => {
    const service = fakeService();

    const response = await createPayoutHandler(() => service)(
      request({ ...payoutBody, payoutAccountId: cashAccount })
    );

    expect(response.status).toBe(400);
    expect(service.postPayout).not.toHaveBeenCalled();
  });

  it("posts the payout and returns the ledger entry reference", async () => {
    const service = fakeService();

    const response = await createPayoutHandler(() => service)(request(payoutBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ledgerSequence: "1",
      ledgerEntryHash: "f".repeat(64),
      replayed: false
    });
  });
});

describe("draw route defaults", () => {
  it("503s rather than faking a draw when Supabase is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    // No service factory supplied: the production factory must fail closed.
    const response = await createCommitHandler()(request(commitBody));

    expect(response.status).toBe(503);
  });
});
