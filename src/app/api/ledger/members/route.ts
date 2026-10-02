import { authenticateRead } from "@/lib/authRead";
import { failureResponse, jsonError, jsonOk, queryParams } from "@/lib/ledger/inviteHttp";
import { listMembers } from "@/lib/ledger/invites";
import { ledgerGroupQuerySchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * `GET /api/ledger/members?groupId=` — the active members of a group, for any
 * active member of it: `{ members: [{ userId, role, joinedAt, email }] }`.
 *
 * `email` is non-null only when the caller is the group's owner; other members
 * have not agreed to show their login address to each other. 403 for anyone who
 * is not an active member, whether or not the group exists.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const parsed = parse(ledgerGroupQuerySchema, queryParams(request));
  if (!parsed.ok) return jsonError("invalid_request", 400);

  try {
    const result = await listMembers(auth.client, parsed.data.groupId);
    if (result.status !== "ok") return failureResponse(result);
    return jsonOk({ members: result.members });
  } catch {
    return jsonError("invite_failed", 502);
  }
}
