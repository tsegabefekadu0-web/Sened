import type { LedgerEntryRequest } from "@/lib/ledger/types";
import type {
  LedgerEntryLike,
  OfflineMutationKind,
  OfflineSyncState,
  SyncAttributionOutcome,
  SyncDivergence
} from "@/lib/offline/contract";

/**
 * Local row shapes for the treasurer's offline store.
 *
 * Two rules hold across every table:
 *
 * 1. **A local draft is never a ledger entry.** `LedgerDraftRow` carries a
 *    `LedgerEntryRequest` — an *unhashed, unnumbered, uncommitted* intent. The
 *    `id`, `sequence` and `entryHash` only exist after the server accepts it
 *    and the client stores the confirmed entry in `ledgerMirror`.
 * 2. **Nothing here claims to be verified.** `contributedEtbOnDevice` is money
 *    typed on this phone. It is not in the ledger and the console labels it as
 *    such. §12.3 — no fabricated trust signals.
 */

export const ROSTER_ROLES = ["owner", "treasurer", "member"] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export const ROSTER_STATUSES = ["active", "inactive"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

/**
 * Provenance of a transcript. A note is only `asr` when a real speech-to-text
 * engine produced it. Until AGENT-2's fail-closed STT is configured, the
 * treasurer types or dictates into a field and we say so.
 */
export const TRANSCRIPT_SOURCES = ["human-typed", "asr"] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

/** Payment rails this product knows about. Mirrors the banking enums. */
export const PAYMENT_CHANNELS = ["telebirr", "cbe-birr", "cash", "bank-transfer"] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export const SPOKEN_NOTE_LOCALES = ["am", "om", "am-Latn", "en"] as const;
export type SpokenNoteLocale = (typeof SPOKEN_NOTE_LOCALES)[number];

export interface RosterMemberRow {
  readonly id: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly role: RosterRole;
  readonly status: RosterStatus;
  /**
   * Canonical ETB string, e.g. `"5000.00"`. Contributions **recorded on this
   * device that the server has not confirmed**. Never presented as ledgered.
   */
  readonly contributedEtbOnDevice: string;
  readonly joinedAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** Monotonic per-row counter. Lets a pull detect an out-of-order update. */
  readonly revision: number;
}

export interface SpokenNoteRow {
  readonly id: string;
  readonly groupId: string;
  readonly memberId: string | null;
  readonly locale: SpokenNoteLocale;
  readonly transcript: string;
  readonly transcriptSource: TranscriptSource;
  /** Canonical ETB string, or null when the speaker stated no amount. */
  readonly amountEtb: string | null;
  readonly channel: PaymentChannel | null;
  readonly occurredAt: string;
  readonly durationMs: number | null;
  readonly audioMimeType: string | null;
  readonly audioByteLength: number | null;
  /**
   * WebCrypto SHA-256 over the note's content, or null when
   * `crypto.subtle` is unavailable (an insecure context). Null means
   * "integrity hashing unavailable", never "verified".
   */
  readonly contentHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly outboxId: string | null;
}

export type LedgerDraftStatus = "draft" | "queued";

/**
 * Who paid a contribution draft, and for which cycle round. Rides in the outbox
 * payload as `attribution` and is recorded by the server after the entry posts.
 * Deliberately NOT part of `LedgerEntryRequest`: it never reaches the entry's
 * fingerprint or hash.
 */
export interface DraftAttribution {
  readonly memberUserId: string;
  readonly cycleId?: string;
  readonly round?: number;
}

/**
 * A ledger entry the treasurer composed while offline.
 *
 * `request` has already been through `normalizeLedgerEntryRequest`, so it is
 * balanced and correctly typed. That is deliberate: the offline store reuses
 * A1's rules rather than reimplementing them, which is what stops this device
 * from minting an entry the server would reject (§12.1).
 */
export interface LedgerDraftRow {
  readonly id: string;
  readonly groupId: string;
  readonly request: LedgerEntryRequest;
  readonly status: LedgerDraftStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** Non-null only once queued. Points at the outbox row that carries it. */
  readonly outboxId: string | null;
  /**
   * The payer, when the treasurer named one. Absent or null on a draft saved
   * before schema version 2 (or without a payer): such a draft is still valid and
   * is sent as a plain entry.
   */
  readonly attribution?: DraftAttribution | null;
}

export interface OutboxRow {
  readonly id: string;
  readonly kind: OfflineMutationKind;
  readonly groupId: string;
  /** Local row this mutation carries: a draft id, a note id, or a member id. */
  readonly subjectId: string;
  readonly idempotencyKey: string;
  readonly state: OfflineSyncState;
  readonly attempts: number;
  readonly payload: unknown;
  /** Epoch ms. Item is not eligible before this instant. */
  readonly nextAttemptAt: number;
  /** Identifies the drain attempt holding the item. Null when unleased. */
  readonly leaseOwner: string | null;
  /** Epoch ms. An expired lease is reclaimable by any device. */
  readonly leaseExpiresAt: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  /** Server-confirmed values. Populated only on a real acceptance. */
  readonly serverEntryId: string | null;
  readonly serverEntryHash: string | null;
  readonly serverSequence: string | null;
  /**
   * What the server said about the payer attribution that rode along on this
   * mutation: `RECORDED`, `REFUSED` (the entry is posted regardless), or null when
   * there was none or the server did not say. Absent on rows saved before schema
   * version 2.
   */
  readonly attributionOutcome?: SyncAttributionOutcome | null;
  /** The server's code for a `REFUSED` attribution. */
  readonly attributionError?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

/**
 * A server-confirmed entry, cached so the chain can be read without a network.
 *
 * Only ever written from a `SyncPullResult` or an accepted push result — never
 * from a local draft. This is the table the treasurer can trust offline, which
 * is exactly why drafts are kept somewhere else.
 */
export interface LedgerMirrorRow {
  readonly id: string;
  readonly groupId: string;
  /** Decimal string. Indexed with groupId so ordering is numeric-safe. */
  readonly sequence: string;
  readonly sequenceNumber: number;
  readonly entryHash: string;
  readonly previousHash: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly entryType: string;
  readonly entry: LedgerEntryLike;
  readonly pulledAt: string;
}

export interface SyncMetaRow {
  /** Scope key. One row per group; `"__global__"` holds device-wide state. */
  readonly key: string;
  readonly groupId: string;
  /** Highest sequence mirrored locally. `"0"` means nothing pulled yet. */
  readonly lastPulledSequence: string;
  readonly lastPulledHash: string | null;
  readonly lastPullAt: string | null;
  readonly lastSyncedAt: string | null;
  /** Unresolved fork, or null. Never auto-cleared. */
  readonly divergence: SyncDivergence | null;
  readonly updatedAt: string;
}

export const GLOBAL_SYNC_META_KEY = "__global__";

export function syncMetaKey(groupId: string): string {
  return groupId || GLOBAL_SYNC_META_KEY;
}

/** Everything a person needs to understand the queue, in one read. */
export interface OfflineQueueSummary {
  readonly total: number;
  readonly byState: Readonly<Record<OfflineSyncState, number>>;
  readonly oldestPendingAt: string | null;
  readonly blockedCount: number;
  readonly rejectedCount: number;
  /** True when nothing is waiting on the network. */
  readonly quiet: boolean;
}
