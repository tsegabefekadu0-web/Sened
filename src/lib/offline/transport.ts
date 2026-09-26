import { SyncError, type SyncPullQuery, type SyncPullResult, type SyncPushEnvelope, type SyncPushResult, type SyncTransport } from "./contract";
import { parseRetryAfterMs } from "./backoff";

/**
 * Transports for the Wave 2 `/api/sync` contract.
 *
 * Two implementations, and the default matters:
 *
 * 1. `UnconfiguredSyncTransport` — the one actually wired up. It fails closed
 *    with `SYNC_NOT_CONFIGURED`. This is the honest state today: Wave 2 has no
 *    server route, so a queued contribution must stay visibly queued rather
 *    than be quietly reported as synced. Same standard as the M2 dashboard's
 *    "Not configured" panel.
 * 2. `HttpSyncTransport` — the real client, written now against a mocked
 *    `fetch` so its status mapping is proven before the route exists. It
 *    reports a 404 as `SYNC_NOT_CONFIGURED`, because a missing route *is* an
 *    unconfigured server, not an error to retry forever.
 *
 * Nothing here fabricates a success. A `push` that returns 200 without a
 * well-formed body is an error, not an acceptance.
 */

export class UnconfiguredSyncTransport implements SyncTransport {
  readonly reason: string;

  constructor(reason = "The Sened sync service has not been deployed yet, so nothing can leave this device.") {
    this.reason = reason;
  }

  async push(_authorization: string, _envelopes: readonly SyncPushEnvelope[]): Promise<readonly SyncPushResult[]> {
    throw new SyncError("SYNC_NOT_CONFIGURED", this.reason);
  }

  async pull(_authorization: string, _query: SyncPullQuery): Promise<SyncPullResult> {
    throw new SyncError("SYNC_NOT_CONFIGURED", this.reason);
  }
}

export interface HttpSyncTransportOptions {
  /** Defaults to same-origin `/api/sync`. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Largest batch the client will send in one call. */
  readonly maxBatchSize?: number;
}

export const DEFAULT_SYNC_BASE_URL = "/api/sync";
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000;
export const DEFAULT_SYNC_MAX_BATCH = 25;
const MAX_RESPONSE_BYTES = 1_048_576;

/** Map an HTTP status onto the client's error vocabulary. */
function statusToErrorCode(status: number): { code: SyncError["code"]; message: string } {
  if (status === 401) {
    return { code: "SYNC_UNAUTHENTICATED", message: "Sign in again before syncing." };
  }
  if (status === 403) {
    return { code: "SYNC_FORBIDDEN", message: "This account is not allowed to sync this group." };
  }
  if (status === 404) {
    return {
      code: "SYNC_NOT_CONFIGURED",
      message: "This device has no sync service to talk to, so the queue is staying put."
    };
  }
  if (status === 409) {
    return {
      code: "SYNC_IDEMPOTENCY_CONFLICT",
      message: "The server already has a different entry under this key. A person must resolve it."
    };
  }
  if (status === 422) {
    return { code: "SYNC_REJECTED", message: "The server rejected this entry under the ledger rules." };
  }
  if (status === 429) {
    return { code: "SYNC_RATE_LIMITED", message: "The server asked us to slow down." };
  }
  if (status >= 500) {
    return { code: "SYNC_UNAVAILABLE", message: "The sync service is unavailable." };
  }
  return { code: "SYNC_REJECTED", message: `The sync service replied with ${status}.` };
}

function assertAuthorization(authorization: string): void {
  if (typeof authorization !== "string" || authorization.trim().length === 0) {
    // No token, no request. The token is never cached in IndexedDB, so this
    // fires rather than silently sending an unauthenticated mutation.
    throw new SyncError("SYNC_UNAUTHENTICATED", "A bearer token is required to sync, and none is available.");
  }
}

