import { NextResponse } from "next/server";
import { authenticateRead } from "@/lib/authRead";
import { getMyProfile, upsertMyProfile } from "@/lib/profile/server";
import { parse, profileUpdateRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16384; // allows small base64 / avatars

function jsonError(error: string, status: number, message?: string): Response {
  return NextResponse.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `GET /api/profile` — fetch the authenticated user's profile.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }

  try {
    const result = await getMyProfile(auth.client);
    if (result.status === "forbidden") {
      return jsonError("unauthorized", 401);
    }
    if (result.status !== "ok") {
      return jsonError("storage_failure", 502);
    }
    return NextResponse.json(
      { profile: result.profile },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return jsonError("storage_failure", 502);
  }
}

/**
 * `PUT /api/profile` — upsert the authenticated user's profile.
 */
export async function PUT(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }

  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType !== "application/json" && !contentType?.startsWith("application/json;")) {
    return jsonError("bad_request", 400);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonError("bad_request", 400);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return jsonError("bad_request", 400);
    }
    body = JSON.parse(raw);
  } catch {
    return jsonError("bad_request", 400);
  }

  const parsed = parse(profileUpdateRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const result = await upsertMyProfile(auth.client, parsed.data);
    if (result.status === "forbidden") {
      return jsonError("unauthorized", 401);
    }
    if (result.status === "invalid") {
      return jsonError("invalid_request", 400);
    }
    if (result.status !== "ok") {
      return jsonError("storage_failure", 502);
    }
    return NextResponse.json(
      { profile: result.profile },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return jsonError("storage_failure", 502);
  }
}
