import { createHash } from "node:crypto";
import { LedgerError } from "./errors";
import { isUuid, normalizeLedgerEntryRequest, validateBalancedPostings, validateCompensatingEntry } from "./rules";
import type {
  LedgerChainHead,
  LedgerEntry,
  LedgerEntryRequest,
  LedgerPosting
} from "./types";

export const LEDGER_ENTRY_SERIALIZATION_VERSION = "sened-ledger-entry-v1";
export const LEDGER_REQUEST_SERIALIZATION_VERSION = "sened-ledger-request-v1";
export const GENESIS_LEDGER_HASH = "0".repeat(64);
export const EMPTY_LEDGER_HASH = "0".repeat(64);

function encode(value: string): string {
  return `${Array.from(value).length}:${value}`;
}

function canonicalLine(name: string, value: string): string {
  return `${encode(name)}\n${encode(value)}`;
}

function postingLines(postings: readonly LedgerEntryRequest["postings"][number][]): string[] {
  const lines = [canonicalLine("posting.count", String(postings.length))];
  postings.forEach((posting, index) => {
    const ordinal = index + 1;
    lines.push(canonicalLine(`posting.${ordinal}.accountId`, posting.accountId));
    lines.push(canonicalLine(`posting.${ordinal}.direction`, posting.direction));
    lines.push(canonicalLine(`posting.${ordinal}.amount`, posting.amount));
  });
  return lines;
}

export function canonicalSerializeRequest(
  request: LedgerEntryRequest,
  actorId: string
): string {
  const normalizedActorId = actorId.toLowerCase();
  assertUuid(normalizedActorId, "actorId");
  const normalized = normalizeLedgerEntryRequest(request);
  return [
    LEDGER_REQUEST_SERIALIZATION_VERSION,
    canonicalLine("actorId", normalizedActorId),
    canonicalLine("groupId", normalized.groupId),
    canonicalLine("idempotencyKey", normalized.idempotencyKey),
    canonicalLine("occurredAt", normalized.occurredAt),
    canonicalLine("entryType", normalized.entryType),
    canonicalLine("correctsEntryId", normalized.correctsEntryId ?? ""),
    canonicalLine("rationale", normalized.rationale ?? ""),
    ...postingLines(normalized.postings)
  ].join("\n");
}

export function canonicalSerializeEntry(entry: LedgerEntry): string {
  return [
    LEDGER_ENTRY_SERIALIZATION_VERSION,
    canonicalLine("id", entry.id),
    canonicalLine("groupId", entry.groupId),
    canonicalLine("tenantId", entry.tenantId),
    canonicalLine("sequence", entry.sequence),
    canonicalLine("occurredAt", entry.occurredAt),
    canonicalLine("recordedAt", entry.recordedAt),
    canonicalLine("entryType", entry.entryType),
    canonicalLine("correctsEntryId", entry.correctsEntryId ?? ""),
    canonicalLine("rationale", entry.rationale ?? ""),
    canonicalLine("actorId", entry.actorId),
    canonicalLine("nonce", entry.nonce),
    canonicalLine("previousHash", entry.previousHash),
    canonicalLine("requestFingerprint", entry.requestFingerprint),
    canonicalLine("idempotencyKey", entry.idempotencyKey),
    ...postingLines(entry.postings)
  ].join("\n");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintLedgerRequest(
  request: LedgerEntryRequest,
  actorId: string
): string {
  return sha256Hex(canonicalSerializeRequest(request, actorId));
}

export function computeLedgerEntryHash(entry: LedgerEntry): string {
  return sha256Hex(canonicalSerializeEntry(entry));
}

function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new LedgerError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function assertHash(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new LedgerError("INTEGRITY_FAILURE", `${field} is not a SHA-256 hash`);
  }
}

function assertTimestamp(value: string, field: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new LedgerError("INVALID_REQUEST", `${field} is invalid`);
  }
  return timestamp.toISOString();
}

