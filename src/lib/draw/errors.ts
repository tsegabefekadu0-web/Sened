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
