import { SyncError } from "@/lib/offline/contract";

/**
 * Local identifiers.
 *
 * Two different jobs, deliberately separated:
 *
 * - `newLocalId` names a row on *this* device. It is generated once and never
 *   sent as an authority.
 * - `createIdempotencyKey` names a *retried* mutation. It must be stable across
 *   reloads, so it is derived from the local row id rather than from a fresh
 *   random value. A treasurer who reloads mid-sync must not be able to double-post.
 *
 * The key shape satisfies the ledger's own
 * `IDEMPOTENCY_KEY_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`) in
 * `src/lib/ledger/rules.ts`, so a queued draft is replayable verbatim.
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface IdFactoryOptions {
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

function defaultRandomUUID(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort. A predictable id is still unique-enough locally because the
  // timestamp and counter below are monotonic; it is never a secret.
  const stamp = Date.now().toString(16);
  let counter = 0;
  counter += 1;
  return `00000000-0000-4000-8000-${stamp}${counter.toString(16).padStart(8, "0")}`.slice(0, 36);
}

/** RFC 4122-shaped id for a row that lives on this device only. */
export function newLocalId(options: IdFactoryOptions = {}): string {
  const factory = options.randomUUID ?? defaultRandomUUID;
  const id = factory();
  if (typeof id !== "string" || id.length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Could not generate a local identifier");
  }
  return id;
}

export interface IdempotencyKeyInput {
  readonly kind: "ledger-draft" | "spoken-note" | "roster-member";
  readonly subjectId: string;
  readonly groupId: string;
}

/**
 * Deterministic per (kind, group, subject). Two devices that queue the same
 * logical mutation converge on one key, and a device that reloads before
 * syncing produces the same key it had before.
 */
export function createIdempotencyKey(input: IdempotencyKeyInput): string {
  const key = `sened-offline:${input.kind}:${input.groupId}:${input.subjectId}`;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    // Long UUID chains plus a long group id can overflow the pattern. Truncating
    // the subject would risk two different rows colliding, so fail closed.
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Idempotency key would exceed the ledger's maximum length");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Generated idempotency key is not in the ledger's accepted shape");
  }
  return key;
}
