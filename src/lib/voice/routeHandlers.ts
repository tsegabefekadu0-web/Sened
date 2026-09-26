import "server-only";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { parse } from "@/lib/validation";
import { isVoiceProviderError, retryAfterHeader, VoiceProviderError } from "./errors";
import { parseContributionUtterance } from "./parser";
import {
  digestRequestSchema,
  extractionRequestSchema,
  provisionalContributionSchema,
  transcriptionRequestSchema
} from "./schemas";
import { isSttConfigured, type SpeechToTextProvider } from "./stt";
import { isTtsConfigured, isTtsSpeed, type TextToSpeechProvider } from "./tts";
import { VOICE_LANGUAGES } from "./types";

/**
 * Route handlers for `/api/voice/**`.
 *
 * Mirrors A1's `src/lib/banking/routeHandlers.ts` conventions — same
 * `jsonError` shape, same `Cache-Control: no-store`, same
 * content-type/length/body-size gates — without touching that file, which
 * AGENTWORK.md §3 assigns to A1.
 *
 * ## Why the auth tiers differ
 *
 * - `transcribe` / `speak` spend a **metered third-party credential** on the
 *   caller's behalf, so they require a verified session like A1's bank routes.
 * - `capabilities` returns booleans and nothing else. Gating it would force
 *   the UI to guess, and a guessed "configured" is worse than a 401.
 * - `extract` is a **pure function** over text the caller already typed, with
 *   no persistence and no credential. Requiring a session would make the
 *   credential-free part of M3 impossible to prove, and would add nothing:
 *   the input is not a secret the caller does not already have.
 */

const MAX_TRANSCRIBE_BODY_BYTES = 12_000_000;
const MAX_SMALL_BODY_BYTES = 8_192;

export type SttProviderFactory = () => SpeechToTextProvider;
export type TtsProviderFactory = () => TextToSpeechProvider;

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

/** Reject a body that is the wrong type, oversized, or not JSON. */
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

/** Map a provider fault onto the repo's status conventions. */
function providerErrorResponse(error: unknown): Response {
  if (!isVoiceProviderError(error)) {
    return jsonError("voice_provider_failed", 502);
  }
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  const retryAfter = retryAfterHeader(error);
  if (retryAfter !== null) {
    headers["Retry-After"] = retryAfter;
  }
  return Response.json({ error: error.code.toLowerCase(), provider: error.provider }, {
    status: error.status,
    headers
  });
}

/**
 * Verify a Bearer session. Mirrors A1's order: token → client → user.
 * Returns `null` on success, or the response to send.
 */
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

export function createTranscribeHandler(
  providerFactory: SttProviderFactory
): (request: Request) => Promise<Response> {
  return async function transcribe(request: Request): Promise<Response> {
    const sessionFailure = await requireSession(request);
    if (sessionFailure !== null) {
      return sessionFailure;
    }
    const body = await readJsonBody(request, MAX_TRANSCRIBE_BODY_BYTES);
    if (!body.ok) {
      return jsonError("bad_request", 400);
    }
    const parsed = parse(transcriptionRequestSchema, body.body);    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }

    const provider = providerFactory();
    if (!provider.isConfigured) {
      // Fail closed *before* touching the network, and say why.
      return jsonError("not_configured", 503, "No speech-to-text provider is configured.");
    }

    try {
      const result = await provider.transcribe({
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        durationMs: parsed.data.durationMs
      });
      return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return providerErrorResponse(error);
    }
  };
}

export function createSpeakHandler(
  providerFactory: TtsProviderFactory
): (request: Request) => Promise<Response> {
  return async function speak(request: Request): Promise<Response> {
    const sessionFailure = await requireSession(request);
    if (sessionFailure !== null) {
      return sessionFailure;
    }
    const body = await readJsonBody(request, MAX_SMALL_BODY_BYTES);
    if (!body.ok) {
      return jsonError("bad_request", 400);
    }
    const parsed = parse(digestRequestSchema, body.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }
    if (!isTtsSpeed(parsed.data.speed)) {
      return jsonError("invalid_request", 400, "Invalid fields: speed");
    }

    const provider = providerFactory();
    if (!provider.isConfigured) {
      return jsonError("not_configured", 503, "No text-to-speech provider is configured.");
    }

    try {
      const result = await provider.synthesize({
        text: parsed.data.text,
        language: parsed.data.language,
        speed: parsed.data.speed
      });
      return Response.json(
        {
          audioBase64: result.audioBase64,
          mimeType: result.mimeType,
          provider: result.provider
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      return providerErrorResponse(error);
    }
  };
}

/**
 * Pure parser over HTTP.
 *
 * No credential, no session, no persistence, no I/O. This is the one part of
 * M3 a reviewer can exercise without any configuration at all — and the reason
 * the parser is worth having.
 */
export function createExtractHandler(): (request: Request) => Promise<Response> {
  return async function extract(request: Request): Promise<Response> {
    const body = await readJsonBody(request, MAX_SMALL_BODY_BYTES);
    if (!body.ok) {
      return jsonError("bad_request", 400);
    }
    const parsed = parse(extractionRequestSchema, body.body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }

    const contribution = parseContributionUtterance(parsed.data.transcript);
    // Fail loudly if the parser ever produces something the wire schema
    // rejects: a route that silently drops fields is worse than one that 500s.
    const contributionWire = provisionalContributionSchema.parse(contribution);

    return Response.json(
      {
        contribution: contributionWire,
        warnings: contribution.issues.filter(
          (issue) =>
            !["UNPARSEABLE", "NO_AMOUNT", "AMBIGUOUS_AMOUNT", "CURRENCY_MISMATCH", "NO_CHANNEL", "AMBIGUOUS_CHANNEL"].includes(
              issue
            )
        )
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  };
}

/**
 * Honest empty state. Two booleans, no secrets, no user data — so the UI can
 * say "not configured" instead of failing mid-meeting.
 */
export function createCapabilitiesHandler(
  sttFactory: SttProviderFactory,
  ttsFactory: TtsProviderFactory
): (request: Request) => Promise<Response> {
  return async function capabilities(): Promise<Response> {
    const stt = sttFactory();
    const tts = ttsFactory();
    return Response.json(
      {
        sttProvider: stt.name,
        sttConfigured: stt.isConfigured && isSttConfigured(),
        ttsProvider: tts.name,
        ttsConfigured: tts.isConfigured && isTtsConfigured(),
        languages: [...VOICE_LANGUAGES]
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  };
}

export { VoiceProviderError };
