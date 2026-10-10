import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/health` — liveness only, for the host's health check and the
 * keep-warm workflow. No auth, no database call: it must answer even when
 * Supabase is down, and it must cost nothing when polled. It is deliberately
 * NOT in the middleware's RATE_LIMITED set, so it is never throttled.
 */
export function GET(): Response {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export function HEAD(): Response {
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