export function buildLedgerEntry(input: {
  readonly request: LedgerEntryRequest;
  readonly actorId: string;
  readonly tenantId: string;
  readonly entryId: string;
  readonly nonce: string;
  readonly sequence: string;
  readonly previousHash: string;
  readonly recordedAt: string;
  readonly postingIds: readonly string[];
  readonly originalEntry?: LedgerEntry;
  readonly correctedEntryIds?: ReadonlySet<string>;
}): LedgerEntry {
  const request = normalizeLedgerEntryRequest(input.request);
  assertUuid(input.actorId, "actorId");
  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.entryId, "entryId");
  assertUuid(input.nonce, "nonce");
  assertHash(input.previousHash, "previousHash");

  if (!/^[1-9]\d*$/.test(input.sequence)) {
    throw new LedgerError("INVALID_REQUEST", "sequence must be a positive integer string");
  }

  validateBalancedPostings(request.postings);
  if (input.postingIds.length !== request.postings.length) {
    throw new LedgerError("INVALID_REQUEST", "Posting identifiers must match posting count");
  }
  for (const postingId of input.postingIds) {
    assertUuid(postingId, "postingId");
  }
  if (new Set(input.postingIds.map((postingId) => postingId.toLowerCase())).size !== input.postingIds.length) {
    throw new LedgerError("INVALID_REQUEST", "Posting identifiers must be unique");
  }
  if (request.entryType === "correction") {
    if (!input.originalEntry) {
      throw new LedgerError("INVALID_CORRECTION", "Correction original entry is missing");
    }
    if (request.correctsEntryId === input.entryId.toLowerCase()) {
      throw new LedgerError("INVALID_CORRECTION", "An entry cannot correct itself");
    }
    validateCompensatingEntry(
      request,
      input.originalEntry,
      input.correctedEntryIds?.has(input.originalEntry.id) ?? false
    );
  }

  const occurredAt = assertTimestamp(request.occurredAt, "occurredAt");
  const recordedAt = assertTimestamp(input.recordedAt, "recordedAt");
  const requestFingerprint = fingerprintLedgerRequest(request, input.actorId.toLowerCase());
  const postings: LedgerPosting[] = request.postings.map((posting, index) => ({
    id: input.postingIds[index].toLowerCase(),
    ordinal: index + 1,
    ...posting
  }));
  const draft: LedgerEntry = {
    id: input.entryId.toLowerCase(),
    groupId: request.groupId,
    tenantId: input.tenantId.toLowerCase(),
    sequence: input.sequence,
    occurredAt,
    recordedAt,
    entryType: request.entryType,
    correctsEntryId: request.correctsEntryId ?? null,
    rationale: request.rationale ?? null,
    actorId: input.actorId.toLowerCase(),
    nonce: input.nonce.toLowerCase(),
    previousHash: input.previousHash.toLowerCase(),
    entryHash: EMPTY_LEDGER_HASH,
    requestFingerprint,
    idempotencyKey: request.idempotencyKey,
    postings
  };
  return {
    ...draft,
    entryHash: computeLedgerEntryHash(draft)
  };
}

export function verifyLedgerEntryHash(entry: LedgerEntry): boolean {
  try {
    assertUuid(entry.id, "id");
    assertUuid(entry.groupId, "groupId");
    assertUuid(entry.tenantId, "tenantId");
    assertUuid(entry.actorId, "actorId");
    assertUuid(entry.nonce, "nonce");
    if (!/^[1-9]\d*$/.test(entry.sequence)) {
      throw new LedgerError("INVALID_REQUEST", "sequence is invalid");
    }
    if (assertTimestamp(entry.occurredAt, "occurredAt") !== entry.occurredAt) {
      throw new LedgerError("INVALID_REQUEST", "occurredAt is not canonical");
    }
    if (assertTimestamp(entry.recordedAt, "recordedAt") !== entry.recordedAt) {
      throw new LedgerError("INVALID_REQUEST", "recordedAt is not canonical");
    }
    const ordinals = new Set<number>();
    const postingIds = new Set<string>();
    for (const posting of entry.postings) {
      assertUuid(posting.id, "postingId");
      if (
        !Number.isSafeInteger(posting.ordinal) ||
        posting.ordinal < 1 ||
        posting.ordinal > entry.postings.length ||
        ordinals.has(posting.ordinal)
      ) {
        throw new LedgerError("INVALID_REQUEST", "posting ordinal is invalid");
      }
      if (postingIds.has(posting.id.toLowerCase())) {
        throw new LedgerError("INVALID_REQUEST", "posting identifiers must be unique");
      }
      ordinals.add(posting.ordinal);
      postingIds.add(posting.id.toLowerCase());
    }
    if (ordinals.size !== entry.postings.length) {
      throw new LedgerError("INVALID_REQUEST", "posting ordinals must be contiguous");
    }
    assertHash(entry.entryHash, "entryHash");
    assertHash(entry.previousHash, "previousHash");
    return computeLedgerEntryHash(entry) === entry.entryHash;
  } catch {
    return false;
  }
}

export interface LedgerChainVerificationError {
  readonly code: string;
  readonly groupId?: string;
  readonly entryId?: string;
}

export interface LedgerChainVerificationResult {
  readonly valid: boolean;
  readonly entriesChecked: number;
  readonly error?: LedgerChainVerificationError;
}

function requestFromEntry(entry: LedgerEntry): LedgerEntryRequest {
  return normalizeLedgerEntryRequest({
    groupId: entry.groupId,
    idempotencyKey: entry.idempotencyKey,
    occurredAt: entry.occurredAt,
    entryType: entry.entryType,
    correctsEntryId: entry.correctsEntryId ?? undefined,
    rationale: entry.rationale ?? undefined,
    postings: entry.postings.map(({ accountId, direction, amount }) => ({
      accountId,
      direction,
      amount
    }))
  });
}

