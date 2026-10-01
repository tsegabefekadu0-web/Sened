import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildLedgerEntry,
  fingerprintLedgerRequest,
  GENESIS_LEDGER_HASH,
  verifyLedgerEntryHash
} from "./canonical";
import { LedgerError } from "./errors";
import { formatEtbAmount } from "./money";
import {
  isUuid,
  normalizeLedgerEntryRequest,
  validateBalancedPostings,
  validateCompensatingEntry
} from "./rules";
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_ENTRY_TYPES,
  LEDGER_POSTING_DIRECTIONS,
  type AppendLedgerEntryResult,
  type LedgerAccountType,
  type LedgerActorContext,
  type LedgerChainHead,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryType,
  type LedgerMembershipRole,
  type LedgerMembershipStatus,
  type LedgerPostingDirection
} from "./types";

export interface LedgerRepository {
  append(
    request: LedgerEntryRequest,
    context: LedgerActorContext
  ): Promise<AppendLedgerEntryResult>;
}

export interface InMemoryLedgerGroupDefinition {
  readonly id: string;
  readonly tenantId: string;
  readonly name?: string;
  readonly members: readonly {
    readonly userId: string;
    readonly role: LedgerMembershipRole;
    readonly status?: LedgerMembershipStatus;
  }[];
}

export interface InMemoryLedgerAccountDefinition {
  readonly id: string;
  readonly groupId: string;
  readonly code: string;
  readonly name: string;
  readonly type: LedgerAccountType;
}

export interface InMemoryLedgerRepositoryOptions {
  readonly groups?: readonly InMemoryLedgerGroupDefinition[];
  readonly accounts?: readonly InMemoryLedgerAccountDefinition[];
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly entryId: string;
}

function idempotencyLocator(groupId: string, idempotencyKey: string): string {
  return `${groupId}:${idempotencyKey}`;
}

function freezeEntry(entry: LedgerEntry): LedgerEntry {
  const postings = entry.postings.map((posting) => Object.freeze({ ...posting }));
  return Object.freeze({ ...entry, postings: Object.freeze(postings) });
}

