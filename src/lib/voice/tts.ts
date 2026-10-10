import {
  ADDIS_MAX_AUDIO_DOWNLOAD_BYTES,
  ADDIS_PROVIDER_NAME,
  ADDIS_TTS_TIMEOUT_MS,
  ADDIS_TTS_URL,
  addisLanguageFor,
  addisRequest,
  asRecord,
  isTrustedAudioUrl,
  isValidAddisVoiceId,
  readAddisApiKey,
  readAddisTtsVoice,
  readBodyCapped,
  selectedProvider,
  type VoiceEnv
} from "./addisAi";
import { VoiceProviderError } from "./errors";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./types";

/**
 * Text-to-speech for the spoken balance sheet (`አድምጥ`, ROADMAP §3.2).
 *
 * Two kinds of implementation, one honest default:
 *
 * 1. `AddisAiTextToSpeechProvider` — a real HTTP client for Addis AI, the
 *    Amharic server lane, inert until `ADDIS_AI_API_KEY` is set.
 *    `VOICE_TTS_PROVIDER` selects the implementation.
 * 2. `UnconfiguredTextToSpeechProvider` — throws `PROVIDER_NOT_CONFIGURED`.
 *
 * Voxide is not here: it is the English voice assistant, a client-side widget.
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
const TTS_TIMEOUT_MS = ADDIS_TTS_TIMEOUT_MS;
const ADDIS_OUTPUT_FORMAT = "mp3_44100";

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
      "No text-to-speech provider is configured. Set ADDIS_AI_API_KEY to enable audio digests."
    );
  }
}

/**
 * Addis AI text-to-speech (`POST /api/v1/voice/generations`).
 *
 * The reply is metadata, not audio: a signed `audio_url` that this class then
 * fetches. That URL is untrusted input from an upstream body, so it is
 * fetched only when it is `https:` on `addisassistant.com` or a subdomain
 * (`isTrustedAudioUrl`), without the API key, without following redirects, and
 * with a size cap. Anything else fails closed. Every failure mode — timeout,
 * 429, non-2xx, empty or oversized audio — raises a named error rather than
 * returning silence.
 */
export class AddisAiTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = ADDIS_PROVIDER_NAME;
  readonly isConfigured = true;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: {
    readonly apiKey: string;
    readonly voice: string;
    readonly audioHosts?: readonly string[];
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  }) {
    if (!isValidAddisVoiceId(config.voice)) {
      throw new TypeError("Invalid Addis AI voice id");
    }
    this.apiKey = config.apiKey;
    this.voice = config.voice;
    this.audioHosts = config.audioHosts;
    this.timeoutMs = config.timeoutMs ?? TTS_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  readonly audioHosts?: readonly string[];

  /** Build from the environment, or `null` when it is not (validly) configured. */
  static fromEnv(env: VoiceEnv = process.env, fetchImpl?: typeof fetch): AddisAiTextToSpeechProvider | null {
    if (selectedProvider(env, "VOICE_TTS_PROVIDER") !== "addis-ai") {
      return null;
    }
    const apiKey = readAddisApiKey(env);
    const voice = readAddisTtsVoice(env);
    if (apiKey === null || voice === null) {
      return null;
    }
    const rawHosts = env.ADDIS_AI_AUDIO_HOSTS;
    const audioHosts = rawHosts ? rawHosts.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return new AddisAiTextToSpeechProvider({ apiKey, voice, audioHosts, fetchImpl });
  }

  async synthesize(
    request: TextToSpeechRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<TextToSpeechResult> {
    const languageCode = addisLanguageFor(request.language);
    if (!isVoiceLanguage(request.language) || languageCode === null) {
      throw new VoiceProviderError(
        "UNSUPPORTED_LANGUAGE",
        this.name,
        `Unsupported synthesis language: ${String(request.language)}`
      );
    }
    if (request.text.length === 0 || request.text.length > MAX_DIGEST_CHARS) {
      throw new VoiceProviderError("INVALID_REQUEST", this.name, "Digest text is empty or too long");
    }
    if (!isTtsSpeed(request.speed)) {
      throw new VoiceProviderError("INVALID_REQUEST", this.name, "Unsupported speaking speed");
    }

    const response = await addisRequest({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: ADDIS_TTS_URL,
      init: {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          text: request.text,
          voice_id: this.voice,
          language: languageCode,
          output_format: ADDIS_OUTPUT_FORMAT,
          voice_settings: { speed: request.speed },
          stream: false
        })
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
    const audioUrl = readAudioUrl(payload);
    if (!isTrustedAudioUrl(audioUrl, this.audioHosts)) {
      throw new VoiceProviderError("PROVIDER_REJECTED", this.name, "The speech provider returned no usable audio.");
    }

    // The signed link is its own credential: the API key is not sent to it.
    const audioResponse = await addisRequest({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: audioUrl,
      init: { method: "GET", headers: { accept: "audio/*" } },
      timeoutMs: this.timeoutMs,
      signal: options.signal
    });
    const audio = await readBodyCapped(audioResponse, ADDIS_MAX_AUDIO_DOWNLOAD_BYTES, this.name);
    if (audio.byteLength === 0) {
      throw new VoiceProviderError("PROVIDER_REJECTED", this.name, "The speech provider returned no usable audio.");
    }
    return { audioBase64: audio.toString("base64"), mimeType: readMimeType(payload), provider: this.name };
  }
}

/** `data.audio_url`, else `data.playback.url`. */
function readAudioUrl(payload: unknown): unknown {
  const data = asRecord(asRecord(payload)?.data);
  return data?.audio_url ?? asRecord(data?.playback)?.url;
}

/** Only an `audio/*` type from the metadata is trusted; otherwise MP3, which is what we asked for. */
function readMimeType(payload: unknown): string {
  const mime = asRecord(asRecord(payload)?.data)?.mime_type;
  return typeof mime === "string" && /^audio\/[a-z0-9.+-]{1,40}$/i.test(mime) ? mime.toLowerCase() : "audio/mpeg";
}

export function createTextToSpeechProvider(
  env: VoiceEnv = process.env,
  fetchImpl?: typeof fetch
): TextToSpeechProvider {
  return AddisAiTextToSpeechProvider.fromEnv(env, fetchImpl) ?? new UnconfiguredTextToSpeechProvider();
}

export function isTtsConfigured(env: VoiceEnv = process.env): boolean {
  return createTextToSpeechProvider(env).isConfigured;
}
