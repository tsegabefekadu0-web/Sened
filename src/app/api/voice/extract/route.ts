import { createExtractHandler } from "@/lib/voice/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/voice/extract` — Amharic / Afaan Oromoo entity extraction.
 *
 * Pure, credential-free and deterministic: same text in, same
 * `ProvisionalContribution` out, forever. No session is required because
 * there is no secret in the request and nothing is persisted — the parser is
 * deliberately exercisable without any configuration, which is what makes it
 * the one part of M3 that can be proved in CI.
 *
 * The response always carries `status: "PROVISIONAL"` and `verified: false`.
 * The wire schema in `src/lib/voice/schemas.ts` declares them as literals, so
 * the route physically cannot report a voice-extracted record as anything
 * else.
 */
export const POST = createExtractHandler();
