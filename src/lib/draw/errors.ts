import { DRAW_ERROR_CODES, type DrawErrorCode } from "./types";

export class DrawError extends Error {
  readonly code: DrawErrorCode;

  constructor(code: DrawErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DrawError";
    this.code = code;
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
