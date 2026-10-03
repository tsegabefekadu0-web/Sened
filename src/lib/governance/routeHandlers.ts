import "server-only";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { governanceRecommendationRequestSchema, parse } from "@/lib/validation";

import { listCitations } from "./citations";
import { recommendGovernance } from "./engine";
import { isGovernanceError, isGovernanceProviderError, retryAfterHeader } from "./errors";
import type { ScholarXivProvider } from "./scholarxiv";

/**
 * Route handlers for `/api/governance/**` (M5).
 *
 * Same conventions as `src/lib/voice/routeHandlers.ts`: `{ error, message? }`
 * bodies, `Cache-Control: no-store`, a content-type / length / size gate on
 * every body.
 *
 * ## Why the auth tiers differ
 *
 * - `recommendations` is a pure function over figures the caller just typed.
 *   There is no credential and nothing is persisted, so it needs no session
 *   (as with `/api/voice/extract`). It is advisory: it never writes the ledger.
 * - `citations` spends the server's ScholarXIV key, so with a key configured it
 *   requires a verified session. With no key it still answers 200 with the
 *   bundled list, so the UI can say "bundled" instead of guessing.
 */

const MAX_BODY_BYTES = 4_096;

export type ScholarXivProviderFactory = () => ScholarXivProvider;

export function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  return (
    contentType === "application/json" || (contentType !== undefined && contentType.startsWith("application/json;"))
  );
}

async function readJsonBody(
  request: Request,
  maxBytes: number
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }> {
  if (!isJsonRequest(request)) {
    return { ok: false };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
    return { ok: false };
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { ok: false };
  }
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false };
  }
}

async function requireSession(request: Request): Promise<Response | null> {
  const token = bearerToken(request);
  if (!token) {
    return jsonError("unauthorized", 401);
  }
  const supabase = getUserScopedClient(token);
  if (!supabase) {
    return jsonError("not_configured", 503);
  }
  const authResult = await supabase.auth.getUser().catch(() => null);
  if (!authResult) {
    return jsonError("auth_unavailable", 503);
  }
  if (authResult.error || !authResult.data.user) {
    return jsonError("unauthorized", 401);
  }
  return null;
}

function providerErrorResponse(error: unknown): Response {
  if (!isGovernanceProviderError(error)) {
    return jsonError("governance_provider_failed", 502);
  }
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  const retryAfter = retryAfterHeader(error);
  if (retryAfter !== null) {
    headers["Retry-After"] = retryAfter;
  }
  return Response.json(
    { error: error.code.toLowerCase(), provider: error.provider },
    { status: error.status, headers }
  );
}

export function createRecommendationsHandler(): (request: Request) => Promise<Response> {
  return async function recommendations(request: Request): Promise<Response> {
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return jsonError("bad_request", 400);
    }
    const parsed = parse(governanceRecommendationRequestSchema, body.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }
    try {
      const recommendation = recommendGovernance(parsed.data);
      return Response.json(
        { recommendation, citationSource: "bundled" },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (isGovernanceError(error)) {
        return jsonError("invalid_request", 400, error.message);
      }
      return jsonError("governance_failed", 500);
    }
  };
}

export function createCitationsHandler(
  providerFactory: ScholarXivProviderFactory
): (request: Request) => Promise<Response> {
  return async function citations(request: Request): Promise<Response> {
    const catalogue = listCitations();
    const provider = providerFactory();
    if (!provider.isConfigured) {
      return Response.json(
        { source: "bundled", scholarxivConfigured: false, citations: catalogue },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    const sessionFailure = await requireSession(request);
    if (sessionFailure !== null) {
      return sessionFailure;
    }
    try {
      const result = await provider.confirmCitations(catalogue);
      return Response.json(
        {
          source: "scholarxiv",
          scholarxivConfigured: true,
          collectionId: result.collectionId,
          citations: catalogue,
          confirmations: result.confirmations
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      return providerErrorResponse(error);
    }
  };
}
