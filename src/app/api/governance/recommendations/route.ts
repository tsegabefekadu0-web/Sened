import { createRecommendationsHandler } from "@/lib/governance/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/governance/recommendations` — bylaw and penalty recommendations.
 *
 * Pure and deterministic: same figures in, same clauses out. No session, no
 * credential, nothing persisted, and nothing written to the ledger. The
 * response is advisory (`advisoryOnly: true`) and its citations are the
 * bundled list; `GET /api/governance/citations` is what consults ScholarXIV.
 */
export const POST = createRecommendationsHandler();
