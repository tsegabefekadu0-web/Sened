export type BankVerificationErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "STORAGE_FAILURE"
  | "STORAGE_UNAVAILABLE"
  | "INTEGRITY_FAILURE"
  | "INVALID_PROVIDER_RESULT"
  | "INVALID_BINDING";

export class BankVerificationError extends Error {
  readonly code: BankVerificationErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    code: BankVerificationErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = "BankVerificationError";
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function isBankVerificationError(error: unknown): error is BankVerificationError {
  return error instanceof BankVerificationError;
}