export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBatchSize: number;

  constructor(options: HttpSyncTransportOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_SYNC_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_SYNC_MAX_BATCH;
    const impl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    if (!impl) {
      throw new SyncError("SYNC_NOT_CONFIGURED", "This runtime has no fetch implementation.");
    }
    this.fetchImpl = impl;
  }

  async push(
    authorization: string,
    envelopes: readonly SyncPushEnvelope[]
  ): Promise<readonly SyncPushResult[]> {
    assertAuthorization(authorization);
    if (envelopes.length === 0) {
      return [];
    }
    if (envelopes.length > this.maxBatchSize) {
      throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Refusing to send more mutations than one batch allows.");
    }

    const body = await this.request(authorization, "POST", { mutations: envelopes });
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied without a results array.");
    }
    return results.map((value, index) => parsePushResult(value, envelopes[index]?.mutationId));
  }

  async pull(authorization: string, query: SyncPullQuery): Promise<SyncPullResult> {
    assertAuthorization(authorization);
    const body = await this.request(authorization, "POST", {
      groupId: query.groupId,
      sinceSequence: query.sinceSequence,
      limit: query.limit
    });
    return parsePullResult(body, query.groupId);
  }

  private async request(authorization: string, method: "POST", payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method,
        headers: {
          "content-type": "application/json",
          authorization
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit"
      });
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError") {
        throw new SyncError("SYNC_TIMEOUT", "The sync service did not answer in time.", { cause: error });
      }
      throw new SyncError("SYNC_NETWORK", "This device could not reach the sync service.", { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const { code, message } = statusToErrorCode(response.status);
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      throw new SyncError(code, message, { ...(retryAfterMs === null ? {} : { retryAfterMs }) });
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied with an unexpectedly large body.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied with something that is not JSON.", {
        cause: error
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePushResult(value: unknown, fallbackMutationId: string | undefined): SyncPushResult {
  if (!isRecord(value) || typeof value.mutationId !== "string" || value.mutationId.length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "A sync result was missing its mutation id.");
  }
  if (value.outcome !== "ACCEPTED" && value.outcome !== "REPLAYED" && value.outcome !== "REJECTED") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `A sync result had an unknown outcome for ${value.mutationId}.`);
  }
  if (fallbackMutationId !== undefined && fallbackMutationId !== value.mutationId) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service returned a result for an unknown mutation.");
  }
  const result: SyncPushResult = {
    mutationId: value.mutationId,
    outcome: value.outcome,
    ...(typeof value.serverEntryId === "string" ? { serverEntryId: value.serverEntryId } : {}),
    ...(typeof value.serverEntryHash === "string" ? { serverEntryHash: value.serverEntryHash } : {}),
    ...(typeof value.serverSequence === "string" ? { serverSequence: value.serverSequence } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {})
  };
  if ((result.outcome === "ACCEPTED" || result.outcome === "REPLAYED") && (!result.serverEntryId || !result.serverEntryHash)) {
    throw new SyncError(
      "SYNC_CORRUPT_PAYLOAD",
      `The sync service claimed ${result.outcome.toLowerCase()} for ${result.mutationId} without an entry id and hash.`
    );
  }
  return result;
}

function parsePullResult(value: unknown, groupId: string): SyncPullResult {
  if (!isRecord(value)) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied with an unreadable pull result.");
  }
  const head = value.head;
  if (
    !isRecord(head) ||
    typeof head.lastSequence !== "string" ||
    typeof head.lastHash !== "string" ||
    typeof head.groupId !== "string" ||
    typeof head.tenantId !== "string"
  ) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied without a usable chain head.");
  }
  if (head.groupId !== groupId) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied about a different group than we asked for.");
  }
  if (!Array.isArray(value.entries)) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied without an entries array.");
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.groupId !== "string" ||
      typeof entry.sequence !== "string" ||
      typeof entry.entryHash !== "string" ||
      typeof entry.previousHash !== "string" ||
      typeof entry.occurredAt !== "string" ||
      typeof entry.recordedAt !== "string" ||
      typeof entry.entryType !== "string" ||
      typeof entry.actorId !== "string" ||
      typeof entry.nonce !== "string" ||
      (entry.correctsEntryId !== null && typeof entry.correctsEntryId !== "string") ||
      (entry.rationale !== null && typeof entry.rationale !== "string") ||
      !Array.isArray(entry.postings)
    ) {
      throw new SyncError("SYNC_CORRUPT_PAYLOAD", "The sync service replied with an invalid ledger entry.");
    }
    return entry as unknown as SyncPullResult["entries"][number];
  });
  return {
    groupId: head.groupId,
    head: {
      groupId: head.groupId,
      tenantId: head.tenantId,
      lastSequence: head.lastSequence,
      lastHash: head.lastHash
    },
    entries,
    hasMore: value.hasMore === true
  };
}
