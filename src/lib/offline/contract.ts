/**
 * Offline sync contract — AGENT-4 (M6.1).
 *
 * This file is the *client half* of a bidirectional sync protocol. The server
 * half lives in `src/lib/sync/routeHandlers.ts`: `POST /api/sync` takes either
 * `{ mutations }` (push) or `{ groupId, sinceSequence, limit }` (pull), which is
 * the one URL `HttpSyncTransport` posts both to. `/offline` uses
 * `HttpSyncTransport` when signed in and `UnconfiguredSyncTransport` (which
 * fails closed) otherwise.
 *
 * Deliberate constraints:
 *
 * - No `node:crypto` anywhere in `src/lib/db/**` or `src/lib/offline/**`. These
 *   modules ship to the browser. `src/lib/ledger/canonical.ts` imports
 *   `node:crypto`, so it is imported **type-only** here and never as a value.
 * - No credentials are ever persisted. The bearer token is a parameter of
 *   `SyncTransport.push`/`pull`, never a stored field.
 * - The contract describes *states a person can act on*, never a fabricated
 *   success. `synced` is only reachable from a confirmed server response.
 */

/** Lifecycle of a local mutation as it travels through the outbox. */
export const OFFLINE_SYNC_STATES = [
  /** Written to the device, never handed to a transport. */
  "local-draft",
  /** In the outbox, waiting for a drain attempt. */
  "queued",
  /** A drain attempt holds the lease right now. */
  "in-flight",
  /** A transient failure occurred; `nextAttemptAt` is in the future. */
  "retry-scheduled",
  /** The server confirmed acceptance and returned an entry id + hash. */
  "synced",
  /** The server refused the payload. A human must fix the draft. */
  "rejected",
  /** Attempts exhausted, or the blocker needs a human decision. */
  "blocked"
] as const;

export type OfflineSyncState = (typeof OFFLINE_SYNC_STATES)[number];

/**
 * Terminal states. A terminal mutation is never retried automatically and is
 * never silently deleted — the row stays in IndexedDB until a person acts.
 */
export const TERMINAL_OFFLINE_SYNC_STATES = ["synced", "rejected", "blocked"] as const;

export type TerminalOfflineSyncState = (typeof TERMINAL_OFFLINE_SYNC_STATES)[number];

export function isTerminalOfflineSyncState(state: OfflineSyncState): state is TerminalOfflineSyncState {
  return (TERMINAL_OFFLINE_SYNC_STATES as readonly string[]).includes(state);
}

export function isRetriableOfflineSyncState(state: OfflineSyncState): boolean {
  return state === "queued" || state === "retry-scheduled" || state === "in-flight";
}

/** The kinds of mutation this device can originate. */
export const OFFLINE_MUTATION_KINDS = ["ledger-draft", "spoken-note", "roster-member"] as const;

export type OfflineMutationKind = (typeof OFFLINE_MUTATION_KINDS)[number];

/**
 * Machine-readable reasons a mutation cannot proceed right now.
 *
 * `SYNC_NOT_CONFIGURED` is the important one: Wave 2 has no server route yet, so
 * this is the *default* answer. It is deliberately **not** counted as a failed
 * attempt — an unconfigured server is a configuration state, not a network
 * fault, and burning retries on it would strand a treasurer's queue.
 */
