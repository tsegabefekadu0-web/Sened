/**
 * Governance errors.
 *
 * `GovernanceError` is a caller mistake (bad engine input). `GovernanceProviderError`
 * is the ScholarXIV adapter failing; it mirrors `src/lib/voice/errors.ts` so an
 * unavailable provider is a named condition with a status code, never a swallowed
 * exception that turns into a fake "confirmed".
 */

export class GovernanceError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

export function isGovernanceError(error: unknown): error is GovernanceError {
  return error instanceof GovernanceError;
}

export const GOVERNANCE_PROVIDER_ERROR_CODES = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_REJECTED",
  "PROVIDER_UNAUTHORIZED"
] as const;

export type GovernanceProviderErrorCode = (typeof GOVERNANCE_PROVIDER_ERROR_CODES)[number];

const STATUS_BY_CODE: Readonly<Record<GovernanceProviderErrorCode, number>> = {
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_REJECTED: 422,
  // Our key was refused. That is our misconfiguration, not the caller's.
  PROVIDER_UNAUTHORIZED: 502
};

export class GovernanceProviderError extends Error {
  readonly code: GovernanceProviderErrorCode;
  readonly provider: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: GovernanceProviderErrorCode,
    provider: string,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "GovernanceProviderError";
    this.code = code;
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function isGovernanceProviderError(error: unknown): error is GovernanceProviderError {
  return error instanceof GovernanceProviderError;
}

export function retryAfterHeader(error: GovernanceProviderError): string | null {
  if (error.code !== "PROVIDER_RATE_LIMITED") {
    return null;
  }
  return String(Math.max(1, Math.min(86_400, Math.round(error.retryAfterSeconds ?? 1))));
}
