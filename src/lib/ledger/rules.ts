import { LedgerError } from "./errors";
import { formatEtbAmount, formatEtbMinorUnits, toEtbMinorUnits } from "./money";
import {
  LEDGER_ENTRY_TYPES,
  LEDGER_POSTING_DIRECTIONS,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryType,
  type LedgerPostingDirection,
  type LedgerPostingInput
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_POSTINGS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new LedgerError("INVALID_REQUEST", "Request contains unsupported fields");
  }
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new LedgerError("INVALID_REQUEST", `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function normalizeOccurredAt(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) {
    throw new LedgerError("INVALID_REQUEST", "occurredAt must be an ISO timestamp");
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new LedgerError("INVALID_REQUEST", "occurredAt must be an ISO timestamp");
  }
  const year = timestamp.getUTCFullYear();
  if (year < 1900 || year > 2100) {
    throw new LedgerError("INVALID_REQUEST", "occurredAt is outside the supported range");
  }
  return timestamp.toISOString();
}

function normalizeEntryType(value: unknown): LedgerEntryType {
  if (typeof value !== "string" || !LEDGER_ENTRY_TYPES.includes(value as LedgerEntryType)) {
    throw new LedgerError("INVALID_REQUEST", "entryType is invalid");
  }
  return value as LedgerEntryType;
}

function normalizePosting(value: unknown): LedgerPostingInput {
  if (!isRecord(value)) {
    throw new LedgerError("INVALID_REQUEST", "Posting must be an object");
  }
  assertAllowedKeys(value, ["accountId", "direction", "amount"]);
  const direction = value.direction;
  if (
    typeof direction !== "string" ||
    !LEDGER_POSTING_DIRECTIONS.includes(direction as LedgerPostingDirection)
  ) {
    throw new LedgerError("INVALID_REQUEST", "Posting direction is invalid");
  }
  const amount = value.amount;
  if (typeof amount !== "string") {
    throw new LedgerError("INVALID_AMOUNT", "Posting amount must be a string");
  }
  let normalizedAmount: string;
  try {
    normalizedAmount = formatEtbAmount(amount);
  } catch (error) {
    throw new LedgerError("INVALID_AMOUNT", "Posting amount is invalid", error);
  }
  try {
    toEtbMinorUnits(normalizedAmount, true);
  } catch (error) {
    throw new LedgerError("INVALID_AMOUNT", "Posting amount must be positive", error);
  }
  return {
    accountId: requireUuid(value.accountId, "accountId"),
    direction: direction as LedgerPostingDirection,
    amount: normalizedAmount
  };
}

export function validateBalancedPostings(
  postings: readonly LedgerPostingInput[]
): Readonly<{ debits: string; credits: string }> {
  if (!Array.isArray(postings) || postings.length < 2 || postings.length > MAX_POSTINGS) {
    throw new LedgerError("INVALID_REQUEST", "An entry requires between 2 and 100 postings");
  }

  const normalized = postings.map(normalizePosting);
  const pairs = new Set<string>();
  for (const posting of normalized) {
    const pair = `${posting.accountId}:${posting.direction}`;
    if (pairs.has(pair)) {
      throw new LedgerError("INVALID_REQUEST", "Duplicate account and direction posting");
    }
    pairs.add(pair);
  }

  let debits = 0n;
  let credits = 0n;
  for (const posting of normalized) {
    const amount = toEtbMinorUnits(posting.amount, true);
    if (posting.direction === "debit") {
      debits += amount;
    } else {
      credits += amount;
    }
  }

  if (debits !== credits) {
    throw new LedgerError("UNBALANCED", "Entry debits and credits do not balance");
  }

  return {
    debits: formatEtbMinorUnits(debits),
    credits: formatEtbMinorUnits(credits)
  };
}

export function normalizeLedgerEntryRequest(input: unknown): LedgerEntryRequest {
  if (!isRecord(input)) {
    throw new LedgerError("INVALID_REQUEST", "Request body must be an object");
  }
  assertAllowedKeys(input, [
    "groupId",
    "idempotencyKey",
    "occurredAt",
    "entryType",
    "correctsEntryId",
    "rationale",
    "postings"
  ]);

  const groupId = requireUuid(input.groupId, "groupId");
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new LedgerError("INVALID_REQUEST", "idempotencyKey is invalid");
  }

  const occurredAt = normalizeOccurredAt(input.occurredAt);
  const entryType = normalizeEntryType(input.entryType);
  const correctsEntryId =
    input.correctsEntryId === undefined ? undefined : requireUuid(input.correctsEntryId, "correctsEntryId");
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : undefined;

  if (entryType === "correction") {
    if (!correctsEntryId) {
      throw new LedgerError("INVALID_CORRECTION", "Correction requires correctsEntryId");
    }
    if (!rationale || rationale.length < 10 || rationale.length > 1000) {
      throw new LedgerError("INVALID_CORRECTION", "Correction rationale must contain 10 to 1000 characters");
    }
  } else if (correctsEntryId !== undefined || rationale !== undefined) {
    throw new LedgerError("INVALID_CORRECTION", "Only corrections may reference another entry");
  }

  if (!Array.isArray(input.postings)) {
    throw new LedgerError("INVALID_REQUEST", "postings must be an array");
  }
  const postings = input.postings.map(normalizePosting);
  validateBalancedPostings(postings);

  return {
    groupId,
    idempotencyKey,
    occurredAt,
    entryType,
    ...(correctsEntryId ? { correctsEntryId } : {}),
    ...(rationale ? { rationale } : {}),
    postings
  };
}

function postingPair(
  accountId: string,
  direction: LedgerPostingDirection
): string {
  return `${accountId}:${direction}`;
}

function oppositeDirection(direction: LedgerPostingDirection): LedgerPostingDirection {
  return direction === "debit" ? "credit" : "debit";
}

export function validateCompensatingEntry(
  request: LedgerEntryRequest,
  original: LedgerEntry,
  alreadyCorrected = false
): void {
  if (request.entryType !== "correction" || !request.correctsEntryId || !request.rationale) {
    throw new LedgerError("INVALID_CORRECTION", "Entry is not a complete compensating entry");
  }
  if (request.groupId !== original.groupId) {
    throw new LedgerError("INVALID_CORRECTION", "Correction must target an entry in the same group");
  }
  if (alreadyCorrected) {
    throw new LedgerError("INVALID_CORRECTION", "The original entry is already corrected");
  }
  if (new Date(request.occurredAt).getTime() < new Date(original.occurredAt).getTime()) {
    throw new LedgerError("INVALID_CORRECTION", "Correction cannot predate the original entry");
  }

  const expected = new Map<string, bigint>();
  for (const posting of original.postings) {
    const key = postingPair(posting.accountId, oppositeDirection(posting.direction));
    expected.set(key, (expected.get(key) ?? 0n) + toEtbMinorUnits(posting.amount, true));
  }

  const actual = new Map<string, bigint>();
  for (const posting of request.postings) {
    const key = postingPair(posting.accountId, posting.direction);
    actual.set(key, (actual.get(key) ?? 0n) + toEtbMinorUnits(posting.amount, true));
  }

  if (expected.size !== actual.size) {
    throw new LedgerError("INVALID_CORRECTION", "Correction does not exactly reverse the original entry");
  }
  for (const [key, amount] of expected) {
    if (actual.get(key) !== amount) {
      throw new LedgerError("INVALID_CORRECTION", "Correction does not exactly reverse the original entry");
    }
  }
}
