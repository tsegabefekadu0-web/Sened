import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, PROXY_RULE, READ_RULE, WRITE_RULE, type RateLimitRule } from "@/lib/rateLimit";

/**
 * Every metered route, in one place.
 *
 * This set is the gate: `middleware` returns `NextResponse.next()` at the top
 * for anything not in it, so a route missing from this list is unmetered no
 * matter what `resolveRateLimit` would have said. Each lane filed the gap
 * rather than editing this file — A2 R-1, A3 R-1, A4 R1 — and all three are
 * closed here.
 */
export const RATE_LIMITED = new Set([
  "/api/ledger/entries",
  "/api/ledger/member-roles",
  // Invite links: create/list share one path (the method picks the rule),
  // redeem and revoke are writes, the member list is a read.
  "/api/ledger/invites",
  "/api/ledger/invites/redeem",
  "/api/ledger/invites/revoke",
  "/api/ledger/members",
  "/api/bank-verifications",
  "/api/bank-verifications/[verificationId]",
  // A2: these two shell out to a third-party speech provider.
  "/api/voice/transcribe",
  "/api/voice/speak",
  // A3: commit-reveal draws. `/api/draw/payouts` was not in the filed request
  // but posts a real ledger disbursement, so it is metered as a write too.
  "/api/draw/commits",
  "/api/draw/reveals",
  "/api/draw/payouts",
  "/api/draw/verify",
  "/api/draw/rounds/[roundId]",
  // A4: Wave 2's sync route. The branch in `resolveRateLimit` already existed
  // and was unreachable until this entry existed.
  "/api/sync",
  // A1: the two client reads the voice -> bank hand-off needs. A treasurer
  // cannot name a binding without one, so these are on the path to verifying
  // anything at all, and they return account metadata.
  "/api/bank-account-bindings",
  "/api/my-groups",
  // M5: the recommendation engine is a pure read-sized call; the citations
  // route spends the server's ScholarXIV key, so it takes the write rule like
  // the other third-party-backed routes.
  "/api/governance/recommendations",
  "/api/governance/citations"
]);

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const BANK_VERIFICATION_ID_PATH = new RegExp(`^/api/bank-verifications/${UUID_SOURCE}$`, "i");
const DRAW_ROUND_PATH = new RegExp(`^/api/draw/rounds/${UUID_SOURCE}$`, "i");

function isBankVerificationReadPath(pathname: string): boolean {
  return pathname === "/api/bank-verifications/[verificationId]" || BANK_VERIFICATION_ID_PATH.test(pathname);
}

/**
 * `request.nextUrl.pathname` is the concrete path, never the `[param]` form,
 * so a dynamic segment needs its own matcher as well as its set entry.
 */
function isDrawRoundPath(pathname: string): boolean {
  return pathname === "/api/draw/rounds/[roundId]" || DRAW_ROUND_PATH.test(pathname);
}

export function isRateLimitedPath(pathname: string): boolean {
  return RATE_LIMITED.has(pathname) || isBankVerificationReadPath(pathname) || isDrawRoundPath(pathname);
}

export function resolveRateLimit(pathname: string, method = "POST"): RateLimitRule {
  if (pathname === "/api/ledger/invites") {
    return method === "GET" ? READ_RULE : WRITE_RULE;
  }
  if (pathname === "/api/ledger/invites/redeem" || pathname === "/api/ledger/invites/revoke") {
    return WRITE_RULE;
  }
  if (pathname === "/api/ledger/members") {
    return READ_RULE;
  }
  if (pathname === "/api/bank-verifications" || pathname === "/api/ledger/member-roles") {
    return WRITE_RULE;
  }
  if (isBankVerificationReadPath(pathname)) {
    return READ_RULE;
  }
  // A client read: the treasurer's own bindings and groups. Read-sized traffic
  // at worst, but it is account metadata, so it is metered rather than free.
  if (pathname === "/api/bank-account-bindings" || pathname === "/api/my-groups") {
    return READ_RULE;
  }
  // A3: a commitment, a reveal and a payout all change money or the record
  // that decides who gets it. Verify and round reads are cheap and idempotent.
  if (
    pathname === "/api/draw/commits" ||
    pathname === "/api/draw/reveals" ||
    pathname === "/api/draw/payouts"
  ) {
    return WRITE_RULE;
  }
  if (pathname === "/api/draw/verify" || isDrawRoundPath(pathname)) {
    return READ_RULE;
  }
  // A2: transcription and synthesis are billable third-party calls, so they
  // take the strictest rule the module has rather than the generic proxy one.
  if (pathname === "/api/voice/transcribe" || pathname === "/api/voice/speak") {
    return WRITE_RULE;
  }
  if (pathname === "/api/governance/recommendations") {
    return READ_RULE;
  }
  if (pathname === "/api/governance/citations") {
    return WRITE_RULE;
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
  const rule = resolveRateLimit(request.nextUrl.pathname, request.method);
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
