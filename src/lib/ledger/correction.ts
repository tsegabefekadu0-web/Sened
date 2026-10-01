import { WIRE_ETB_DECIMAL_PATTERN } from "./money";
import type { LedgerEntryRequest, LedgerEntryType, LedgerPostingDirection, LedgerPostingInput } from "./types";

/** The part of a ledger entry a correction is built from. */
export interface CorrectionOriginal {
  readonly id: string;
  readonly groupId: string;
  readonly occurredAt: string;
  readonly entryType: LedgerEntryType;
  readonly postings: readonly LedgerPostingInput[];
}

export type CorrectionBuildErrorCode =
  | "no-postings"
  | "bad-posting"
  | "rationale"
  | "is-correction"
  | "bad-original";

export class CorrectionBuildError extends Error {
  constructor(readonly code: CorrectionBuildErrorCode) {
    super(code);
    this.name = "CorrectionBuildError";
  }
}

export const CORRECTION_RATIONALE_MIN = 10;
export const CORRECTION_RATIONALE_MAX = 1000;

function flip(direction: LedgerPostingDirection): LedgerPostingDirection {
  return direction === "debit" ? "credit" : "debit";
}

export interface BuildCorrectionInput {
  readonly original: CorrectionOriginal;
  readonly rationale: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

/**
 * The body of `POST /api/ledger/entries` for a pure reversal of `original`.
 *
 * Postings are the original's own, in order, with debit and credit swapped:
 * same accounts, same amounts, copied as the canonical strings the server sent
 * (never parsed through a float). The server re-derives this and refuses
 * anything that is not an exact reversal, so this is the only shape it accepts.
 *
 * `occurredAt` is `now`, or the original's own time when that is later: the
 * server refuses a correction that predates what it corrects, and a browser
 * clock behind the server's must not turn into a 422.
 *
 * Pure: the caller owns `idempotencyKey` and `now`, so a retry can rebuild the
 * identical body.
 */
export function buildCorrectionRequest(input: BuildCorrectionInput): LedgerEntryRequest {
  const { original, idempotencyKey } = input;
  if (original.entryType === "correction") {
    throw new CorrectionBuildError("is-correction");
  }
  const originalTime = new Date(original.occurredAt).getTime();
  if (!original.id || !original.groupId || Number.isNaN(originalTime) || Number.isNaN(input.now.getTime())) {
    throw new CorrectionBuildError("bad-original");
  }
  const rationale = input.rationale.trim();
  if (rationale.length < CORRECTION_RATIONALE_MIN || rationale.length > CORRECTION_RATIONALE_MAX) {
    throw new CorrectionBuildError("rationale");
  }
  if (original.postings.length < 2) {
    throw new CorrectionBuildError("no-postings");
  }
  const postings = original.postings.map((posting): LedgerPostingInput => {
    if (
      !posting.accountId ||
      (posting.direction !== "debit" && posting.direction !== "credit") ||
      !WIRE_ETB_DECIMAL_PATTERN.test(posting.amount) ||
      posting.amount === "0.00"
    ) {
      throw new CorrectionBuildError("bad-posting");
    }
    return { accountId: posting.accountId, direction: flip(posting.direction), amount: posting.amount };
  });

  return {
    groupId: original.groupId,
    idempotencyKey,
    occurredAt: new Date(Math.max(input.now.getTime(), originalTime)).toISOString(),
    entryType: "correction",
    correctsEntryId: original.id,
    rationale,
    postings
  };
}

/**
 * A fresh idempotency key for one correction attempt. Matches the server's
 * pattern: a letter or digit first, then letters, digits and . _ : -
 */
export function newCorrectionIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `corr-${cryptoApi.randomUUID()}`;
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `corr-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
