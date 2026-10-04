import { authenticateRead } from "@/lib/authRead";
import { readCycleContributions } from "@/lib/draw/contributionsServer";
import { drawContributionsQuerySchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `GET /api/draw/contributions?cycleId=<uuid>` — any active member of the cycle's group. The
 * DERIVED grid of every member by every round: `met`, `flagged` or `not_due`, derived on each read
 * from the ledger and the draw state (nothing is stored as a status), with the cycle's effective
 * contribution gate, its policy changes and the overrides that opened a draw despite a flag. A
 * cycle that is unknown and one in another group both answer 403.
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
  const parsed = parse(drawContributionsQuerySchema, params);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    const result = await readCycleContributions(auth.client, parsed.data.cycleId);
    if (result.status === "forbidden") {
      return jsonError("forbidden", 403);
    }
    return Response.json({ contributions: result.contributions }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("contributions_failed", 502);
  }
}
