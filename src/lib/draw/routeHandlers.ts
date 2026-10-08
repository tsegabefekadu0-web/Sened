import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import {
  drawCycleCreateRequestSchema,
  drawCycleIdSchema,
  drawCancelRequestSchema,
  drawCycleListQuerySchema,
  drawGateRequestSchema,
  drawNonceRequestSchema,
  drawOpenRequestSchema,
  drawSealRequestSchema,
  drawSessionIdSchema,
  parse
} from "@/lib/validation";

import { toVerificationTranscript } from "./canonical";
import { hasServerOnlyDetail, isDrawError, publicDrawMessage } from "./errors";
import { drawErrorStatus, type DrawActorContext } from "./repository";
import {
  drawCommitRequestSchema,
  drawIdSchema,
  drawPayoutRequestSchema,
  drawRevealRequestSchema
} from "./schemas";
import { createProductionDrawService } from "./server";
import type { DrawService } from "./service";
import type { DrawCancellation, DrawCycleRecord, DrawListEntry, DrawRound, DrawSessionView } from "./types";

/** Matches the banking lane: 8 KiB. A commit carries a roster, nothing larger. */
const MAX_BODY_BYTES = 8_192;

export type DrawServiceFactory = (client: SupabaseClient) => DrawService;
export type DrawRouteContext = {
  readonly params: { readonly roundId: string };
};

function productionFactory(client: SupabaseClient): DrawService {
  return createProductionDrawService(client);
}

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function jsonOk(payload: unknown, status: number): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

type AuthOutcome =
  | { readonly ok: true; readonly context: DrawActorContext }
  | { readonly ok: false; readonly response: Response };

/**
 * Bearer token → user-scoped client → verified user, in that order, for every
 * draw route. `getUserScopedClient` returning `null` is the honest "not
 * configured" signal and maps to 503 rather than 401, matching the ledger and
 * banking lanes.
 */
async function authenticate(request: Request): Promise<AuthOutcome> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, response: jsonError("unauthorized", 401) };
  }
  const supabase = getUserScopedClient(token);
  if (!supabase) {
    return { ok: false, response: jsonError("not_configured", 503) };
  }
  const authResult = await supabase.auth.getUser().catch(() => null);
  if (!authResult) {
    return { ok: false, response: jsonError("auth_unavailable", 503) };
  }
  if (authResult.error || !authResult.data.user) {
    return { ok: false, response: jsonError("unauthorized", 401) };
  }
  return { ok: true, context: { userId: authResult.data.user.id } };
}

async function readJsonBody(
  request: Request
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly response: Response }> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (!contentType || (contentType !== "application/json" && !contentType.startsWith("application/json;"))) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return { ok: false, response: jsonError("bad_request", 400) };
    }
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
}

/**
 * Projects a round for the wire.
 *
 * Two things are deliberately withheld from this response: the sealed
 * `commitmentNonce` is public but the round's internal fields stay out, and the
 * per-participant roster is summarised to a count. A member who needs the full
 * roster to verify gets it from `publicTranscript`, which publishes exactly the
 * values the verification actually consumes.
 */
function publicRound(round: DrawRound): Record<string, unknown> {
  return {
    drawId: round.drawId,
    groupId: round.groupId,
    cycleId: round.cycleId,
    round: round.round,
    commitment: round.commitment,
    rosterDigest: round.rosterDigest,
    participantCount: round.participants.length,
    potAmount: round.potAmount,
    totalRounds: round.totalRounds,
    reserveRatioBps: round.reserveRatioBps,
    state: round.state,
    committedBy: round.committedBy,
    committedAt: round.committedAt,
    revealed: round.reveal !== null,
    winnerMemberId: round.reveal?.winnerMemberId ?? null,
    payoutAmount: round.reveal?.payoutAmount ?? null,
    reserveAmount: round.reveal?.reserveAmount ?? null,
    payout: round.payout
  };
}

/** The published transcript. This is the whole point of the product. */
function publicTranscript(round: Parameters<typeof toVerificationTranscript>[0]): Record<string, unknown> {
  const transcript = toVerificationTranscript(round);
  return {
    drawId: transcript.drawId,
    groupId: transcript.groupId,
    cycleId: transcript.cycleId,
    round: transcript.round,
    commitment: transcript.commitment,
    protocolVersion: transcript.protocolVersion,
    rosterDigest: transcript.rosterDigest,
    commitmentNonce: transcript.commitmentNonce,
    seed: transcript.seed,
    participants: transcript.participants
  };
}

