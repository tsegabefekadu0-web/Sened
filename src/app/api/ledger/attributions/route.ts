import { authenticateRead } from "@/lib/authRead";
import { recordAttribution, supersedeAttribution, type AttributionResult } from "@/lib/ledger/attribution";
import {
  ledgerAttributionRecordRequestSchema,
  ledgerAttributionSupersedeRequestSchema,
  parse
} from "@/lib/validation";

export const runtime = "nodejs";

// Room for a 1000-character reason and a 280-character note in any script (up to 4 bytes a character), plus the ids.
const MAX_BODY_BYTES = 8_192;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function readBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType !== "application/json" && !contentType?.startsWith("application/json;")) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
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

/** Status and body for a database refusal. The error code is the database's own, so the screen can say why. */
function respond(result: AttributionResult, createdStatus: number): Response {
  switch (result.status) {
    case "ok":
      return Response.json(
        { attribution: result.attribution, replayed: result.replayed },
        { status: result.replayed ? 200 : createdStatus, headers: { "Cache-Control": "no-store" } }
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
}

/**
 * `POST /api/ledger/attributions` — an owner or treasurer records WHO PAID a
 * contribution that has no bank verification.
 * Body: `{ groupId, entryId, memberUserId, cycleId?, round?, channel?, note? }`
 * (`channel`: telebirr | cbe | awash | cash | other; `note`: 1..280 characters of plain
 * text, trimmed, no control characters; both optional, `null` = none). Strict: who is
 * recording is the session (a `recordedBy` is a 400), and `source` is never an
 * input. 201 on the first record, 200 when the same record is repeated.
 *
 * 403 for anyone who is not an owner/treasurer of the group (whether or not the
 * group exists). 404 `ledger_entry_not_found` for an entry that is not in this
 * group, `ledger_member_not_found` when the member is not active in it,
 * `ledger_cycle_not_found`. 422 `attribution_not_contribution`. 409
 * `attribution_bank_verified` (a verified bank receipt already names the payer:
 * it wins and cannot be overridden), `attribution_entry_corrected`,
 * `attribution_exists` (use PUT, with a reason).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }
  const payload = await readBody(request);
  if (!payload.ok) {
    return payload.response;
  }
  const parsed = parse(ledgerAttributionRecordRequestSchema, payload.body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    return respond(await recordAttribution(auth.client, parsed.data), 201);
  } catch {
    return jsonError("attribution_failed", 502);
  }
}

/**
 * `PUT /api/ledger/attributions` — correct an attribution. It is never an edit:
 * the database appends a NEW record that names the one it supersedes and carries
 * the `reason` (10..1000 characters), and the earlier records stay. Same body as
 * POST plus `reason`. Same roles and refusals, plus 404 `attribution_not_found`
 * (nothing to supersede) and 409 `attribution_unchanged`.
 */
export async function PUT(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }
  const payload = await readBody(request);
  if (!payload.ok) {
    return payload.response;
  }
  const parsed = parse(ledgerAttributionSupersedeRequestSchema, payload.body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    return respond(await supersedeAttribution(auth.client, parsed.data), 201);
  } catch {
    return jsonError("attribution_failed", 502);
  }
}
