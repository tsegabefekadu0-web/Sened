import { attributionFromPayload } from "@/lib/db/attribution";
import { getLocalChainHead, listMirrorChain, storeMirrorEntries } from "@/lib/db/mirror";
import { readDivergence, readSyncMeta, recordDivergence, recordPullProgress, recordSyncActivity } from "@/lib/db/meta";
import {
  annotateUnattempted,
  claimOutboxBatch,
  settleRetry,
  settleSynced,
  settleTerminal
} from "@/lib/db/outbox";
import type { SenedDatabase } from "@/lib/db/schema";
import { classifyAttributionError } from "./attributionPolicy";
import { nextAttemptAtMs, DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS, type BackoffOptions } from "./backoff";
import {
  blocksPush,
  compareContinuation,
  inspectLocalChain,
  toChainLink,
  toDivergence,
  type ChainLink,
  type ChainRelation
} from "./chain";
import {
  isNonAttemptSyncError,
  isSyncError,
  isTransientSyncError,
  SyncError,
  type SyncDivergence,
  type SyncPushEnvelope,
  type SyncPushResult,
  type SyncTransport
} from "./contract";
import { UnconfiguredSyncTransport } from "./transport";

export interface OfflineSyncEngineOptions {
  readonly db: SenedDatabase;
  /**
   * Defaults to `UnconfiguredSyncTransport`, which fails closed. Wiring a real
   * transport is a deliberate act, never a side effect of importing the engine.
   */
  readonly transport?: SyncTransport;
  readonly clock?: () => Date;
  /** Injected in tests so backoff jitter does not make assertions flaky. */
  readonly random?: () => number;
  /** Identifies this drain attempt inside outbox leases. */
  readonly leaseOwner?: string;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly backoff?: BackoffOptions;
}

export interface DrainOutcome {
  readonly mutationId: string;
  readonly state: "synced" | "retry-scheduled" | "rejected" | "blocked" | "queued";
  readonly code: string | null;
  readonly message: string | null;
}

export interface DrainReport {
  readonly attempted: number;
  readonly synced: number;
  readonly retried: number;
  readonly rejected: number;
  readonly blocked: number;
  /** True when the transport reported it is not configured. No attempt spent. */
  readonly notConfigured: boolean;
  readonly outcomes: readonly DrainOutcome[];
  readonly skippedReason: string | null;
}

export interface PullReport {
  readonly groupId: string;
  readonly fetched: number;
  readonly stored: number;
  readonly hasMore: boolean;
  readonly relation: ChainRelation | "unchanged";
  readonly divergence: SyncDivergence | null;
  readonly notConfigured: boolean;
}

function defaultLeaseOwner(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return `drain-${cryptoRef.randomUUID()}`;
  }
  return `drain-${Date.now().toString(36)}`;
}

function toEnvelope(row: {
  readonly id: string;
  readonly kind: SyncPushEnvelope["kind"];
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly createdAt: string;
}): SyncPushEnvelope {
  return {
    mutationId: row.id,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    groupId: row.groupId,
    payload: row.payload,
    clientRecordedAt: row.createdAt
  };
}

function emptyDrainReport(): DrainReport {
  return {
    attempted: 0,
    synced: 0,
    retried: 0,
    rejected: 0,
    blocked: 0,
    notConfigured: false,
    outcomes: [],
    skippedReason: null
  };
}

function count(outcomes: readonly DrainOutcome[], state: DrainOutcome["state"]): number {
  return outcomes.filter((outcome) => outcome.state === state).length;
}

/**
 * The bidirectional sync engine.
 *
 * Two halves, both honest:
 *
 * - **Drain** pushes queued mutations and settles each one *only* from a server
 *   response. Transient failures back off and honour `Retry-After`; a
 *   configuration failure costs no attempt at all.
 * - **Pull** fast-forwards the local mirror, then asks whether the server's new
 *   entries link onto the head this device already holds. If they do not, a fork
 *   is recorded for a person.
 *
 * What it deliberately never does: merge, re-order, or auto-resolve. An
 * append-only hash chain has no merge, and pretending otherwise would make every
 * other guarantee in this product theatre.
 */
