export type LedgerErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_REQUEST"
  | "UNBALANCED"
  | "INVALID_CORRECTION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "UNAVAILABLE"
  | "STORAGE_FAILURE"
  | "INTEGRITY_FAILURE";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}
