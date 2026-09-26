import { beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMITED, resolveRateLimit } from "@/middleware";
import { consumeRateLimit, PROXY_RULE, resetRateLimits } from "@/lib/rateLimit";

beforeEach(() => {
  resetRateLimits();
});

describe("ledger route rate limiting", () => {
  it("registers the exact write endpoint and resolves the proxy bucket", () => {
    expect(RATE_LIMITED.has("/api/ledger/entries")).toBe(true);
    expect(resolveRateLimit("/api/ledger/entries")).toEqual(PROXY_RULE);
  });

  it("returns 429 state after the bounded request count", () => {
    for (let request = 0; request < PROXY_RULE.limit; request += 1) {
      expect(consumeRateLimit("client", PROXY_RULE, 1000).allowed).toBe(true);
    }

    expect(consumeRateLimit("client", PROXY_RULE, 1000)).toMatchObject({
      allowed: false,
      remaining: 0
    });
  });
});