export class OfflineSyncEngine {
  private readonly db: SenedDatabase;
  private readonly transport: SyncTransport;
  private readonly clock: () => Date;
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly backoff: BackoffOptions;

  constructor(options: OfflineSyncEngineOptions) {
    this.db = options.db;
    this.transport = options.transport ?? new UnconfiguredSyncTransport();
    this.clock = options.clock ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? defaultLeaseOwner();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 25;
    this.backoff = {
      ...(options.backoff?.baseMs === undefined ? {} : { baseMs: options.backoff.baseMs }),
      ...(options.backoff?.maxMs === undefined ? {} : { maxMs: options.backoff.maxMs }),
      ...(options.random === undefined ? {} : { random: options.random })
    };
  }

  /**
   * Attempt one pass over the queue.
   *
   * The bearer token is a parameter, never stored. A token sitting in IndexedDB
   * is readable by any script on the origin and survives a logout that forgot to
   * clear it, so it is threaded through the call instead.
   */
  async drain(authorization: string, options: { readonly groupId?: string } = {}): Promise<DrainReport> {
    if (options.groupId) {
      const divergence = await readDivergence(this.db, options.groupId);
      if (blocksPush(divergence)) {
        return {
          ...emptyDrainReport(),
          skippedReason:
            "This group has an unresolved ledger fork. A person must review it before anything is pushed."
        };
      }
    }

    const claimed = await claimOutboxBatch(this.db, {
      now: this.clock(),
      limit: this.batchSize,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs
    });
    if (claimed.length === 0) {
      return emptyDrainReport();
    }

    const envelopes = claimed.map(toEnvelope);
    let results: readonly SyncPushResult[];
    try {
      results = await this.transport.push(authorization, envelopes);
    } catch (error) {
      return this.settleTransportFailure(claimed, error);
    }

    const byId = new Map(results.map((result) => [result.mutationId, result]));
    const outcomes: DrainOutcome[] = [];
    for (const row of claimed) {
      const result = byId.get(row.id);
      outcomes.push(result ? await this.settleResult(row.id, result) : await this.settleMissingResult(row.id, row.attempts));
    }

    if (options.groupId) {
      await recordSyncActivity(this.db, options.groupId, this.clock());
    }

    return {
      attempted: claimed.length,
      synced: count(outcomes, "synced"),
      retried: count(outcomes, "retry-scheduled"),
      rejected: count(outcomes, "rejected"),
      blocked: count(outcomes, "blocked"),
      notConfigured: false,
      outcomes,
      skippedReason: null
    };
  }

  /**
   * Where the automatic retry of a draft's payer starts. The entry is synced either
   * way; this only decides whether the payer that rode along needs a follow-up.
   *
   * - recorded, or no payer on the draft: nothing to schedule;
   * - the server refused it with a definitive answer: nothing is retried by itself
   *   (the console says why and keeps the manual button);
   * - the write failed, or the server did not say: the sync result counts as the first
   *   try when it reported a failure, and the next one is due after the backoff; a
   *   silent result is due straight away.
   */
  private async attributionScheduleFor(
    mutationId: string,
    result: SyncPushResult,
    now: Date
  ): Promise<{ readonly attempts: number; readonly nextAttemptAt: number | null } | undefined> {
    const row = await this.db.outbox.get(mutationId);
    if (!row || attributionFromPayload(row.payload) === null || result.attribution?.outcome === "RECORDED") {
      return undefined;
    }
    const refused = result.attribution?.outcome === "REFUSED";
    if (!refused) {
      return { attempts: 0, nextAttemptAt: null };
    }
    if (classifyAttributionError(result.attribution?.error ?? null) === "definitive") {
      return { attempts: 1, nextAttemptAt: null };
    }
    return {
      attempts: 1,
      nextAttemptAt: nextAttemptAtMs({ attempt: 1, nowMs: now.getTime(), retryAfterMs: null, options: this.backoff })
    };
  }

