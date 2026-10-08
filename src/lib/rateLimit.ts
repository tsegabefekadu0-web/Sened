export const WRITE_RULE = { limit: 40, windowMs: 60_000 } as const;
export const READ_RULE = { limit: 120, windowMs: 60_000 } as const;
export const PROXY_RULE = { limit: 60, windowMs: 60_000 } as const;

/**
 * `/api/sync` is metered in the handler, where the body is known: a push is
 * charged one unit per entry it carries (so a full batch of 25 is 25 units, and
 * a token cannot post ~1000 entries a minute through 40 requests), and a pull
 * has a bucket of its own so reading never starves writing.
 */
export const SYNC_PUSH_ENTRIES_RULE = { limit: 100, windowMs: 60_000 } as const;
export const SYNC_PULL_RULE = { limit: 60, windowMs: 60_000 } as const;

export type RateLimitRule =
  | typeof WRITE_RULE
  | typeof READ_RULE
  | typeof PROXY_RULE
  | typeof SYNC_PUSH_ENTRIES_RULE
  | typeof SYNC_PULL_RULE;

interface RateLimitState {
  count: number;
  resetAt: number;
}

const states = new Map<string, RateLimitState>();

export function resetRateLimits(): void {
  states.clear();
}

export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
  /** How many units this call spends; a batch of 25 entries spends 25. */
  cost = 1
): {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
} {
  const current = states.get(key);
  if (!current || current.resetAt <= now) {
    if (!current && states.size >= 10_000) {
      for (const [stateKey, state] of states) {
        if (state.resetAt <= now) {
          states.delete(stateKey);
        }
      }
      if (states.size >= 10_000) {
        const oldestKey = states.keys().next().value;
        if (oldestKey) {
          states.delete(oldestKey);
        }
      }
    }
    const resetAt = now + rule.windowMs;
    if (cost > rule.limit) {
      return { allowed: false, limit: rule.limit, remaining: 0, resetAt };
    }
    states.set(key, { count: cost, resetAt });
    return { allowed: true, limit: rule.limit, remaining: rule.limit - cost, resetAt };
  }
  if (current.count + cost > rule.limit) {
    return { allowed: false, limit: rule.limit, remaining: Math.max(0, rule.limit - current.count), resetAt: current.resetAt };
  }
  current.count += cost;
  return {
    allowed: true,
    limit: rule.limit,
    remaining: rule.limit - current.count,
    resetAt: current.resetAt
  };
}