export const SYNC_ERROR_CODES = [
  "SYNC_NOT_CONFIGURED",
  "SYNC_UNAUTHENTICATED",
  "SYNC_UNAVAILABLE",
  "SYNC_TIMEOUT",
  "SYNC_NETWORK",
  "SYNC_RATE_LIMITED",
  "SYNC_REJECTED",
  "SYNC_FORBIDDEN",
  "SYNC_IDEMPOTENCY_CONFLICT",
  "SYNC_PROTECTED_ROW",
  "SYNC_CORRUPT_PAYLOAD",
  "LOCAL_RECORD_NOT_FOUND",
  "STORAGE_UNAVAILABLE",
  "STORAGE_FULL",
  "CRYPTO_UNAVAILABLE",
  "INVALID_DRAFT",
  "LOCAL_CHAIN_BROKEN"
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/** Error codes that must never consume a retry attempt. */
const NON_ATTEMPT_CODES: readonly SyncErrorCode[] = ["SYNC_NOT_CONFIGURED"];

/** Error codes that mean "retrying cannot help; a human must act". */
const HUMAN_BLOCKED_CODES: readonly SyncErrorCode[] = [
  "SYNC_UNAUTHENTICATED",
  "SYNC_FORBIDDEN",
  "SYNC_IDEMPOTENCY_CONFLICT"
];

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly retryAfterMs: number | null;
  readonly cause: unknown;

  constructor(code: SyncErrorCode, message: string, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
}

/** `true` when the failure says nothing about the payload being wrong. */
export function isTransientSyncError(code: SyncErrorCode): boolean {
  return !NON_ATTEMPT_CODES.includes(code) && !HUMAN_BLOCKED_CODES.includes(code) && code !== "SYNC_REJECTED";
}

/** `true` when the failure is a configuration/credential state, not a fault. */
export function isNonAttemptSyncError(code: SyncErrorCode): boolean {
  return NON_ATTEMPT_CODES.includes(code);
}

/** One unit of work handed to the server. */
export interface SyncPushEnvelope {
  /** Outbox row id. Lets the client match a result back to its queue entry. */
  readonly mutationId: string;
  /** Stable across retries. The ledger treats this as its idempotency key. */
  readonly idempotencyKey: string;
  readonly kind: OfflineMutationKind;
  readonly groupId: string;
  /** Kind-specific body. For `ledger-draft` this is a `LedgerEntryRequest`. */
  readonly payload: unknown;
  /** When this device recorded the mutation. Never used for conflict ordering. */
  readonly clientRecordedAt: string;
}

export const SYNC_PUSH_OUTCOMES = ["ACCEPTED", "REPLAYED", "REJECTED"] as const;

export type SyncPushOutcome = (typeof SYNC_PUSH_OUTCOMES)[number];

export interface SyncPushResult {
  readonly mutationId: string;
  readonly outcome: SyncPushOutcome;
  /** Required for ACCEPTED/REPLAYED. Absent means we do not trust the success. */
  readonly serverEntryId?: string;
  readonly serverEntryHash?: string;
  readonly serverSequence?: string;
  /** Machine code from the server, e.g. `unprocessable_ledger_entry`. */
  readonly error?: string;
  /** Server-requested wait. Honoured over the computed backoff. */
  readonly retryAfterMs?: number;
}

export interface SyncPullQuery {
  readonly groupId: string;
  /** `"0"` asks for the whole chain. Exclusive lower bound. */
  readonly sinceSequence: string;
  readonly limit: number;
}

export interface SyncPullResult {
  readonly groupId: string;
  /** The chain head the server believes in. Used for divergence detection. */
  readonly head: LedgerChainHeadLike;
  readonly entries: readonly LedgerEntryLike[];
  readonly hasMore: boolean;
}

/**
 * Structural stand-ins for A1's ledger types.
 *
 * Declared here rather than imported so the contract has no runtime dependency
 * on `src/lib/ledger/**`. A1's `LedgerChainHead` and `LedgerEntry` satisfy these
 * shapes exactly, so Wave 2 can import the real types with no cast.
 */
export interface LedgerChainHeadLike {
  readonly groupId: string;
  readonly tenantId: string;
  readonly lastSequence: string;
  readonly lastHash: string;
}

export interface LedgerPostingLike {
  readonly id: string;
  readonly ordinal: number;
  readonly accountId: string;
  readonly direction: "debit" | "credit";
  readonly amount: string;
}

export interface LedgerEntryLike {
  readonly id: string;
  readonly groupId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly entryHash: string;
  readonly previousHash: string;
  readonly entryType: string;
  readonly actorId: string;
  readonly nonce: string;
  readonly correctsEntryId: string | null;
  readonly rationale: string | null;
  readonly postings: readonly LedgerPostingLike[];
}

/**
 * The interface Wave 2 implements server-side.
 *
 * Contract rules, in order of importance:
 *
 * 1. `push` is idempotent per `idempotencyKey`. Replaying an already-accepted
 *    key returns `REPLAYED` with the original ids — never a second entry.
 * 2. A `LedgerEntryRequest` is accepted or rejected by A1's ledger rules. The
 *    client pre-validates with the *same* rules, so a 422 means the two
 *    devices disagreed about something the rules cover.
 * 3. `pull` returns a contiguous, hash-linked slice. A gap in `previousHash`
 *    linkage is a protocol violation, not a state to be repaired.
 */
export interface SyncTransport {
  push(authorization: string, envelopes: readonly SyncPushEnvelope[]): Promise<readonly SyncPushResult[]>;
  pull(authorization: string, query: SyncPullQuery): Promise<SyncPullResult>;
}

/** Why two histories cannot be reconciled automatically. */
export const SYNC_DIVERGENCE_KINDS = [
  "height-mismatch",
  "hash-mismatch",
  "local-chain-broken",
  "server-head-rejected"
] as const;

export type SyncDivergenceKind = (typeof SYNC_DIVERGENCE_KINDS)[number];

/**
 * A recorded, unresolved disagreement between two append-only histories.
 *
 * There is deliberately no automatic resolution. The only correct merge of two
 * hash chains is "there is no merge" — so the client's job is to notice the
 * fork and put a person in front of it.
 */
export interface SyncDivergence {
  readonly kind: SyncDivergenceKind;
  readonly detectedAt: string;
  readonly groupId: string;
  /** Longest prefix where the two histories agree, in entries. */
  readonly commonPrefixLength: number;
  /** First sequence at which they disagree, as a decimal string. */
  readonly forkSequence: string;
  readonly localLastSequence: string;
  readonly serverLastSequence: string;
  readonly localLastHash: string | null;
  readonly serverLastHash: string | null;
  /** Machine-readable explanation, safe to show a person. */
  readonly detail: string;
  /** Set only by an explicit human action in the console. */
  readonly resolution: SyncDivergenceResolution | null;
  readonly resolvedAt: string | null;
}

export const SYNC_DIVERGENCE_RESOLUTIONS = ["accept-server-as-truth", "escalate-to-review"] as const;

export type SyncDivergenceResolution = (typeof SYNC_DIVERGENCE_RESOLUTIONS)[number];

/**
 * `accept-server-as-truth` is a *presentation* decision only. It stops the
 * client from pushing and marks the local fork as quarantined. It never
 * deletes a local row and never recomputes a hash — the server's chain is the
 * only chain, and the local fork stays on disk for a human to reconcile.
 */
export function isResolvedDivergence(divergence: SyncDivergence): boolean {
  return divergence.resolution !== null && divergence.resolvedAt !== null;
}