  private async settleResult(mutationId: string, result: SyncPushResult): Promise<DrainOutcome> {
    const now = this.clock();
    if (result.outcome === "ACCEPTED" || result.outcome === "REPLAYED") {
      const attributionRetry = await this.attributionScheduleFor(mutationId, result, now);
      const settled = await settleSynced(this.db, mutationId, result, {
        now,
        expectedLeaseOwner: this.leaseOwner,
        ...(attributionRetry ? { attributionRetry } : {})
      });
      return { mutationId, state: "synced", code: null, message: settled.serverEntryId };
    }

    const row = await this.db.outbox.get(mutationId);
    const attempt = (row?.attempts ?? 0) + 1;

    // A server that asks us to wait gets the wait it asked for, but only while
    // attempts remain.
    if (result.retryAfterMs !== undefined && attempt <= this.maxAttempts) {
      const settled = await settleRetry(this.db, mutationId, {
        now,
        expectedLeaseOwner: this.leaseOwner,
        errorCode: "SYNC_RATE_LIMITED",
        errorMessage: result.error ?? "The sync service asked us to slow down.",
        nextAttemptAt: nextAttemptAtMs({
          attempt,
          nowMs: now.getTime(),
          retryAfterMs: result.retryAfterMs,
          options: this.backoff
        })
      });
      return { mutationId, state: "retry-scheduled", code: "SYNC_RATE_LIMITED", message: settled.lastErrorMessage };
    }

    if (attempt > this.maxAttempts) {
      const settled = await settleTerminal(this.db, mutationId, {
        now,
        expectedLeaseOwner: this.leaseOwner,
        state: "blocked",
        errorCode: "SYNC_UNAVAILABLE",
        errorMessage: `Gave up after ${attempt} attempts. This is waiting for a person.`
      });
      return { mutationId, state: "blocked", code: "SYNC_UNAVAILABLE", message: settled.lastErrorMessage };
    }

    const settled = await settleTerminal(this.db, mutationId, {
      now,
      expectedLeaseOwner: this.leaseOwner,
      state: "rejected",
      errorCode: result.error ?? "SYNC_REJECTED",
      errorMessage: result.error ?? "The sync service rejected this mutation."
    });
    return { mutationId, state: "rejected", code: settled.lastErrorCode, message: settled.lastErrorMessage };
  }

  /**
   * The batch came back without a verdict for this row.
   *
   * Retrying is safe — the idempotency key is unchanged — and assuming success
   * is not, so this is a retry, never a settle.
   */
  private async settleMissingResult(mutationId: string, attempts: number): Promise<DrainOutcome> {
    const now = this.clock();
    const attempt = attempts + 1;
    if (attempt > this.maxAttempts) {
      const settled = await settleTerminal(this.db, mutationId, {
        now,
        expectedLeaseOwner: this.leaseOwner,
        state: "blocked",
        errorCode: "SYNC_CORRUPT_PAYLOAD",
        errorMessage: `The sync service never reported a result for this mutation across ${attempt} attempts.`
      });
      return { mutationId, state: "blocked", code: "SYNC_CORRUPT_PAYLOAD", message: settled.lastErrorMessage };
    }
    const settled = await settleRetry(this.db, mutationId, {
      now,
      expectedLeaseOwner: this.leaseOwner,
      errorCode: "SYNC_CORRUPT_PAYLOAD",
      errorMessage: "The sync service did not report a result for this mutation.",
      nextAttemptAt: nextAttemptAtMs({ attempt, nowMs: now.getTime(), retryAfterMs: null, options: this.backoff })
    });
    return {
      mutationId,
      state: "retry-scheduled",
      code: "SYNC_CORRUPT_PAYLOAD",
      message: settled.lastErrorMessage
    };
  }

