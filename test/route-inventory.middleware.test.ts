import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { RATE_LIMITED, isRateLimitedPath, middleware, resolveRateLimit } from "@/middleware";
import { READ_RULE, WRITE_RULE, resetRateLimits } from "@/lib/rateLimit";

/**
 * Every lane filed the same bug from three directions and none of them could
 * fix it, because `src/middleware.ts` belongs to A1.
 *
 * The defect is structural: `isRateLimitedPath` gates on the `RATE_LIMITED` set,
 * and `middleware` returns early for anything outside it. So the branches in
 * `resolveRateLimit` for `/sync`, `/pull`, `/page` and `/summary` had always
 * been unreachable, and the voice and draw routes inherited that. A route that
 * is not in the set is not "on the default rule" — it is unmetered.
 *
 * A2 R-1, A3 R-1 and A4 R1 are the three filed copies of this.
 */

const roundId = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  resetRateLimits();
});

describe("the voice routes are metered", () => {
  it("registers both provider-backed routes", () => {
    expect(RATE_LIMITED.has("/api/voice/transcribe")).toBe(true);
    expect(RATE_LIMITED.has("/api/voice/speak")).toBe(true);
  });

  it("charges them the write limit, not the generic proxy one", () => {
    expect(resolveRateLimit("/api/voice/transcribe")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/voice/speak")).toEqual(WRITE_RULE);
    expect(isRateLimitedPath("/api/voice/transcribe")).toBe(true);
  });

  it("leaves the credential-free routes unmetered", () => {
    // `/api/voice/extract` is a pure function and `/api/voice/capabilities`
    // reads no secret, so neither is billable. A2 scoped the request to the two
    // routes that spend money.
    expect(isRateLimitedPath("/api/voice/extract")).toBe(false);
    expect(isRateLimitedPath("/api/voice/capabilities")).toBe(false);
  });
});

describe("the draw routes are metered", () => {
  it("registers the literal write and read buckets", () => {
    for (const path of [
      "/api/draw/commits",
      "/api/draw/reveals",
      "/api/draw/payouts",
      "/api/draw/verify"
    ]) {
      expect(RATE_LIMITED.has(path)).toBe(true);
      expect(isRateLimitedPath(path)).toBe(true);
    }
  });

  it("separates the state-changing routes from the verification reads", () => {
    expect(resolveRateLimit("/api/draw/commits")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/reveals")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/payouts")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/verify")).toEqual(READ_RULE);
  });

  it("matches a concrete round id as well as the bracket form", () => {
    // The middleware only ever sees the resolved path.
    expect(resolveRateLimit(`/api/draw/rounds/${roundId}`)).toEqual(READ_RULE);
    expect(resolveRateLimit("/api/draw/rounds/[roundId]")).toEqual(READ_RULE);
    expect(isRateLimitedPath(`/api/draw/rounds/${roundId}`)).toBe(true);
  });

  it("does not mistake a non-uuid round segment for a round", () => {
    expect(isRateLimitedPath("/api/draw/rounds/not-a-uuid")).toBe(false);
  });
});

describe("the reserved Wave 2 sync buckets are finally reachable", () => {
  it("registers /api/sync, which resolveRateLimit already understood", () => {
    expect(RATE_LIMITED.has("/api/sync")).toBe(true);
    expect(resolveRateLimit("/api/sync")).toEqual(WRITE_RULE);
    expect(isRateLimitedPath("/api/sync")).toBe(true);
  });

  it("reaches the pull, page and summary read branches too", () => {
    // These were written for A4's client contract and have been dead code
    // since the baseline commit. They are metered on the same gate.
    for (const path of ["/api/sync/pull", "/api/sync/page", "/api/sync/summary"]) {
      expect(resolveRateLimit(path)).toEqual(READ_RULE);
    }
  });
});

describe("the limiter actually answers on these routes", () => {
  it("returns headers from the voice route instead of passing through", () => {
    const request = new NextRequest("http://localhost/api/voice/transcribe", {
      headers: { authorization: "Bearer user-token" }
    });
    const response = middleware(request);

    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(WRITE_RULE.limit));
  });

  it("returns headers from a concrete draw round", () => {
    const request = new NextRequest(`http://localhost/api/draw/rounds/${roundId}`, {
      headers: { authorization: "Bearer user-token" }
    });
    const response = middleware(request);

    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
  });

  it("throttles a caller who exhausts the write budget on a draw commit", () => {
    const url = "http://localhost/api/draw/commits";
    let last: Response | null = null;

    for (let call = 0; call <= WRITE_RULE.limit; call += 1) {
      last = middleware(
        new NextRequest(url, { headers: { authorization: "Bearer grinding-user" } })
      );
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("the governance routes are metered", () => {
  it("registers both routes", () => {
    expect(RATE_LIMITED.has("/api/governance/recommendations")).toBe(true);
    expect(RATE_LIMITED.has("/api/governance/citations")).toBe(true);
    expect(isRateLimitedPath("/api/governance/recommendations")).toBe(true);
    expect(isRateLimitedPath("/api/governance/citations")).toBe(true);
  });

  it("charges the pure engine the read rule and the ScholarXIV-backed route the write rule", () => {
    expect(resolveRateLimit("/api/governance/recommendations", "POST")).toEqual(READ_RULE);
    expect(resolveRateLimit("/api/governance/citations", "GET")).toEqual(WRITE_RULE);
  });

  it("answers with rate-limit headers", () => {
    const response = middleware(
      new NextRequest("http://localhost/api/governance/recommendations", {
        method: "POST",
        headers: { authorization: "Bearer user-token" }
      })
    );
    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
  });
});
