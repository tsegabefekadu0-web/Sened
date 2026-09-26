import { VoiceProviderError } from "./errors";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./types";

/**
 * Speech-to-text and text-to-speech provider interfaces.
 *
 * ## Why this file exists instead of a `setTimeout`
 *
 * The Voxide credential is not available in this environment. The tempting
 * shortcut — a timer that resolves a hard-coded transcript — is a *lie* in the
 * UI: it would let a treasurer record a contribution that no bank ever
 * confirmed, which is precisely the failure mode `docs/IDEATION.md` §5.1 says
 * this product exists to remove.
 *
 * So the network call sits behind an interface with **two** implementations:
 *
 * 1. `VoxideSpeechToTextProvider` — a real HTTP client, inert until
 *    `VOXIDE_API_KEY` and `VOXIDE_API_URL` are present.
 * 2. `UnconfiguredSpeechToTextProvider` — the default. It **throws**
 *    `PROVIDER_NOT_CONFIGURED`, exactly like A1's
 *    `UnconfiguredBankProviderAdapter`.
 *
 * `createSpeechToTextProvider()` returns the second one unless the first is
 * genuinely configured. There is no third option and no code path that
 * fabricates a transcript.
 *
 * The browser-native Web Speech path lives in `recognition.ts` and is a
 * *different* thing: `SpeechRecognition` really does transcribe, on device,
 * with no credential. When a browser supports it, the app uses it and says so.
 */

/** Milliseconds before a provider call is abandoned. */
export const STT_TIMEOUT_MS = 8_000;
export const TTS_TIMEOUT_MS = 10_000;

export const AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4"
] as const;

/** Longest accepted base64 audio payload, in characters (~6 MB decoded). */
export const MAX_AUDIO_BASE64_CHARS = 8_388_608;
export const MAX_TRANSCRIPT_CHARS = 2_000;

export interface SpeechToTextRequest {
  /** Base64 audio payload, no data-URL prefix. */
  readonly audioBase64: string;
  /** The MIME type the recorder actually negotiated. */
  readonly mimeType: string;
  readonly language: VoiceLanguage;
  /** A rough duration hint, used to size provider timeouts. */
  readonly durationMs?: number;
}

export interface SpeechToTextResult {
  readonly transcript: string;
  /** Provider-reported confidence in [0, 1], or `null` when not reported. */
  readonly confidence: number | null;
  /** Which provider actually produced the transcript. */
  readonly provider: string;
  /** The language the provider says it detected, when it reports one. */
  readonly detectedLanguage: VoiceLanguage | null;
}

export interface SpeechToTextProvider {
  readonly name: string;
  /** `false` ⇒ every call rejects with `PROVIDER_NOT_CONFIGURED`. */
  readonly isConfigured: boolean;
  transcribe(request: SpeechToTextRequest, options?: { readonly signal?: AbortSignal }): Promise<SpeechToTextResult>;
}

/**
 * The fail-closed default. Present and typed, so callers are forced to handle
 * the failure rather than discovering it in production.
 */
export class UnconfiguredSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "unconfigured-stt";
  readonly isConfigured = false;

  async transcribe(): Promise<SpeechToTextResult> {
    throw new VoiceProviderError(
      "PROVIDER_NOT_CONFIGURED",
      this.name,
      "No speech-to-text provider is configured. Set VOXIDE_API_URL and VOXIDE_API_KEY to enable transcription."
    );
  }
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return typeof value === "string" && (VOICE_LANGUAGES as readonly string[]).includes(value);
}

export function isSupportedAudioMimeType(value: string): boolean {
  return (AUDIO_MIME_TYPES as readonly string[]).some(
    (candidate) => value === candidate || value.startsWith(candidate.split(";")[0])
  );
}

/**
 * A real HTTP speech-to-text client.
 *
 * Uses only native `fetch` + `AbortSignal` — **zero new dependencies**, per
 * AGENTWORK.md §4.3. Like A1's Links.et adapter it has an 800 ms-class
 * `fail-closed` posture: an absent credential, a timeout, a 429 or a malformed
 * body all raise a named error. It never returns a partial transcript.
 */