  private async settleTransportFailure(
    claimed: readonly { readonly id: string; readonly attempts: number }[],
    error: unknown
  ): Promise<DrainReport> {
    const now = this.clock();
    const code: SyncError["code"] = isSyncError(error) ? error.code : "SYNC_NETWORK";
    const message = error instanceof Error ? error.message : String(error);
    const outcomes: DrainOutcome[] = [];

    // An unconfigured server is a configuration state, not a fault. Charging it
    // an attempt would strand a treasurer who spent a Sunday queueing work.
    if (isNonAttemptSyncError(code)) {
      for (const row of claimed) {
        const annotated = await annotateUnattempted(this.db, row.id, {
          errorCode: code,
          errorMessage: message,
          now
        });
        outcomes.push({
          mutationId: row.id,
          state: "queued",
          code: annotated.lastErrorCode,
          message: annotated.lastErrorMessage
        });
      }
      return {
        ...emptyDrainReport(),
        notConfigured: true,
        outcomes,
        skippedReason: message
      };
    }

    const transient = isTransientSyncError(code);
    for (const row of claimed) {
      const attempt = row.attempts + 1;
      if (!transient || attempt > this.maxAttempts) {
        const settled = await settleTerminal(this.db, row.id, {
          now,
          expectedLeaseOwner: this.leaseOwner,
          state: "blocked",
          errorCode: code,
          errorMessage: transient ? `Gave up after ${attempt} attempts: ${message}` : message
        });
        outcomes.push({
          mutationId: row.id,
          state: "blocked",
          code: settled.lastErrorCode,
          message: settled.lastErrorMessage
        });
        continue;
      }
      const settled = await settleRetry(this.db, row.id, {
        now,
        expectedLeaseOwner: this.leaseOwner,
        errorCode: code,
        errorMessage: message,
        nextAttemptAt: nextAttemptAtMs({
          attempt,
          nowMs: now.getTime(),
          retryAfterMs: isSyncError(error) ? error.retryAfterMs : null,
          options: this.backoff
        })
      });
      outcomes.push({
        mutationId: row.id,
        state: "retry-scheduled",
        code,
        message: settled.lastErrorMessage
      });
    }

    return {
      attempted: claimed.length,
      synced: 0,
      retried: count(outcomes, "retry-scheduled"),
      rejected: 0,
      blocked: count(outcomes, "blocked"),
      notConfigured: false,
      outcomes,
      skippedReason: null
    };
  }

