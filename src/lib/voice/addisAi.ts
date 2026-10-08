import { VoiceProviderError } from "./errors";
import type { VoiceLanguage } from "./types";

/**
 * Addis AI: configuration, request guard and response helpers for the Amharic
 * server-side speech lane (speech-to-text and text-to-speech).
 *
 * Server-side only. The key is read from `ADDIS_AI_API_KEY` (never a
 * `NEXT_PUBLIC_*` variable) and is only ever sent as the `x-api-key` header of
 * a request to `api.addisassistant.com`. Voxide is a different thing: the
 * English voice assistant, a client-side widget. See
 * `docs/architecture/voice-response.md`.
 *
 * Endpoints (docs.addisassistant.com, cross-checked against the `addisai@0.5.0`
 * SDK source):
 *
 * - STT: `POST /api/v2/stt`, multipart `audio` + `request_data`
 * - TTS: `POST /api/v1/voice/generations`, JSON. The reply is *metadata* with a
 *   signed `audio_url`; the audio itself is a second, separate GET.
 *
 * This module imports only *types* from the rest of the voice lane so that
 * `stt.ts` and `tts.ts` can import it without a cycle.
 */

export type VoiceEnv = Record<string, string | undefined>;

export const ADDIS_PROVIDER_NAME = "addis-ai";
export const ADDIS_BASE_URL = "https://api.addisassistant.com";
export const ADDIS_STT_URL = `${ADDIS_BASE_URL}/api/v2/stt`;
export const ADDIS_TTS_URL = `${ADDIS_BASE_URL}/api/v1/voice/generations`;
export const DEFAULT_ADDIS_TTS_VOICE = "am-hamen";

/** Documented STT limits: 60 seconds and 10 MB. */
export const ADDIS_MAX_STT_DURATION_MS = 60_000;
export const ADDIS_MAX_STT_BYTES = 10 * 1024 * 1024;
/** A synthesized digest larger than this is not a digest; refuse rather than relay it. */
export const ADDIS_MAX_AUDIO_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export const ADDIS_STT_TIMEOUT_MS = 30_000;
export const ADDIS_TTS_TIMEOUT_MS = 60_000;

/** Our app language code -> Addis AI code. `null` means no documented support. */
const CODE_BY_LANGUAGE: Readonly<Record<VoiceLanguage, string | null>> = {
  am: "am",
  // Addis AI documents only `am` for STT. Say so rather than transcribing
  // Oromo audio with an Amharic model and returning plausible nonsense.
  om: null
};

export function addisLanguageFor(language: unknown): string | null {
  if (typeof language !== "string") {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(CODE_BY_LANGUAGE, language)
    ? CODE_BY_LANGUAGE[language as VoiceLanguage]
    : null;
}

/** Trimmed value, or `undefined` when unset, empty or whitespace. */
export function envValue(env: VoiceEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readAddisApiKey(env: VoiceEnv): string | null {
  return envValue(env, "ADDIS_AI_API_KEY") ?? null;
}

/**
 * Which implementation a direction should use. Unset means Addis AI (the only
 * one today); any other value selects nothing, so a typo fails closed instead
 * of silently routing to a different vendor.
 */
export function selectedProvider(
  env: VoiceEnv,
  name: "VOICE_STT_PROVIDER" | "VOICE_TTS_PROVIDER"
): "addis-ai" | null {
  const value = envValue(env, name);
  if (value === undefined) {
    return "addis-ai";
  }
  return value.toLowerCase() === "addis-ai" ? "addis-ai" : null;
}

const VOICE_ID_PATTERN = /^[a-z]{2}-[a-z0-9-]{1,40}$/;

export function isValidAddisVoiceId(value: unknown): value is string {
  return typeof value === "string" && VOICE_ID_PATTERN.test(value);
}

/** Default voice when unset; `null` when set to something that is not a plain id token. */
export function readAddisTtsVoice(env: VoiceEnv): string | null {
  const value = envValue(env, "ADDIS_AI_TTS_VOICE");
  if (value === undefined) {
    return DEFAULT_ADDIS_TTS_VOICE;
  }
  return isValidAddisVoiceId(value) ? value : null;
}

/**
 * The signed audio link is data from an upstream response, so it is untrusted:
 * fetching it blindly would let a bad response aim our server at any host.
 * Only `https:` on `addisassistant.com` or a true subdomain of it passes. The
 * hostname is taken from the parsed URL, so `https://addisassistant.com@evil.com`
 * (host `evil.com`) and `evil-addisassistant.com` both fail.
 */
export function isTrustedAudioUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.port !== "" && url.port !== "443") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host === "addisassistant.com" || host.endsWith(".addisassistant.com");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One guarded HTTP call. Timeout via `AbortController`; a network fault, a
 * timeout and a caller abort are all named errors. Redirects are refused, so a
 * 3xx can never carry the request (or its key) to another host. Nothing here
 * logs, and no upstream body is ever copied into an error message.
 */
export async function addisRequest(args: {
  readonly provider: string;
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly init: Omit<RequestInit, "signal" | "redirect" | "cache">;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);
  const onAbort = (): void => controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });

  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      ...args.init,
      signal: controller.signal,
      redirect: "error",
      cache: "no-store"
    });
  } catch {
    throw new VoiceProviderError(
      args.signal?.aborted && !timedOut ? "PROVIDER_UNAVAILABLE" : "PROVIDER_TIMEOUT",
      args.provider,
      "The speech provider did not respond."
    );
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }

  if (response.ok) {
    return response;
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    throw new VoiceProviderError(
      "PROVIDER_RATE_LIMITED",
      args.provider,
      "The speech provider is rate limited.",
      Number.isFinite(retryAfter) ? retryAfter : 1
    );
  }
  // 400/413/415/422 mean Addis AI refused this input.
  if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) {
    throw new VoiceProviderError("PROVIDER_REJECTED", args.provider, "The speech provider rejected the request.");
  }
  // 402 is "insufficient credits": ours to top up, not the client's to fix.
  // 401/403 mean *our* key is wrong. Neither is something a user can act on.
  if (response.status === 402) {
    throw new VoiceProviderError("PROVIDER_UNAVAILABLE", args.provider, "The speech provider has no remaining credit.");
  }
  throw new VoiceProviderError(
    "PROVIDER_UNAVAILABLE",
    args.provider,
    `The speech provider returned HTTP ${response.status}.`
  );
}

/** Read a response body, refusing anything over `maxBytes` (header and stream both checked). */
export async function readBodyCapped(response: Response, maxBytes: number, provider: string): Promise<Buffer> {
  const tooBig = (): VoiceProviderError =>
    new VoiceProviderError("PROVIDER_REJECTED", provider, "The speech provider returned no usable audio.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof VoiceProviderError) {
      throw error;
    }
    throw new VoiceProviderError("PROVIDER_REJECTED", provider, "The speech provider returned a malformed body.");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