function verifyLedgerChainInternal(
  entries: readonly LedgerEntry[]
): LedgerChainVerificationResult {
  const byGroup = new Map<string, LedgerEntry[]>();
  const entryIds = new Set<string>();
  const nonces = new Set<string>();
  const idempotencyKeys = new Set<string>();

  for (const entry of entries) {
    const idempotencyKey = `${entry.groupId}:${entry.idempotencyKey}`;
    if (idempotencyKeys.has(idempotencyKey)) {
      return {
        valid: false,
        entriesChecked: 0,
        error: { code: "DUPLICATE_IDEMPOTENCY_KEY", groupId: entry.groupId, entryId: entry.id }
      };
    }
    idempotencyKeys.add(idempotencyKey);
    if (entryIds.has(entry.id)) {
      return {
        valid: false,
        entriesChecked: 0,
        error: { code: "DUPLICATE_ENTRY_ID", groupId: entry.groupId, entryId: entry.id }
      };
    }
    const nonceKey = `${entry.groupId}:${entry.nonce}`;
    if (nonces.has(nonceKey)) {
      return {
        valid: false,
        entriesChecked: 0,
        error: { code: "DUPLICATE_NONCE", groupId: entry.groupId, entryId: entry.id }
      };
    }
    idempotencyKeys.add(idempotencyKey);
    entryIds.add(entry.id);
    nonces.add(nonceKey);
    const groupEntries = byGroup.get(entry.groupId) ?? [];
    groupEntries.push(entry);
    byGroup.set(entry.groupId, groupEntries);
  }

  let entriesChecked = 0;
  for (const [groupId, groupEntries] of byGroup) {
    groupEntries.sort((left: LedgerEntry, right: LedgerEntry) => {
      const sequenceDifference = BigInt(left.sequence) - BigInt(right.sequence);
      return sequenceDifference < 0n ? -1 : sequenceDifference > 0n ? 1 : 0;
    });
    let previousHash = GENESIS_LEDGER_HASH;
    let expectedSequence = 1n;
    let tenantId = groupEntries[0]?.tenantId;
    const correctedEntryIds = new Set<string>();

    for (const entry of groupEntries) {
      if (entry.groupId !== groupId) {
        return {
          valid: false,
          entriesChecked,
          error: { code: "GROUP_MISMATCH", groupId, entryId: entry.id }
        };
      }
      if (entry.tenantId !== tenantId) {
        return {
          valid: false,
          entriesChecked,
          error: { code: "TENANT_MISMATCH", groupId, entryId: entry.id }
        };
      }
      if (BigInt(entry.sequence) !== expectedSequence) {
        return {
          valid: false,
          entriesChecked,
          error: { code: "SEQUENCE_GAP", groupId, entryId: entry.id }
        };
      }
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          entriesChecked,
          error: { code: "PREVIOUS_HASH_MISMATCH", groupId, entryId: entry.id }
        };
      }
      if (!verifyLedgerEntryHash(entry)) {
        return {
          valid: false,
          entriesChecked,
          error: { code: "ENTRY_HASH_MISMATCH", groupId, entryId: entry.id }
        };
      }

      try {
        const request = requestFromEntry(entry);
        if (fingerprintLedgerRequest(request, entry.actorId) !== entry.requestFingerprint) {
          return {
            valid: false,
            entriesChecked,
            error: { code: "REQUEST_FINGERPRINT_MISMATCH", groupId, entryId: entry.id }
          };
        }
        if (entry.entryType === "correction") {
          const original = entries.find(
            (candidate) =>
              candidate.id === entry.correctsEntryId && candidate.groupId === entry.groupId
          );
          if (!original) {
            return {
              valid: false,
              entriesChecked,
              error: { code: "CORRECTION_ORIGINAL_MISSING", groupId, entryId: entry.id }
            };
          }
          validateCompensatingEntry(request, original, correctedEntryIds.has(original.id));
          correctedEntryIds.add(original.id);
        }
      } catch (error) {
        return {
          valid: false,
          entriesChecked,
          error: {
            code: error instanceof LedgerError ? error.code : "ENTRY_VALIDATION_FAILED",
            groupId,
            entryId: entry.id
          }
        };
      }

      previousHash = entry.entryHash;
      expectedSequence += 1n;
      entriesChecked += 1;
    }
  }

  return { valid: true, entriesChecked };
}

export function verifyLedgerChain(
  entries: readonly LedgerEntry[]
): LedgerChainVerificationResult {
  try {
    return verifyLedgerChainInternal(entries);
  } catch {
    return {
      valid: false,
      entriesChecked: 0,
      error: { code: "CHAIN_INPUT_INVALID" }
    };
  }
}

export function chainHeadFromEntry(entry: LedgerEntry): LedgerChainHead {
  return {
    groupId: entry.groupId,
    tenantId: entry.tenantId,
    lastSequence: entry.sequence,
    lastHash: entry.entryHash
  };
}