function assertContext(context: LedgerActorContext): string {
  if (!isUuid(context.actorId)) {
    throw new LedgerError("INVALID_REQUEST", "actorId must be a UUID");
  }
  return context.actorId.toLowerCase();
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly groups = new Map<string, InMemoryLedgerGroupDefinition>();
  private readonly accounts = new Map<string, InMemoryLedgerAccountDefinition>();
  private readonly entriesByGroup = new Map<string, LedgerEntry[]>();
  private readonly entriesById = new Map<string, LedgerEntry>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => string;

  constructor(options: InMemoryLedgerRepositoryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.nonceFactory = options.nonceFactory ?? randomUUID;

    for (const group of options.groups ?? []) {
      if (!isUuid(group.id) || !isUuid(group.tenantId)) {
        throw new LedgerError("INVALID_REQUEST", "In-memory group identifiers must be UUIDs");
      }
      const normalizedGroupId = group.id.toLowerCase();
      if (this.groups.has(normalizedGroupId)) {
        throw new LedgerError("INVALID_REQUEST", "In-memory group identifiers must be unique");
      }
      this.groups.set(normalizedGroupId, {
        ...group,
        id: normalizedGroupId,
        tenantId: group.tenantId.toLowerCase(),
        members: group.members.map((member) => {
          if (!isUuid(member.userId)) {
            throw new LedgerError("INVALID_REQUEST", "In-memory membership identifiers must be UUIDs");
          }
          return {
            ...member,
            userId: member.userId.toLowerCase(),
            status: member.status ?? "active"
          };
        })
      });
    }

    for (const account of options.accounts ?? []) {
      if (!isUuid(account.id) || !isUuid(account.groupId)) {
        throw new LedgerError("INVALID_REQUEST", "In-memory account identifiers must be UUIDs");
      }
      if (!LEDGER_ACCOUNT_TYPES.includes(account.type)) {
        throw new LedgerError("INVALID_REQUEST", "In-memory account type is invalid");
      }
      if (!this.groups.has(account.groupId.toLowerCase())) {
        throw new LedgerError("INVALID_REQUEST", "In-memory account group is missing");
      }
      const accountKey = `${account.groupId.toLowerCase()}:${account.id.toLowerCase()}`;
      if (this.accounts.has(accountKey)) {
        throw new LedgerError("INVALID_REQUEST", "In-memory account identifiers must be unique");
      }
      this.accounts.set(accountKey, {
        ...account,
        id: account.id.toLowerCase(),
        groupId: account.groupId.toLowerCase()
      });
    }
  }

  async append(
    requestInput: LedgerEntryRequest,
    context: LedgerActorContext
  ): Promise<AppendLedgerEntryResult> {
    const request = normalizeLedgerEntryRequest(requestInput);
    const actorId = assertContext(context);
    return this.withGroupLock(request.groupId, async () => {
      const group = this.groups.get(request.groupId);
      if (!group) {
        throw new LedgerError("NOT_FOUND", "Ledger group was not found");
      }

      const membership = group.members.find((member) => member.userId.toLowerCase() === actorId);
      if (
        !membership ||
        (membership.status ?? "active") !== "active" ||
        !["owner", "treasurer"].includes(membership.role)
      ) {
        throw new LedgerError("FORBIDDEN", "Ledger group access is forbidden");
      }

      const fingerprint = fingerprintLedgerRequest(request, actorId);
      const locator = idempotencyLocator(request.groupId, request.idempotencyKey);
      const existingIdempotency = this.idempotency.get(locator);
      if (existingIdempotency) {
        if (existingIdempotency.fingerprint !== fingerprint) {
          throw new LedgerError("IDEMPOTENCY_CONFLICT", "Idempotency key payload conflict");
        }
        const existing = this.entriesById.get(existingIdempotency.entryId);
        if (!existing) {
          throw new LedgerError("INTEGRITY_FAILURE", "Idempotent entry is missing");
        }
        return { entry: freezeEntry(existing), replayed: true };
      }

      for (const posting of request.postings) {
        if (!this.accounts.has(`${request.groupId}:${posting.accountId}`)) {
          throw new LedgerError("NOT_FOUND", "Ledger account was not found in this group");
        }
      }

      const groupEntries = this.entriesByGroup.get(request.groupId) ?? [];
      const correctedEntryIds = new Set(
        groupEntries
          .filter((entry) => entry.correctsEntryId !== null)
          .map((entry) => entry.correctsEntryId as string)
      );
      const originalEntry = request.correctsEntryId
        ? groupEntries.find((entry) => entry.id === request.correctsEntryId)
        : undefined;
      if (request.entryType === "correction") {
        if (!originalEntry) {
          throw new LedgerError("INVALID_CORRECTION", "Correction original entry was not found");
        }
        validateCompensatingEntry(request, originalEntry, correctedEntryIds.has(originalEntry.id));
      }

      const previous = groupEntries[groupEntries.length - 1];
      const sequence = (previous ? BigInt(previous.sequence) : 0n) + 1n;
      const entryId = this.idFactory();
      const postingIds = request.postings.map(() => this.idFactory());
      const entry = buildLedgerEntry({
        request,
        actorId,
        tenantId: group.tenantId,
        entryId,
        nonce: this.nonceFactory(),
        sequence: sequence.toString(),
        previousHash: previous?.entryHash ?? GENESIS_LEDGER_HASH,
        recordedAt: this.clock().toISOString(),
        postingIds,
        ...(originalEntry ? { originalEntry } : {}),
        correctedEntryIds
      });

      if (
        this.entriesById.has(entry.id) ||
        groupEntries.some((storedEntry) => storedEntry.nonce === entry.nonce)
      ) {
        throw new LedgerError("INTEGRITY_FAILURE", "Generated ledger identifiers collided");
      }

      groupEntries.push(entry);
      this.entriesByGroup.set(request.groupId, groupEntries);
      this.entriesById.set(entry.id, entry);
      this.idempotency.set(locator, { fingerprint, entryId: entry.id });
      return { entry: freezeEntry(entry), replayed: false };
    });
  }

  getEntries(groupIdInput: string, context: LedgerActorContext): readonly LedgerEntry[] {
    const groupId = groupIdInput.toLowerCase();
    const actorId = assertContext(context);
    const group = this.groups.get(groupId);
    if (!group) {
      throw new LedgerError("NOT_FOUND", "Ledger group was not found");
    }
    const membership = group.members.find((member) => member.userId.toLowerCase() === actorId);
    if (!membership || (membership.status ?? "active") !== "active") {
      throw new LedgerError("FORBIDDEN", "Ledger group access is forbidden");
    }
    return Object.freeze((this.entriesByGroup.get(groupId) ?? []).map(freezeEntry));
  }

  getHeads(): readonly LedgerChainHead[] {
    return Object.freeze(
      Array.from(this.entriesByGroup.values()).map((entries) => {
        const last = entries[entries.length - 1];
        if (!last) {
          throw new LedgerError("INTEGRITY_FAILURE", "Ledger head is missing");
        }
        return Object.freeze({
          groupId: last.groupId,
          tenantId: last.tenantId,
          lastSequence: last.sequence,
          lastHash: last.entryHash
        });
      })
    );
  }

  private async withGroupLock<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(groupId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(groupId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(groupId) === tail) {
        this.locks.delete(groupId);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerError("INTEGRITY_FAILURE", `Ledger RPC returned an invalid ${key}`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LedgerError("INTEGRITY_FAILURE", `Ledger RPC returned an invalid ${key}`);
  }
  return value;
}

function parseRpcEntry(value: unknown, context: LedgerActorContext): LedgerEntry {
  if (!isRecord(value)) {
    throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid entry");
  }
  const entryType = requiredString(value, "entryType");
  if (!LEDGER_ENTRY_TYPES.includes(entryType as LedgerEntryType)) {
    throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid entryType");
  }
  if (!Array.isArray(value.postings)) {
    throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned invalid postings");
  }
  const postings = value.postings.map((postingValue) => {
    if (!isRecord(postingValue)) {
      throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid posting");
    }
    const direction = requiredString(postingValue, "direction");
    if (!LEDGER_POSTING_DIRECTIONS.includes(direction as LedgerPostingDirection)) {
      throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid direction");
    }
    const ordinal = postingValue.ordinal;
    if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)) {
      throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid ordinal");
    }
    return {
      id: requiredString(postingValue, "id"),
      ordinal,
      accountId: requiredString(postingValue, "accountId"),
      direction: direction as LedgerPostingDirection,
      amount: formatEtbAmount(requiredString(postingValue, "amount"))
    };
  });

  const entry: LedgerEntry = {
    id: requiredString(value, "id"),
    groupId: requiredString(value, "groupId"),
    tenantId: requiredString(value, "tenantId"),
    sequence: requiredString(value, "sequence"),
    occurredAt: requiredString(value, "occurredAt"),
    recordedAt: requiredString(value, "recordedAt"),
    entryType: entryType as LedgerEntryType,
    correctsEntryId: nullableString(value, "correctsEntryId"),
    rationale: nullableString(value, "rationale"),
    actorId: requiredString(value, "actorId"),
    nonce: requiredString(value, "nonce"),
    previousHash: requiredString(value, "previousHash"),
    entryHash: requiredString(value, "entryHash"),
    requestFingerprint: requiredString(value, "requestFingerprint"),
    idempotencyKey: requiredString(value, "idempotencyKey"),
    postings
  };
  const request = normalizeLedgerEntryRequest({
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
  if (
    entry.actorId !== context.actorId.toLowerCase() ||
    fingerprintLedgerRequest(request, entry.actorId) !== entry.requestFingerprint ||
    !verifyLedgerEntryHash(entry)
  ) {
    throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC integrity verification failed");
  }
  return entry;
}

function mapSupabaseError(error: { readonly code?: string; readonly message: string }): LedgerError {
  const message = error.message;
  if (message.includes("ledger_group_not_found") || message.includes("ledger_account_not_found")) {
    return new LedgerError("NOT_FOUND", "Ledger resource was not found", error);
  }
  if (message.includes("ledger_forbidden") || error.code === "42501") {
    return new LedgerError("FORBIDDEN", "Ledger group access is forbidden", error);
  }
  if (message.includes("ledger_idempotency_conflict")) {
    return new LedgerError("IDEMPOTENCY_CONFLICT", "Idempotency key payload conflict", error);
  }
  if (message.includes("ledger_entry_unbalanced")) {
    return new LedgerError("UNBALANCED", "Entry debits and credits do not balance", error);
  }
  if (message.includes("ledger_invalid_correction")) {
    return new LedgerError("INVALID_CORRECTION", "Ledger correction validation failed", error);
  }
  if (error.code === "22023" || message.includes("ledger_invalid_request") || message.includes("ledger_invalid_posting") || message.includes("ledger_entry_has_no_postings")) {
    return new LedgerError("INVALID_REQUEST", "Ledger request validation failed", error);
  }
  if (error.code === "PGRST202" || error.code === "57014") {
    return new LedgerError("UNAVAILABLE", "Ledger persistence is unavailable", error);
  }
  return new LedgerError("STORAGE_FAILURE", "Ledger persistence failed", error);
}

export class SupabaseLedgerRepository implements LedgerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async append(
    requestInput: LedgerEntryRequest,
    context: LedgerActorContext
  ): Promise<AppendLedgerEntryResult> {
    const request = normalizeLedgerEntryRequest(requestInput);
    const actorId = assertContext(context);
    const { data, error } = await this.client.rpc("post_ledger_entry_v1", {
      requested_group_id: request.groupId,
      requested_idempotency_key: request.idempotencyKey,
      requested_occurred_at: request.occurredAt,
      requested_entry_type: request.entryType,
      requested_corrects_entry_id: request.correctsEntryId ?? null,
      requested_rationale: request.rationale ?? null,
      requested_postings: request.postings.map((posting) => ({ ...posting }))
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    if (!isRecord(data) || typeof data.replayed !== "boolean") {
      throw new LedgerError("INTEGRITY_FAILURE", "Ledger RPC returned an invalid response");
    }
    return {
      entry: parseRpcEntry(data.entry, { actorId }),
      replayed: data.replayed
    };
  }
}

export class LedgerService {
  constructor(private readonly repository: LedgerRepository) {}

  async append(
    requestInput: unknown,
    context: LedgerActorContext
  ): Promise<AppendLedgerEntryResult> {
    const actorId = assertContext(context);
    const request = normalizeLedgerEntryRequest(requestInput);
    validateBalancedPostings(request.postings);
    return this.repository.append(request, { actorId });
  }
}
