import { authenticateRead } from "@/lib/authRead";
import { failureResponse, jsonError, jsonOk, readJsonBody } from "@/lib/ledger/inviteHttp";
import { revokeInvite } from "@/lib/ledger/invites";
import { ledgerInviteRevokeRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * `POST /api/ledger/invites/revoke` — the group owner revokes an invite.
 * Body: `{ inviteId }`. 200 `{ inviteId, revoked: true, changed }`; idempotent.
 * 403 for non-owners, 404 for an unknown invite.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parse(ledgerInviteRevokeRequestSchema, body.body);
  if (!parsed.ok) return jsonError("invalid_request", 400);

  try {
    const result = await revokeInvite(auth.client, parsed.data.inviteId);
    if (result.status !== "ok") return failureResponse(result);
    return jsonOk({ inviteId: result.inviteId, revoked: true, changed: result.changed });
  } catch {
    return jsonError("invite_failed", 502);
  }
}
