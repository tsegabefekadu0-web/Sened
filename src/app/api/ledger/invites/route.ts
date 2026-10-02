import { authenticateRead } from "@/lib/authRead";
import { failureResponse, jsonError, jsonOk, queryParams, readJsonBody } from "@/lib/ledger/inviteHttp";
import { createInvite, listInvites } from "@/lib/ledger/invites";
import { ledgerGroupQuerySchema, ledgerInviteCreateRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * `POST /api/ledger/invites` — the group owner creates an invite link.
 * Body: `{ groupId, expiresInHours?: 1..720 (default 168), maxUses?: 1..50 (default 1) }`.
 *
 * 201 `{ inviteId, groupId, token, expiresAt, maxUses }`. This response is the
 * ONLY place the raw token ever appears; the database keeps just its SHA-256.
 * 403 for anyone who is not the group's owner, 404 for an unknown group.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parse(ledgerInviteCreateRequestSchema, body.body);
  if (!parsed.ok) return jsonError("invalid_request", 400);

  try {
    const result = await createInvite(auth.client, parsed.data);
    if (result.status !== "ok") return failureResponse(result);
    return jsonOk(
      {
        inviteId: result.inviteId,
        groupId: result.groupId,
        token: result.token,
        expiresAt: result.expiresAt,
        maxUses: result.maxUses
      },
      201
    );
  } catch {
    return jsonError("invite_failed", 502);
  }
}

/**
 * `GET /api/ledger/invites?groupId=` — the owner's invites for a group, with
 * status and use counts. Never a token or a hash. 403 for non-owners.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const parsed = parse(ledgerGroupQuerySchema, queryParams(request));
  if (!parsed.ok) return jsonError("invalid_request", 400);

  try {
    const result = await listInvites(auth.client, parsed.data.groupId);
    if (result.status !== "ok") return failureResponse(result);
    return jsonOk({ invites: result.invites });
  } catch {
    return jsonError("invite_failed", 502);
  }
}
