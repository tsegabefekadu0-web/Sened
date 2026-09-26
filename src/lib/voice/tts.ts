import { VoiceProviderError } from "./errors";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./types";

/**
 * Text-to-speech for the spoken balance sheet (`አድምጥ`, ROADMAP §3.2).
 *
 * Two implementations, one honest default:
 *
 * 1. `VoxideTextToSpeechProvider` — a real HTTP client, inert until
 *    `VOXIDE_TTS_API_URL` / `VOXIDE_TTS_API_KEY` are set.
 * 2. `UnconfiguredTextToSpeechProvider` — throws `PROVIDER_NOT_CONFIGURED`.
 *
 * The browser-native `speechSynthesis` engine is *not* in this file: it lives in
 * `synthesis.ts` because it is a client-side concern with a different failure
 * mode (a missing Amharic voice pack). What matters is that the two never get
 * confused — see `docs/architecture/voice.md`.
 */

export const TTS_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type TtsSpeed = (typeof TTS_SPEEDS)[number];

export const DEFAULT_TTS_SPEED: TtsSpeed = 1;
export const MAX_DIGEST_CHARS = 4_000;

export function isTtsSpeed(value: unknown): value is TtsSpeed {
  return typeof value === "number" && (TTS_SPEEDS as readonly number[]).includes(value);
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return typeof value === "string" && (VOICE_LANGUAGES as readonly string[]).includes(value);
}

export interface TextToSpeechRequest {
  readonly text: string;
  readonly language: VoiceLanguage;
  readonly speed: TtsSpeed;
}

export interface TextToSpeechResult {
  /** Base64 audio, no data-URL prefix. */
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly provider: string;
}

export interface TextToSpeechProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  synthesize(request: TextToSpeechRequest, options?: { readonly signal?: AbortSignal }): Promise<TextToSpeechResult>;
}

export class UnconfiguredTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "unconfigured-tts";
  readonly isConfigured = false;

  async synthesize(): Promise<TextToSpeechResult> {
    throw new VoiceProviderError(
      "PROVIDER_NOT_CONFIGURED",
      this.name,
      "No text-to-speech provider is configured. Set VOXIDE_TTS_API_URL and VOXIDE_TTS_API_KEY to enable audio digests."
    );
  }
}

/**
 * Real HTTP synthesis. Native `fetch` + `AbortSignal` only; no dependency.
 * Every failure mode — missing config, timeout, 429, non-2xx, malformed body —
 * raises a named error rather than returning silence.
 */
export class VoxideTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "voxide-tts";
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
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    fetchImpl?: typeof fetch
  ): VoxideTextToSpeechProvider | null {
    const endpoint = env.VOXIDE_TTS_API_URL?.trim() ?? env.VOXIDE_API_URL?.trim();
    const apiKey = env.VOXIDE_TTS_API_KEY?.trim() ?? env.VOXIDE_API_KEY?.trim();
    if (!endpoint || !apiKey) {
      return null;
    }
    return new VoxideTextToSpeechProvider({ endpoint, apiKey, fetchImpl });
  }

  async synthesize(
    request: TextToSpeechRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<TextToSpeechResult> {
    if (!isVoiceLanguage(request.language)) {
      throw new VoiceProviderError(
        "UNSUPPORTED_LANGUAGE",
        this.name,
        `Unsupported synthesis language: ${String(request.language)}`
      );
    }
    if (request.text.length === 0 || request.text.length > MAX_DIGEST_CHARS) {
      throw new VoiceProviderError("INVALID_REQUEST", this.name, "Digest text is empty or too long");
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
          text: request.text,
          language: request.language,
          speed: request.speed
        }),
        signal: controller.signal,
        cache: "no-store"
      });
    } catch {
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

    const audio = readString(payload, AUDIO_PATHS);
    if (audio === null) {
      throw new VoiceProviderError(
        "PROVIDER_REJECTED",
        this.name,
        "The speech provider returned no audio."
      );
    }
    return {
      audioBase64: audio,
      mimeType: readString(payload, MIME_PATHS) ?? "audio/mpeg",
      provider: this.name
    };
  }
}

export function createTextToSpeechProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): TextToSpeechProvider {
  return VoxideTextToSpeechProvider.fromEnv(env, fetchImpl) ?? new UnconfiguredTextToSpeechProvider();
}

export function isTtsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const endpoint = env.VOXIDE_TTS_API_URL?.trim() ?? env.VOXIDE_API_URL?.trim();
  const apiKey = env.VOXIDE_TTS_API_KEY?.trim() ?? env.VOXIDE_API_KEY?.trim();
  return Boolean(endpoint && apiKey);
}

/**
 * Providers disagree about field names. Each entry is a *candidate path*,
 * tried in order; a path may be nested (`data.audio`).
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

const AUDIO_PATHS: readonly (readonly string[])[] = [
  ["audio"],
  ["audio_base64"],
  ["data", "audio"],
  ["result", "audio"]
];

const MIME_PATHS: readonly (readonly string[])[] = [
  ["mime_type"],
  ["mimeType"],
  ["content_type"],
  ["data", "mime_type"]
];
