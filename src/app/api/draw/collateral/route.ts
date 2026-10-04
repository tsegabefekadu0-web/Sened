import { authenticateRead } from "@/lib/authRead";
import { readCycleCollateral } from "@/lib/draw/collateralServer";
import { drawCollateralQuerySchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `GET /api/draw/collateral?cycleId=<uuid>` — any active member of the cycle's
 * group. The DERIVED collateral view: each winner, the rounds they owe after their
 * win with a status derived on every read (`met`, `flagged`, `not_due`), their
 * guarantees with each guarantor's state, the reserve retained so far and how many
 * rounds are flagged. Nothing in it is stored as a status, and it is ADVISORY
 * ONLY: it never moves money. A cycle that is unknown and one in another group both
 * answer 403.
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
  const parsed = parse(drawCollateralQuerySchema, params);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    const result = await readCycleCollateral(auth.client, parsed.data.cycleId);
    if (result.status === "forbidden") {
      return jsonError("forbidden", 403);
    }
    return Response.json({ collateral: result.collateral }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("collateral_failed", 502);
  }
}
