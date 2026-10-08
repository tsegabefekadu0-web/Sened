import { authenticateRead } from "@/lib/authRead";
import { setMemberAttire } from "@/lib/ledger/memberAttire";
import { ledgerMemberAttireRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 512;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `PUT /api/ledger/member-attire` — a member sets their own avatar attire.
 * Body: `{ groupId, attire }` with `attire` one of `"none"`, `"gabi"`,
 * `"netela"`. Nothing else is accepted (a `userId` in the body is a 400): whose
 * attire it is comes from the session, inside the database function, and a
 * member can only ever change their own.
 *
 * Idempotent: the same value again is a 200 with `changed: false`. 403 for
 * anyone who is not an active member of the group, whether or not it exists.
 * Other members read the value through `GET /api/ledger/members`.
 */
export async function PUT(request: Request): Promise<Response> {
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

  const parsed = parse(ledgerMemberAttireRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const result = await setMemberAttire(auth.client, parsed.data);
    switch (result.status) {
      case "ok":
        return Response.json(
          { groupId: result.groupId, attire: result.attire, changed: result.changed },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      case "forbidden":
        return jsonError("forbidden", 403);
      case "invalid":
        return jsonError("invalid_request", 400);
    }
  } catch {
    return jsonError("member_attire_failed", 502);
  }
}
