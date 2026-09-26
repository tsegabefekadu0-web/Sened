import { SyncError } from "./contract";

export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_LEASE_MS = 30_000;

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Injected in tests so jitter does not make assertions flaky. */
  readonly random?: () => number;
}

/**
 * Exponential backoff with jitter.
 *
 * The window is `[ceiling/4, ceiling]` where `ceiling = base * 2^(attempt-1)`.
 *
 * Jitter rather than a fixed curve because the failure this protects against is
 * a shared one: a room full of treasurers all coming back online when the
 * venue's wifi returns, all retrying the same endpoint on the same schedule. A
 * deterministic curve would keep them synchronised forever.
 *
 * The quarter floor rather than full jitter (0..ceiling) because a full-jitter
 * draw can land on 0, and a client that retries instantly on every failure is
 * a small denial-of-service tool aimed at its own sync service.
 *
 * `attempt` is 1-based: the delay *after* the first failure.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;

  // Cap the exponent before shifting so a long-lived row cannot overflow into
  // Infinity and make the jitter meaningless.
  const exponent = Math.min(safeAttempt - 1, 30);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const floor = Math.max(1, Math.round(ceiling / 4));
  return Math.round(floor + random() * Math.max(0, ceiling - floor));
}

/**
 * Parse a `Retry-After` header into a delay.
 *
 * Accepts both forms from RFC 9110: delta-seconds and an HTTP-date. An
 * unparseable value returns null so the caller falls back to computed backoff
 * rather than retrying instantly against a server that asked us to wait.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | null {
  if (typeof header !== "string") {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.min(seconds * 1_000, DEFAULT_MAX_BACKOFF_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.min(Math.max(0, at - now), DEFAULT_MAX_BACKOFF_MS);
}

/**
 * How long until a mutation may be tried again.
 *
 * A server-supplied `Retry-After` always wins over the computed curve — the
 * server knows when it will be ready and we do not.
 */
export function nextAttemptAtMs(input: {
  readonly attempt: number;
  readonly nowMs: number;
  readonly retryAfterMs: number | null;
  readonly options?: BackoffOptions;
}): number {
  if (input.retryAfterMs !== null && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0) {
    return input.nowMs + input.retryAfterMs;
  }
  return input.nowMs + computeBackoffMs(input.attempt, input.options);
}

export function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be a positive whole number`);
  }
  return value;
}
