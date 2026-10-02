import { authenticateRead } from "@/lib/authRead";
import { failureResponse, jsonError, jsonOk, readJsonBody } from "@/lib/ledger/inviteHttp";
import { redeemInvite } from "@/lib/ledger/invites";
import { ledgerInviteRedeemRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * `POST /api/ledger/invites/redeem` — the signed-in caller joins a group with
 * an invite token. Body: `{ token }`.
 *
 * 200 `{ outcome: "joined" | "already_member", groupId, role }`. Idempotent for
 * an active member (no use is counted) and never changes an owner or
 * treasurer. 404 unknown token, 410 expired / revoked / used up. The token is
 * never logged or echoed, including in error bodies.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parse(ledgerInviteRedeemRequestSchema, body.body);
  if (!parsed.ok) return jsonError("invalid_request", 400);

  try {
    const result = await redeemInvite(auth.client, parsed.data.token);
    if (result.status !== "ok") return failureResponse(result);
    return jsonOk({ outcome: result.outcome, groupId: result.groupId, role: result.role });
  } catch {
    return jsonError("invite_failed", 502);
  }
}
