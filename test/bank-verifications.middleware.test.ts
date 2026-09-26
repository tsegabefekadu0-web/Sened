import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { RATE_LIMITED, isRateLimitedPath, middleware, resolveRateLimit } from "@/middleware";
import { consumeRateLimit, READ_RULE, WRITE_RULE, resetRateLimits } from "@/lib/rateLimit";

const verificationId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  resetRateLimits();
});

describe("bank verification route rate limiting", () => {
  it("registers the exact write and read route buckets", () => {
    expect(RATE_LIMITED.has("/api/bank-verifications")).toBe(true);
    expect(RATE_LIMITED.has("/api/bank-verifications/[verificationId]")).toBe(true);
    expect(resolveRateLimit("/api/bank-verifications")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/bank-verifications/[verificationId]")).toEqual(READ_RULE);
    expect(resolveRateLimit(`/api/bank-verifications/${verificationId}`)).toEqual(READ_RULE);
  });

  it("keeps the existing ledger route on its existing proxy bucket", () => {
    expect(resolveRateLimit("/api/ledger/entries")).toEqual({
      limit: 60,
      windowMs: 60_000
    });
  });

  it("applies the read rule to a concrete verification identifier", () => {
    const request = new NextRequest(`http://localhost/api/bank-verifications/${verificationId}`, {
      headers: { authorization: "Bearer user-token" }
    });
    const response = middleware(request);

    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
  });

  it("enforces the configured write and read limits", () => {
    for (let request = 0; request < WRITE_RULE.limit; request += 1) {
      expect(consumeRateLimit("write-user", WRITE_RULE).allowed).toBe(true);
    }
    expect(consumeRateLimit("write-user", WRITE_RULE).allowed).toBe(false);

    for (let request = 0; request < READ_RULE.limit; request += 1) {
      expect(consumeRateLimit("read-user", READ_RULE).allowed).toBe(true);
    }
    expect(consumeRateLimit("read-user", READ_RULE).allowed).toBe(false);
    expect(isRateLimitedPath(`/api/bank-verifications/${verificationId}`)).toBe(true);
  });
});
