import { authenticateRead } from "@/lib/authRead";
import { runGuaranteeAction } from "@/lib/draw/collateralServer";
import { drawGuaranteeRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_048;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `POST /api/draw/guarantees` — one endpoint, five actions, selected by `action`:
 *
 *   propose    owner/treasurer: `{ cycleId, winnerMemberId, guarantorMemberId }`
 *   accept     THE GUARANTOR, in their own session: `{ guaranteeId }`
 *   decline    THE GUARANTOR: `{ guaranteeId, reason? }`
 *   release    the guarantor or an owner/treasurer: `{ guaranteeId, reason }`
 *   supersede  owner/treasurer: `{ guaranteeId, newGuarantorMemberId, reason }`
 *
 * A guarantee without the guarantor's own consent is not a guarantee, so no body
 * names who is acting or who is answering: `accept` and `decline` take only the
 * guarantee's id and the database answers for `auth.uid()`; an owner or treasurer
 * who calls them for someone else gets 403. Strict: an extra field is a 400.
 *
 * Append-only: a release or supersede is a new event with a `reason` (10..1000
 * characters), never an edit. ADVISORY ONLY: no action debits anyone or writes the
 * ledger.
 *
 * 201 for a new proposal, 200 for everything else and for any replay. 403 for a
 * caller the database does not allow (and for an unknown id, which reads the same).
 * 404 `collateral_member_not_found` (the guarantor is not an active member). 409
 * `collateral_winner_not_found`, `collateral_no_remaining_rounds`,
 * `collateral_cycle_closed`, `collateral_exists`, `collateral_limit`,
 * `collateral_state_conflict`. 422 `collateral_invalid_request`.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType !== "application/json" && !contentType?.startsWith("application/json;")) {
    return jsonError("bad_request", 400);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    return jsonError("bad_request", 400);
  }
  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonError("bad_request", 400);
    }
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return jsonError("bad_request", 400);
  }
  const parsed = parse(drawGuaranteeRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    const result = await runGuaranteeAction(auth.client, parsed.data);
    switch (result.status) {
      case "ok":
        return Response.json(
          { guarantee: result.guarantee, superseded: result.superseded, replayed: result.replayed },
          {
            status: parsed.data.action === "propose" && !result.replayed ? 201 : 200,
            headers: { "Cache-Control": "no-store" }
          }
        );
      case "forbidden":
        return jsonError("forbidden", 403);
      case "not_found":
        return jsonError(result.code, 404);
      case "invalid":
        return jsonError(result.code, 422);
      case "conflict":
        return jsonError(result.code, 409);
    }
  } catch {
    return jsonError("collateral_failed", 502);
  }
}