function mapError(error: unknown): Response {
  if (!isDrawError(error)) {
    // Unknown failure: the code only. The cause stays in the server log.
    console.error("draw: unexpected failure", error);
    return jsonError("draw_failed", 502);
  }
  if (hasServerOnlyDetail(error.code)) {
    // The detail (a database or ledger message) is for the server's log; the client gets the code.
    console.error(`draw: ${error.code}`, error.message, error.cause ?? "");
  }
  if (error.code === "CONTRIBUTION_GATE_BLOCKED") {
    // Who is flagged for which round travels with the refusal so the screen can say it.
    return Response.json(
      {
        error: error.code.toLowerCase(),
        message: error.message,
        flagged: (error.flagged ?? []).map((flag) => ({ memberId: flag.memberId, round: flag.round }))
      },
      { status: drawErrorStatus(error.code), headers: { "Cache-Control": "no-store" } }
    );
  }
  return jsonError(error.code.toLowerCase(), drawErrorStatus(error.code), publicDrawMessage(error));
}

/**
 * M4.1 step 1. Treasurer only: locks in the commitment over the roster, the
 * stored seals and the cycle's terms, all read from the database, *before* the
 * ceremony.
 */
export function createCommitHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;

    const parsed = parse(drawCommitRequestSchema, payload.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }

    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) {
      return jsonError("not_configured", 503);
    }

    try {
      const service = serviceFactory(supabase);
      const result = await service.commitFromSession(parsed.data, auth.context);
      return jsonOk(
        {
          round: publicRound(result.round),
          replayed: result.replayed,
          transcript: publicTranscript(result.round),
          // Present only when a new commitment was made: what the gate looked at.
          contributionGate: result.gate
            ? {
                policy: result.gate.policy,
                flagged: result.gate.flagged.map((flag) => ({ memberId: flag.memberId, round: flag.round })),
                overridden: result.gate.overridden,
                carriedOver: result.gate.carriedOver
              }
            : null
        },
        result.replayed ? 200 : 201
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/** M4.1 step 2. Treasurer only: publishes the seed, which fixes the winner. */
export function createRevealHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;

    const parsed = parse(drawRevealRequestSchema, payload.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }

    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) {
      return jsonError("not_configured", 503);
    }

    try {
      const service = serviceFactory(supabase);
      // The nonces are not in the request: the database holds the ones members
      // released and hands them over only together with a seed that matches.
      const result = await service.reveal(
        { drawId: parsed.data.drawId, seed: parsed.data.seed },
        auth.context
      );
      return jsonOk(
        {
          round: publicRound(result.round),
          verification: result.verification,
          risk: result.risk,
          transcript: publicTranscript(result.round)
        },
        200
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * M4.1 step 3 — deliberately **not** role-gated.
 *
 * A member who cannot open the ledger still has to be able to check the draw,
 * because the entire social contract of an Equb is that any member can verify
 * it. The response carries the published transcript and the recomputed winner.
 */
export function createVerifyHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;

    const parsed = parse(drawIdSchema, (payload.body as { drawId?: unknown } | null)?.drawId);
    if (!parsed.ok) {
      return jsonError("not_found", 404);
    }

    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) {
      return jsonError("not_configured", 503);
    }

    try {
      const service = serviceFactory(supabase);
      const result = await service.verify(parsed.data, auth.context);
      return jsonOk(
        {
          round: publicRound(result.round),
          verification: result.verification,
          transcript: result.transcript,
          // Published with the seed at reveal. A member's browser needs them to
          // check that every sealed contribution was opened honestly.
          memberNonces: result.round.reveal?.memberNonces ?? []
        },
        200
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Read a round's published state. Any authenticated group member. */
export function createRoundHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request, context: DrawRouteContext) => Promise<Response> {
  return async function get(request: Request, context: DrawRouteContext): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const parsed = parse(drawIdSchema, context.params.roundId);
    if (!parsed.ok) {
      return jsonError("not_found", 404);
    }

    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) {
      return jsonError("not_configured", 503);
    }

    try {
      const service = serviceFactory(supabase);
      const round = await service.getRound(parsed.data, auth.context);
      return jsonOk(
        { round: publicRound(round), transcript: publicTranscript(round) },
        200
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * Treasurer only. Posts the payout to the ledger via `LedgerService.append` and
 * links the returned entry back to the draw. Never fabricates a success: if
 * verification fails or the ledger refuses, the route returns the error.
 */
export function createPayoutHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;

    const parsed = parse(drawPayoutRequestSchema, payload.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }

    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) {
      return jsonError("not_configured", 503);
    }

    try {
      const service = serviceFactory(supabase);
      const result = await service.postPayout(parsed.data, auth.context);
      return jsonOk(
        {
          round: publicRound(result.round),
          payout: result.round.payout,
          ledgerEntryId: result.ledgerEntry.id,
          ledgerSequence: result.ledgerEntry.sequence,
          ledgerEntryHash: result.ledgerEntry.entryHash,
          replayed: result.replayed
        },
        result.replayed ? 200 : 201
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

// -- cycles, draws, and the member side of the ceremony ----------------------------

function publicCycle(cycle: DrawCycleRecord): Record<string, unknown> {
  return {
    cycleId: cycle.cycleId,
    groupId: cycle.groupId,
    name: cycle.name,
    contributionAmount: cycle.contributionAmount,
    potAmount: cycle.potAmount,
    totalRounds: cycle.totalRounds,
    reserveRatioBps: cycle.reserveRatioBps,
    startedAt: cycle.startedAt,
    closedAt: cycle.closedAt,
    createdAt: cycle.createdAt,
    roundsRevealed: cycle.roundsRevealed,
    roundsPaid: cycle.roundsPaid,
    nextRound: cycle.nextRound,
    contributionGate: cycle.contributionGate
  };
}

function publicListEntry(entry: DrawListEntry): Record<string, unknown> {
  return {
    drawId: entry.drawId,
    round: entry.round,
    state: entry.state,
    openedAt: entry.openedAt,
    committedAt: entry.committedAt,
    revealedAt: entry.revealedAt,
    winnerMemberId: entry.winnerMemberId,
    sealCount: entry.sealCount,
    nonceCount: entry.nonceCount,
    revealRequested: entry.revealRequested,
    superseded: entry.superseded,
    legacy: entry.legacy
  };
}

/** A cancellation is public to every member of the group: who, when, why, and who missed. */
function publicCancellation(entry: DrawCancellation): Record<string, unknown> {
  return {
    cancellationId: entry.cancellationId,
    drawId: entry.drawId,
    cycleId: entry.cycleId,
    round: entry.round,
    stage: entry.stage,
    reason: entry.reason,
    missedMembers: entry.missedMembers,
    deadlineAt: entry.deadlineAt,
    ownerDecision: entry.ownerDecision,
    cancelledBy: entry.cancelledBy,
    cancelledAt: entry.cancelledAt
  };
}

/**
 * A draw in progress, as members may see it. Explicit field copy on purpose: seal
 * HASHES, and per member only a boolean for "released a nonce". There is no field
 * a nonce could travel in.
 */
function publicSession(session: DrawSessionView): Record<string, unknown> {
  return {
    drawId: session.drawId,
    groupId: session.groupId,
    cycleId: session.cycleId,
    round: session.round,
    state: session.state,
    openedBy: session.openedBy,
    openedAt: session.openedAt,
    committedAt: session.committedAt,
    cycle: publicCycle(session.cycle),
    eligible: session.eligible,
    seals: session.seals.map((seal) => ({ memberId: seal.memberId, sealed: seal.sealed })),
    nonces: session.nonces.map((entry) => ({ memberId: entry.memberId, released: entry.released })),
    revealRequested: session.revealRequested,
    sealDeadline: session.sealDeadline,
    nonceDeadline: session.nonceDeadline,
    excluded: session.excluded,
    cancelsThisRound: session.cancelsThisRound,
    cancellation: session.cancellation === null ? null : publicCancellation(session.cancellation),
    // Public from the instant the reveal is opened, so any manager can finish a stalled draw.
    revealOpening:
      session.revealOpening === null
        ? null
        : {
            seed: session.revealOpening.seed,
            openedBy: session.revealOpening.openedBy,
            openedAt: session.revealOpening.openedAt
          }
  };
}

function searchParams(request: Request): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = params[key];
    params[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return params;
}

export type DrawCycleRouteContext = { readonly params: { readonly cycleId: string } };
export type DrawSessionRouteContext = { readonly params: { readonly drawId: string } };

/** Owner or treasurer creates a cycle for their group. The pot is computed by the database. */
export function createCycleCreateHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawCycleCreateRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).createCycle(parsed.data, auth.context);
      return jsonOk({ cycle: publicCycle(result.cycle), replayed: result.replayed }, result.replayed ? 200 : 201);
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * Owner or treasurer changes a cycle's contribution gate (`off` | `warn` | `block`). A reason of
 * 10..1000 characters is required and recorded with who and when, append-only. Asking for the policy
 * already in force is a 200 replay and records nothing.
 */
export function createGateSetHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawGateRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).setContributionGate(parsed.data, auth.context);
      return jsonOk({ cycle: publicCycle(result.cycle), replayed: result.replayed }, 200);
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Any member lists their group's cycles. */
export function createCycleListHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function get(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const parsed = parse(drawCycleListQuerySchema, searchParams(request));
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const cycles = await serviceFactory(supabase).listCycles(parsed.data.groupId, auth.context);
      return jsonOk({ cycles: cycles.map(publicCycle) }, 200);
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Any member reads one cycle and every draw in it, with each draw's state. */
export function createCycleReadHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request, context: DrawCycleRouteContext) => Promise<Response> {
  return async function get(request: Request, context: DrawCycleRouteContext): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const parsed = parse(drawCycleIdSchema, context.params.cycleId);
    if (!parsed.ok) return jsonError("not_found", 404);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const detail = await serviceFactory(supabase).getCycleDetail(parsed.data, auth.context);
      return jsonOk(
        {
          cycle: publicCycle(detail.cycle),
          draws: detail.draws.map(publicListEntry),
          cancellations: (detail.cancellations ?? []).map(publicCancellation)
        },
        200
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Owner or treasurer opens a draw (the server creates its id) for sealing. */
export function createDrawOpenHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawOpenRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).openDraw(parsed.data, auth.context);
      return jsonOk(
        {
          session: publicSession(result.session),
          replayed: result.replayed,
          // Present only when a new draw was opened: what the gate looked at.
          contributionGate: result.gate
            ? {
                policy: result.gate.policy,
                flagged: result.gate.flagged.map((flag) => ({ memberId: flag.memberId, round: flag.round })),
                overridden: result.gate.overridden
              }
            : null
        },
        result.replayed ? 200 : 201
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * Owner or treasurer cancels a draw whose members did not respond, with a reason. The database
 * decides whether the deadline has passed and whether the reveal was opened (it cannot be cancelled
 * then). 200 for a repeat (replay), 201 for a new cancellation.
 */
export function createCancelHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawCancelRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).cancelDraw(parsed.data, auth.context);
      return jsonOk(
        { cancellation: publicCancellation(result.cancellation), replayed: result.replayed },
        result.replayed ? 200 : 201
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Any member reads a draw in progress: seal hashes, and who has released a nonce (never the nonce). */
export function createSessionHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request, context: DrawSessionRouteContext) => Promise<Response> {
  return async function get(request: Request, context: DrawSessionRouteContext): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const parsed = parse(drawSessionIdSchema, context.params.drawId);
    if (!parsed.ok) return jsonError("not_found", 404);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const session = await serviceFactory(supabase).getSession(parsed.data, auth.context);
      return jsonOk({ session: publicSession(session) }, 200);
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * A member seals THEIR OWN nonce for an open draw. The body names no member: the
 * member is the signed-in user, resolved from their token here and from
 * `auth.uid()` again in the database. A body that carries a `memberId` is a 400.
 */
export function createSealHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawSealRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).submitSeal(parsed.data, auth.context);
      return jsonOk(
        { drawId: parsed.data.drawId, memberId: result.memberId, sealed: result.sealed, replaced: result.replaced },
        200
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

/**
 * A member releases THEIR OWN nonce, only after the commitment is published (the
 * database refuses it earlier). The response never contains the nonce.
 */
export function createNonceHandler(
  serviceFactory: DrawServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const payload = await readJsonBody(request);
    if (!payload.ok) return payload.response;
    const parsed = parse(drawNonceRequestSchema, payload.body);
    if (!parsed.ok) return jsonError("invalid_request", 400, parsed.message);
    const supabase = getUserScopedClient(bearerToken(request) ?? "");
    if (!supabase) return jsonError("not_configured", 503);
    try {
      const result = await serviceFactory(supabase).submitNonce(parsed.data, auth.context);
      return jsonOk({ drawId: parsed.data.drawId, memberId: result.memberId, released: true, replayed: result.replayed }, 200);
    } catch (error) {
      return mapError(error);
    }
  };
}
