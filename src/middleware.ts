import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, PROXY_RULE, READ_RULE, WRITE_RULE, type RateLimitRule } from "@/lib/rateLimit";

export const RATE_LIMITED = new Set([
  "/api/ledger/entries",
  "/api/bank-verifications",
  "/api/bank-verifications/[verificationId]"
]);

const BANK_VERIFICATION_ID_PATH = /^\/api\/bank-verifications\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isBankVerificationReadPath(pathname: string): boolean {
  return pathname === "/api/bank-verifications/[verificationId]" || BANK_VERIFICATION_ID_PATH.test(pathname);
}

export function isRateLimitedPath(pathname: string): boolean {
  return RATE_LIMITED.has(pathname) || isBankVerificationReadPath(pathname);
}

export function resolveRateLimit(pathname: string): RateLimitRule {
  if (pathname === "/api/bank-verifications") {
    return WRITE_RULE;
  }
  if (isBankVerificationReadPath(pathname)) {
    return READ_RULE;
  }
  if (pathname.endsWith("/sync")) {
    return WRITE_RULE;
  }
  if (pathname.endsWith("/pull") || pathname.endsWith("/page") || pathname.endsWith("/summary")) {
    return READ_RULE;
  }
  return PROXY_RULE;
}

function rateLimitIdentity(request: NextRequest): string {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    let hash = 2166136261;
    for (let index = 0; index < authorization.length; index += 1) {
      hash ^= authorization.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `subject:${(hash >>> 0).toString(16)}`;
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

export function middleware(request: NextRequest): NextResponse {
  if (!isRateLimitedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const rule = resolveRateLimit(request.nextUrl.pathname);
  const key = `${request.nextUrl.pathname}:${rule.limit}:${rateLimitIdentity(request)}`;
  const result = consumeRateLimit(key, rule);
  if (!result.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000))
        }
      }
    );
  }
  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  return response;
}

export const config = {
  matcher: "/api/:path*"
};
