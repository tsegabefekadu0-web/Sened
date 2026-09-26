export const WRITE_RULE = { limit: 40, windowMs: 60_000 } as const;
export const READ_RULE = { limit: 120, windowMs: 60_000 } as const;
export const PROXY_RULE = { limit: 60, windowMs: 60_000 } as const;

export type RateLimitRule = typeof WRITE_RULE | typeof READ_RULE | typeof PROXY_RULE;

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
  now = Date.now()
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
    states.set(key, { count: 1, resetAt });
    return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, resetAt };
  }
  if (current.count >= rule.limit) {
    return { allowed: false, limit: rule.limit, remaining: 0, resetAt: current.resetAt };
  }
  current.count += 1;
  return {
    allowed: true,
    limit: rule.limit,
    remaining: rule.limit - current.count,
    resetAt: current.resetAt
  };
}
