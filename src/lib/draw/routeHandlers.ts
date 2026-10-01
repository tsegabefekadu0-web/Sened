import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { parse } from "@/lib/validation";

import { toVerificationTranscript } from "./canonical";
import { isDrawError } from "./errors";
import { drawErrorStatus, type DrawActorContext } from "./repository";
import {
  drawCommitRequestSchema,
  drawIdSchema,
  drawPayoutRequestSchema,
  drawRevealRequestSchema
} from "./schemas";
import { createProductionDrawService } from "./server";
import type { DrawService } from "./service";
import type { DrawRound } from "./types";

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
    rosterDigest: transcript.rosterDigest,
    commitmentNonce: transcript.commitmentNonce,
    seed: transcript.seed,
    participants: transcript.participants
  };
}

function mapError(error: unknown): Response {
  if (!isDrawError(error)) {
    return jsonError("draw_failed", 502);
  }
  return jsonError(error.code.toLowerCase(), drawErrorStatus(error.code), error.message);
}

/**
 * M4.1 step 1. Treasurer only: locks in the commitment, the eligible roster, and
 * every member's ticket *before* the ceremony.
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
      const priorWinnerIds = await service
        .listCycle(parsed.data.cycleId, auth.context)
        .then((rounds) =>
          rounds
            .filter((round) => round.round < parsed.data.round && round.reveal !== null)
            .map((round) => round.reveal?.winnerMemberId ?? "")
        );
      const result = await service.commit(
        {
          ...parsed.data,
          members: parsed.data.members.map((entry) => ({ ...entry, status: entry.status ?? "active" })),
          priorWinnerIds
        },
        auth.context
      );
      return jsonOk(
        {
          round: publicRound(result.round),
          replayed: result.replayed,
          transcript: publicTranscript(result.round)
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
      const result = await service.reveal(
        {
          drawId: parsed.data.drawId,
          seed: parsed.data.seed,
          memberNonces: parsed.data.memberNonces
        },
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
          transcript: result.transcript
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
