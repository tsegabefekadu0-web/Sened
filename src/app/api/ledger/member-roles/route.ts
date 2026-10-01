import { authenticateRead } from "@/lib/authRead";
import { setMemberRole } from "@/lib/ledger/memberRoles";
import { ledgerMemberRoleRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_024;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `POST /api/ledger/member-roles` — the group owner grants or clears the
 * treasurer role for another member. Body: `{ groupId, userId, role }` with
 * `role` either `"treasurer"` or `"member"`.
 *
 * Idempotent: asking for the role a member already has is a 200 with
 * `changed: false`. Who may do it is decided in SQL, under the caller's JWT:
 * 403 for anyone who is not the group's owner, 404 when the group does not
 * exist or the target is not an active member (an outsider is never created as
 * a member), 422 when the target is an owner. The JWT's own claims are ignored.
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

  const parsed = parse(ledgerMemberRoleRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const result = await setMemberRole(auth.client, parsed.data);
    switch (result.status) {
      case "ok":
        return Response.json(
          { groupId: result.groupId, userId: result.userId, role: result.role, changed: result.changed },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      case "forbidden":
        return jsonError("forbidden", 403);
      case "not-found":
        return jsonError("not_found", 404);
      case "invalid":
        return jsonError("unprocessable_member_role", 422);
    }
  } catch {
    return jsonError("member_role_failed", 502);
  }
}
