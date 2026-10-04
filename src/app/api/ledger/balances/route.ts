import { authenticateRead } from "@/lib/authRead";
import { readLedgerBalances } from "@/lib/ledger";
import { ledgerBalancesQuerySchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

/**
 * `GET /api/ledger/balances?groupId=<uuid>` — every account's balance for a
 * group, computed in Postgres over the whole ledger (no entry cap):
 *
 *   { groupId, headSequence, entryCount,
 *     balances: [{ accountId, code, name, accountType, balance }] }
 *
 * `balance` is an exact decimal string, debit-positive (debits minus credits)
 * for every account type, so the `POT_CASH` asset reads positive and an income
 * account reads negative. `headSequence` is the newest entry the balances
 * include and `entryCount` how many entries that is; both come from the same
 * database snapshot as the balances. Read-only.
 *
 * Authorization is `get_ledger_balances_v1` under the caller's own JWT: any
 * active member of the group may read it. A group the caller cannot see is 404,
 * whether it is absent or merely not theirs.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }

  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = params[key];
    params[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  const parsed = parse(ledgerBalancesQuerySchema, params);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const balances = await readLedgerBalances(auth.client, parsed.data.groupId);
    if (balances === null) {
      return jsonError("not_found", 404);
    }
    return Response.json(balances, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return jsonError("storage_failure", 502);
  }
}