  /**
   * Fast-forward the local mirror and check the two chains still meet.
   *
   * Paging is not an optimisation detail here: the fork check compares our head
   * with the server's *final* head, so it only runs once every page is in.
   */
  async pull(
    authorization: string,
    options: { readonly groupId: string; readonly limit?: number }
  ): Promise<PullReport> {
    const groupId = options.groupId;
    const limit = options.limit ?? 200;
    const base: PullReport = {
      groupId,
      fetched: 0,
      stored: 0,
      hasMore: false,
      relation: "unchanged",
      divergence: null,
      notConfigured: false
    };

    const meta = await readSyncMeta(this.db, groupId);
    const localHeadBefore = await getLocalChainHead(this.db, groupId);

    let sinceSequence = meta.lastPulledSequence;
    let serverHead: { lastSequence: string; lastHash: string } | null = null;
    let firstIncoming: ChainLink | null = null;
    let hasMore = true;
    let fetched = 0;
    let stored = 0;

    try {
      while (hasMore) {
        const page = await this.transport.pull(authorization, { groupId, sinceSequence, limit });
        if (page.head.groupId !== groupId) {
          throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied about a different group.");
        }
        serverHead = { lastSequence: page.head.lastSequence, lastHash: page.head.lastHash };

        const links = page.entries.map(toChainLink);
        if (links.length > 0 && firstIncoming === null) {
          firstIncoming = links[0] ?? null;
        }
        fetched += links.length;

        // A same-sequence entry with a different hash, or an entry that does not
        // descend from the head we hold, is the one thing the mirror must
        // refuse. Overwriting or appending it would leave the treasurer reading
        // a mixture of two histories as if it were one.
        const write = await storeMirrorEntries(this.db, {
          groupId,
          entries: page.entries,
          pulledAt: this.clock()
        });
        stored += write.added.length;
        const break_ = write.conflicting[0] ?? null;
        const unlinked = write.unlinked[0] ?? null;
        if (break_ || unlinked) {
          const recorded = await recordDivergence(this.db, {
            // A different entry for a sequence we hold is a rewritten hash. An
            // entry that does not descend from our head is a chain that does not
            // line up in position. Different words, because a person resolving
            // them needs to know which happened.
            kind: break_ ? "hash-mismatch" : "height-mismatch",
            detectedAt: this.clock().toISOString(),
            groupId,
            commonPrefixLength: 0,
            forkSequence: break_?.sequence ?? unlinked?.sequence ?? "0",
            localLastSequence: meta.lastPulledSequence,
            serverLastSequence: page.head.lastSequence,
            localLastHash: break_?.localHash ?? unlinked?.expectedPreviousHash ?? null,
            serverLastHash: break_?.incomingHash ?? unlinked?.receivedPreviousHash ?? page.head.lastHash,
            detail: break_
              ? "The server sent a different entry for a sequence this device already holds. " +
                "The local copy was kept, not overwritten."
              : `The server's entry at sequence ${unlinked?.sequence ?? "?"} links to ` +
                `${unlinked?.receivedPreviousHash ?? "?"} but this device's head hashes to ` +
                `${unlinked?.expectedPreviousHash ?? "?"}. It was not stored.`,
            resolution: null,
            resolvedAt: null
          });
          return {
            ...base,
            fetched,
            stored,
            hasMore: page.hasMore,
            relation: "diverged",
            divergence: recorded.divergence
          };
        }

        hasMore = page.hasMore;
        if (links.length > 0) {
          sinceSequence = links[links.length - 1]?.sequence ?? sinceSequence;
        }
      }
    } catch (error) {
      if (isSyncError(error) && error.code === "SYNC_NOT_CONFIGURED") {
        return { ...base, notConfigured: true };
      }
      throw error;
    }

    if (serverHead) {
      await recordPullProgress(this.db, {
        groupId,
        sequence: serverHead.lastSequence,
        hash: serverHead.lastHash,
        at: this.clock()
      });
    }

    const localChain = (await listMirrorChain(this.db, groupId)).map((row) => ({
      sequence: row.sequence,
      entryHash: row.entryHash,
      previousHash: row.previousHash
    }));

    // The head this device held *before* the pull is the thing the server's new
    // entries must link onto. Using the post-pull mirror instead would compare
    // the server against itself and could never detect a fork. When the mirror
    // was empty there is nothing to link onto, and `compareContinuation` treats
    // that as a first sync rather than a conflict.
    const localHead = localHeadBefore
      ? { sequence: localHeadBefore.sequence, entryHash: localHeadBefore.hash, previousHash: "" }
      : null;
    const comparison = compareContinuation({
      localHead,
      serverHead,
      firstIncoming,
      localChain
    });
    const divergence = toDivergence(comparison, {
      groupId,
      detectedAt: this.clock().toISOString(),
      localInspection: inspectLocalChain(localChain)
    });

    if (divergence) {
      await recordDivergence(this.db, divergence);
      return { ...base, fetched, stored, hasMore: false, relation: "diverged", divergence };
    }

    // A device that had nothing mirrored and has just adopted the server's
    // history is *not* "behind" once the pull is done — the two agree. Only a
    // device that already held a prefix gets the "server-ahead" reading, which
    // is the one a treasurer can act on.
    const adoptedServerHistory = localHeadBefore === null && comparison.relation === "server-ahead";
    return {
      ...base,
      fetched,
      stored,
      hasMore: false,
      relation: adoptedServerHistory ? "identical" : comparison.relation,
      divergence: null
    };
  }
}
