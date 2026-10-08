import {
  ADDIS_MAX_STT_BYTES,
  ADDIS_MAX_STT_DURATION_MS,
  ADDIS_PROVIDER_NAME,
  ADDIS_STT_TIMEOUT_MS,
  ADDIS_STT_URL,
  addisLanguageFor,
  addisRequest,
  asRecord,
  readAddisApiKey,
  selectedProvider,
  type VoiceEnv
} from "./addisAi";
import { VoiceProviderError } from "./errors";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./types";

/**
 * Speech-to-text provider interface.
 *
 * ## Why this file exists instead of a `setTimeout`
 *
 * No speech credential may be assumed to exist. The tempting shortcut — a timer
 * that resolves a hard-coded transcript — is a *lie* in the UI: it would let a
 * treasurer record a contribution that no bank ever confirmed, which is
 * precisely the failure mode `docs/IDEATION.md` §5.1 says this product exists
 * to remove.
 *
 * So the network call sits behind an interface with two kinds of
 * implementation:
 *
 * 1. `AddisAiSpeechToTextProvider` — a real HTTP client for Addis AI, the
 *    Amharic server lane, inert until `ADDIS_AI_API_KEY` is present.
 *    `VOICE_STT_PROVIDER` selects the implementation, so another vendor can be
 *    slotted into `createSpeechToTextProvider()` later.
 * 2. `UnconfiguredSpeechToTextProvider` — the default. It **throws**
 *    `PROVIDER_NOT_CONFIGURED`, exactly like A1's
 *    `UnconfiguredBankProviderAdapter`.
 *
 * There is no third option and no code path that fabricates a transcript.
 *
 * Voxide is not here: it is the English voice assistant, a client-side widget
 * with no server adapter.
 *
 * The browser-native Web Speech path lives in `recognition.ts` and is a
 * *different* thing: `SpeechRecognition` really does transcribe, on device,
 * with no credential. When a browser supports it, the app uses it and says so.
 */

/** Milliseconds before a provider call is abandoned. */
export const STT_TIMEOUT_MS = ADDIS_STT_TIMEOUT_MS;
/** Longest clip Addis AI accepts (60 s); equals the recorder's `MAX_CAPTURE_MS`. */
export const MAX_STT_DURATION_MS = ADDIS_MAX_STT_DURATION_MS;

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
  /** A rough duration hint; a value above `MAX_STT_DURATION_MS` is refused. */
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
      "No speech-to-text provider is configured. Set ADDIS_AI_API_KEY to enable Amharic transcription."
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
 * Addis AI speech-to-text client (`POST /api/v2/stt`, multipart upload).
 *
 * The browser's recording is sent exactly as captured (WebM/Opus from Chrome
 * and Firefox, M4A from Safari); Addis AI documents WAV, MP3, M4A and WebM,
 * 60 s and 10 MB at most. There is no server-side transcoding.
 *
 * Native `fetch` + `AbortSignal` only. Fail-closed: a missing credential, a
 * timeout, a 4xx/5xx, a malformed body or an empty transcript each raise a
 * named error. It never returns a partial or invented transcript.
 */
export class AddisAiSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = ADDIS_PROVIDER_NAME;
  readonly isConfigured = true;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: { readonly apiKey: string; readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch }) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? STT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /** Build from the environment, or `null` when it is not configured. */
  static fromEnv(env: VoiceEnv = process.env, fetchImpl?: typeof fetch): AddisAiSpeechToTextProvider | null {
    if (selectedProvider(env, "VOICE_STT_PROVIDER") !== "addis-ai") {
      return null;
    }
    const apiKey = readAddisApiKey(env);
    return apiKey === null ? null : new AddisAiSpeechToTextProvider({ apiKey, fetchImpl });
  }

  async transcribe(
    request: SpeechToTextRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<SpeechToTextResult> {
    const languageCode = addisLanguageFor(request.language);
    if (!isVoiceLanguage(request.language) || languageCode === null) {
      throw new VoiceProviderError(
        "UNSUPPORTED_LANGUAGE",
        this.name,
        `Unsupported transcription language: ${String(request.language)}`
      );
    }
    if (request.audioBase64.length === 0 || request.audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
      throw new VoiceProviderError("INVALID_AUDIO", this.name, "Audio payload is empty or too large");
    }
    if (request.durationMs !== undefined && request.durationMs > MAX_STT_DURATION_MS) {
      throw new VoiceProviderError("INVALID_AUDIO", this.name, "Recording is longer than the supported maximum");
    }
    if (!isSupportedAudioMimeType(request.mimeType)) {
      throw new VoiceProviderError("INVALID_AUDIO", this.name, "Unsupported audio container");
    }

    const bytes = Buffer.from(request.audioBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > ADDIS_MAX_STT_BYTES) {
      throw new VoiceProviderError("INVALID_AUDIO", this.name, "Audio payload is empty or too large");
    }

    const baseType = request.mimeType.split(";")[0].trim().toLowerCase();
    const form = new FormData();
    form.append("audio", new Blob([bytes], { type: baseType }), `audio.${extensionFor(baseType)}`);
    form.append(
      "request_data",
      new Blob([JSON.stringify({ language_code: languageCode })], { type: "application/json" })
    );

    // No `content-type` header: fetch derives it, with the multipart boundary.
    const response = await addisRequest({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: ADDIS_STT_URL,
      init: {
        method: "POST",
        headers: { "x-api-key": this.apiKey, accept: "application/json" },
        body: form
      },
      timeoutMs: this.timeoutMs,
      signal: options.signal
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceProviderError("PROVIDER_REJECTED", this.name, "The speech provider returned a malformed body.");
    }

    const transcript = readTranscript(payload);
    if (transcript === null) {
      // Silence, noise, or a language mismatch all land here: no words, no result.
      throw new VoiceProviderError("PROVIDER_REJECTED", this.name, "The speech provider recognised no speech.");
    }
    return {
      transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      confidence: readConfidence(payload),
      provider: this.name,
      detectedLanguage: "am"
    };
  }
}

/** The fail-closed default, returned whenever no real provider is configured. */
export function createSpeechToTextProvider(
  env: VoiceEnv = process.env,
  fetchImpl?: typeof fetch
): SpeechToTextProvider {
  return AddisAiSpeechToTextProvider.fromEnv(env, fetchImpl) ?? new UnconfiguredSpeechToTextProvider();
}

/** Is a *real* STT backend reachable? Used for honest empty states. */
export function isSttConfigured(env: VoiceEnv = process.env): boolean {
  return createSpeechToTextProvider(env).isConfigured;
}

function extensionFor(baseType: string): string {
  switch (baseType) {
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "m4a";
    default:
      return "webm";
  }
}

/** `data.transcription`; an error envelope or blank text is "no transcript". */
function readTranscript(payload: unknown): string | null {
  const root = asRecord(payload);
  if (root === null || root.status === "error") {
    return null;
  }
  const text = asRecord(root.data)?.transcription;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

/** Top-level `confidence`, else `data.confidence`, clamped to [0, 1]. */
function readConfidence(payload: unknown): number | null {
  const root = asRecord(payload);
  for (const value of [root?.confidence, asRecord(root?.data)?.confidence]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value));
    }
  }
  return null;
}
