import { DRAW_ERROR_CODES, type DrawErrorCode, type DrawGateFlag } from "./types";

export class DrawError extends Error {
  readonly code: DrawErrorCode;
  /** For `CONTRIBUTION_GATE_BLOCKED`: who is flagged for which round, as the database reported it. */
  readonly flagged: readonly DrawGateFlag[] | undefined;

  constructor(code: DrawErrorCode, message: string, cause?: unknown, flagged?: readonly DrawGateFlag[]) {
    super(message);
    this.name = "DrawError";
    this.code = code;
    this.flagged = flagged;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isDrawError(error: unknown): error is DrawError {
  return error instanceof DrawError;
}

export function drawErrorCodes(): readonly DrawErrorCode[] {
  return DRAW_ERROR_CODES;
}

/**
 * Codes whose detail text (a database message, a ledger message, a parse complaint) is for the
 * server's logs and never for the client: it can name tables, functions or internal state. The
 * client gets the code alone and says it in the member's own language.
 */
const SERVER_ONLY_DETAIL_CODES: readonly DrawErrorCode[] = ["STORAGE_FAILURE", "INTEGRITY_FAILURE", "UNAVAILABLE"];

export function hasServerOnlyDetail(code: DrawErrorCode): boolean {
  return SERVER_ONLY_DETAIL_CODES.includes(code);
}

/** The message that may be sent to a client for this error, or undefined when only the code may be. */
export function publicDrawMessage(error: DrawError): string | undefined {
  return hasServerOnlyDetail(error.code) ? undefined : error.message;
}
