import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, HEAD } from "@/app/api/health/route";
import { RATE_LIMITED, isRateLimitedPath, middleware } from "@/middleware";

describe("GET /api/health", () => {
  it("answers 200 with a no-store JSON body and needs no auth or database", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers HEAD with 200 and no body", async () => {
    const response = HEAD();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("is never rate limited, however often a platform polls it", () => {
    expect(RATE_LIMITED.has("/api/health")).toBe(false);
    expect(isRateLimitedPath("/api/health")).toBe(false);
    for (let i = 0; i < 500; i += 1) {
      const res = middleware(new NextRequest("http://localhost/api/health"));
      expect(res.status).toBe(200);
    }
  });
});