export class VoxideSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "voxide-stt";
  readonly isConfigured = true;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? STT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /** Build from the environment, or `null` when it is not configured. */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    fetchImpl?: typeof fetch
  ): VoxideSpeechToTextProvider | null {
    const endpoint = env.VOXIDE_API_URL?.trim();
    const apiKey = env.VOXIDE_API_KEY?.trim();
    if (!endpoint || !apiKey) {
      return null;
    }
    return new VoxideSpeechToTextProvider({ endpoint, apiKey, fetchImpl });
  }

  async transcribe(
    request: SpeechToTextRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<SpeechToTextResult> {
    if (!isVoiceLanguage(request.language)) {
      throw new VoiceProviderError(
        "UNSUPPORTED_LANGUAGE",
        this.name,
        `Unsupported transcription language: ${String(request.language)}`
      );
    }
    if (request.audioBase64.length === 0 || request.audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
      throw new VoiceProviderError("INVALID_AUDIO", this.name, "Audio payload is empty or too large");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          audio: request.audioBase64,
          mime_type: request.mimeType,
          language: request.language
        }),
        signal: controller.signal,
        cache: "no-store"
      });
    } catch {
      // A network fault and a timeout are the same thing to a treasurer
      // mid-meeting: the recording did not become text.
      throw new VoiceProviderError(
        options.signal?.aborted ? "PROVIDER_UNAVAILABLE" : "PROVIDER_TIMEOUT",
        this.name,
        "The speech provider did not respond."
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      throw new VoiceProviderError(
        "PROVIDER_RATE_LIMITED",
        this.name,
        "The speech provider is rate limited.",
        Number.isFinite(retryAfter) ? retryAfter : 1
      );
    }
    if (!response.ok) {
      throw new VoiceProviderError(
        "PROVIDER_UNAVAILABLE",
        this.name,
        `The speech provider returned HTTP ${response.status}.`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceProviderError(
        "PROVIDER_REJECTED",
        this.name,
        "The speech provider returned a malformed body."
      );
    }

    const transcript = readString(payload, TRANSCRIPT_PATHS);
    if (transcript === null || transcript.length === 0) {
      throw new VoiceProviderError(
        "PROVIDER_REJECTED",
        this.name,
        "The speech provider returned no transcript."
      );
    }

    const confidence = readNumber(payload, CONFIDENCE_PATHS);
    const detected = readString(payload, LANGUAGE_PATHS);
    return {
      transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)),
      provider: this.name,
      detectedLanguage: isVoiceLanguage(detected) ? detected : null
    };
  }
}

/** The fail-closed default, returned whenever Voxide is not configured. */
export function createSpeechToTextProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): SpeechToTextProvider {
  return VoxideSpeechToTextProvider.fromEnv(env, fetchImpl) ?? new UnconfiguredSpeechToTextProvider();
}

/** Is a *real* STT backend reachable? Used for honest empty states. */
export function isSttConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VOXIDE_API_URL?.trim() && env.VOXIDE_API_KEY?.trim());
}

/**
 * Providers disagree about field names. Each entry is a *candidate path*,
 * tried in order; a path may be nested (`result.text`). Guessing one shape
 * and failing on the rest would turn a working provider into a 502.
 */
function readString(payload: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    let cursor: unknown = payload;
    let found = true;
    for (const segment of path) {
      if (typeof cursor !== "object" || cursor === null) {
        found = false;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (found && typeof cursor === "string" && cursor.length > 0) {
      return cursor;
    }
  }
  return null;
}

function readNumber(payload: unknown, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    let cursor: unknown = payload;
    let found = true;
    for (const segment of path) {
      if (typeof cursor !== "object" || cursor === null) {
        found = false;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (found && typeof cursor === "number" && Number.isFinite(cursor)) {
      return cursor;
    }
  }
  return null;
}

const TRANSCRIPT_PATHS: readonly (readonly string[])[] = [
  ["transcript"],
  ["text"],
  ["result", "text"],
  ["data", "transcript"],
  ["results", "0", "transcript"]
];

const CONFIDENCE_PATHS: readonly (readonly string[])[] = [
  ["confidence"],
  ["score"],
  ["result", "confidence"]
];

const LANGUAGE_PATHS: readonly (readonly string[])[] = [
  ["language"],
  ["detected_language"],
  ["detectedLanguage"],
  ["result", "language"]
];
