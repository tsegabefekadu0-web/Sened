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
const cycleId = "66666666-6666-4666-8666-666666666666";
const drawId = "77777777-7777-4777-8777-777777777777";

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

describe("the cycle, draw, seal and nonce routes are metered", () => {
  it("registers every literal bucket", () => {
    for (const path of [
      "/api/draw/cycles",
      "/api/draw/cycles/[cycleId]",
      "/api/draw/draws",
      "/api/draw/draws/[drawId]",
      "/api/draw/seals",
      "/api/draw/nonces"
    ]) {
      expect(RATE_LIMITED.has(path), path).toBe(true);
      expect(isRateLimitedPath(path), path).toBe(true);
    }
  });

  it("charges the writes the write rule and the reads the read rule", () => {
    // Creating a cycle, opening a draw, sealing and releasing a nonce all write
    // state a ceremony depends on.
    expect(resolveRateLimit("/api/draw/cycles", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/draws", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/seals", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/nonces", "POST")).toEqual(WRITE_RULE);
    // The cycles path carries both the list and the create, so the method picks.
    expect(resolveRateLimit("/api/draw/cycles", "GET")).toEqual(READ_RULE);
    expect(resolveRateLimit(`/api/draw/cycles/${cycleId}`, "GET")).toEqual(READ_RULE);
    expect(resolveRateLimit(`/api/draw/draws/${drawId}`, "GET")).toEqual(READ_RULE);
  });

  it("matches a concrete id as well as the bracket form, and not a non-uuid", () => {
    expect(isRateLimitedPath(`/api/draw/cycles/${cycleId}`)).toBe(true);
    expect(isRateLimitedPath(`/api/draw/draws/${drawId}`)).toBe(true);
    expect(isRateLimitedPath("/api/draw/cycles/not-a-uuid")).toBe(false);
    expect(isRateLimitedPath("/api/draw/draws/not-a-uuid")).toBe(false);
  });

  it("answers with the headers that match the method", () => {
    const read = middleware(
      new NextRequest("http://localhost/api/draw/cycles?groupId=x", { method: "GET", headers: { authorization: "Bearer t" } })
    );
    expect(read.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
    const write = middleware(
      new NextRequest("http://localhost/api/draw/seals", { method: "POST", headers: { authorization: "Bearer t" } })
    );
    expect(write.headers.get("X-RateLimit-Limit")).toBe(String(WRITE_RULE.limit));
  });

  it("throttles a member who hammers the seal route", () => {
    const url = "http://localhost/api/draw/seals";
    let last: Response | null = null;
    for (let call = 0; call <= WRITE_RULE.limit; call += 1) {
      last = middleware(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer sealer" } }));
    }
    expect(last?.status).toBe(429);
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

describe("the ledger read routes are metered with the read rule", () => {
  it("registers the entries and balances reads", () => {
    for (const path of ["/api/ledger/entries", "/api/ledger/balances"]) {
      expect(RATE_LIMITED.has(path)).toBe(true);
      expect(isRateLimitedPath(path)).toBe(true);
    }
  });

  it("charges the balances read READ_RULE for GET", () => {
    expect(resolveRateLimit("/api/ledger/balances", "GET")).toEqual(READ_RULE);
  });

  it("answers with the read headers on /api/ledger/balances", () => {
    const response = middleware(
      new NextRequest("http://localhost/api/ledger/balances", { headers: { authorization: "Bearer reader" } })
    );
    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
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

describe("the reconciliation drain is metered", () => {
  it("registers the cron route and charges it the write rule", () => {
    expect(RATE_LIMITED.has("/api/reconciliation/drain")).toBe(true);
    expect(isRateLimitedPath("/api/reconciliation/drain")).toBe(true);
    expect(resolveRateLimit("/api/reconciliation/drain", "POST")).toEqual(WRITE_RULE);
  });

  it("answers with rate-limit headers and throttles a hammering caller", () => {
    const url = "http://localhost/api/reconciliation/drain";
    const first = middleware(
      new NextRequest(url, { method: "POST", headers: { authorization: "Bearer cron" } })
    );
    expect(first.headers.get("X-RateLimit-Limit")).toBe(String(WRITE_RULE.limit));

    let last: Response = first;
    for (let call = 0; call <= WRITE_RULE.limit; call += 1) {
      last = middleware(
        new NextRequest(url, { method: "POST", headers: { authorization: "Bearer cron" } })
      );
    }
    expect(last.status).toBe(429);
  });
});

describe("the attribution and collateral routes are metered", () => {
  it("registers every literal bucket", () => {
    for (const path of ["/api/ledger/attributions", "/api/draw/collateral", "/api/draw/guarantees"]) {
      expect(RATE_LIMITED.has(path), path).toBe(true);
      expect(isRateLimitedPath(path), path).toBe(true);
    }
  });

  it("charges the appends the write rule and the derived collateral view the read rule", () => {
    // POST records and PUT corrects an attribution; both append a row.
    expect(resolveRateLimit("/api/ledger/attributions", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/ledger/attributions", "PUT")).toEqual(WRITE_RULE);
    // One POST carries propose / accept / decline / release / supersede.
    expect(resolveRateLimit("/api/draw/guarantees", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/collateral", "GET")).toEqual(READ_RULE);
  });

  it("answers with the headers that match the route and throttles a hammering caller", () => {
    const read = middleware(
      new NextRequest(`http://localhost/api/draw/collateral?cycleId=${cycleId}`, {
        method: "GET",
        headers: { authorization: "Bearer t" }
      })
    );
    expect(read.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
    const url = "http://localhost/api/draw/guarantees";
    let last: Response | null = null;
    for (let call = 0; call <= WRITE_RULE.limit; call += 1) {
      last = middleware(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer guarantor" } }));
    }
    expect(last?.status).toBe(429);
    const attribution = middleware(
      new NextRequest("http://localhost/api/ledger/attributions", { method: "POST", headers: { authorization: "Bearer a" } })
    );
    expect(attribution.headers.get("X-RateLimit-Limit")).toBe(String(WRITE_RULE.limit));
  });
});

describe("the contribution grid and gate routes are metered", () => {
  it("registers both literal buckets", () => {
    for (const path of ["/api/draw/contributions", "/api/draw/gate"]) {
      expect(RATE_LIMITED.has(path), path).toBe(true);
      expect(isRateLimitedPath(path), path).toBe(true);
    }
  });

  it("charges the policy change the write rule and the derived grid the read rule", () => {
    expect(resolveRateLimit("/api/draw/gate", "POST")).toEqual(WRITE_RULE);
    expect(resolveRateLimit("/api/draw/contributions", "GET")).toEqual(READ_RULE);
  });

  it("answers with the headers that match the route and throttles a hammering caller", () => {
    const read = middleware(
      new NextRequest(`http://localhost/api/draw/contributions?cycleId=${cycleId}`, { method: "GET", headers: { authorization: "Bearer grid" } })
    );
    expect(read.headers.get("X-RateLimit-Limit")).toBe(String(READ_RULE.limit));
    let last: Response | null = null;
    for (let call = 0; call <= WRITE_RULE.limit; call += 1) {
      last = middleware(new NextRequest("http://localhost/api/draw/gate", { method: "POST", headers: { authorization: "Bearer gate" } }));
    }
    expect(last?.status).toBe(429);
  });
});
