/**
 * Voice provider errors.
 *
 * Mirrors the shape of `src/lib/banking/errors.ts` (A1's) so the two lanes
 * fail the same way: an unavailable provider is a named condition with a
 * status code, never an exception that gets swallowed into a fake success.
 */

export const VOICE_PROVIDER_ERROR_CODES = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_REJECTED",
  "INVALID_AUDIO",
  "UNSUPPORTED_LANGUAGE",
  "INVALID_REQUEST"
] as const;

export type VoiceProviderErrorCode = (typeof VOICE_PROVIDER_ERROR_CODES)[number];

const STATUS_BY_CODE: Readonly<Record<VoiceProviderErrorCode, number>> = {
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_REJECTED: 422,
  INVALID_AUDIO: 400,
  UNSUPPORTED_LANGUAGE: 422,
  INVALID_REQUEST: 400
};

export class VoiceProviderError extends Error {
  readonly code: VoiceProviderErrorCode;
  readonly provider: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: VoiceProviderErrorCode,
    provider: string,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "VoiceProviderError";
    this.code = code;
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function isVoiceProviderError(error: unknown): error is VoiceProviderError {
  return error instanceof VoiceProviderError;
}

/** `Retry-After` seconds → a header value, or `null` when not rate limited. */
export function retryAfterHeader(error: VoiceProviderError): string | null {
  if (error.code !== "PROVIDER_RATE_LIMITED") {
    return null;
  }
  // A rate-limited provider that says nothing about when to retry still gets a
  // header: a client that blocks indefinitely is worse than one that backs off.
  return String(Math.max(1, Math.min(86_400, Math.round(error.retryAfterSeconds ?? 1))));
}
