import { createScholarXivProvider } from "@/lib/governance/scholarxiv";
import { createCitationsHandler } from "@/lib/governance/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/governance/citations` — the bundled catalogue, plus a ScholarXIV
 * confirmation when (and only when) `SCHOLARXIV_API_URL` and
 * `SCHOLARXIV_API_KEY` are set. Unconfigured, it answers 200 with
 * `source: "bundled"`. Configured, it spends the server key and so needs a
 * verified session.
 */
export const GET = createCitationsHandler(() => createScholarXivProvider());
