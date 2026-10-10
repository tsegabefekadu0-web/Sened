import { NextResponse } from "next/server";
import { authenticateRead } from "@/lib/authRead";
import { createCommunityOnServer } from "@/lib/community/server";
import { communityCreateRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2048;

function jsonError(error: string, status: number, message?: string): Response {
  return NextResponse.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `POST /api/community` — create an Equb or Iddir community on the server.
 * Provisions the group, assigns the creator as owner/treasurer, seeds the chart of
 * accounts, and generates an initial invite link.
 */
export async function POST(request: Request): Promise<Response> {
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

  const parsed = parse(communityCreateRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const url = new URL(request.url);
    const origin = url.origin;
    const result = await createCommunityOnServer(auth.client, parsed.data, origin);

    if (result.status === "forbidden") {
      return jsonError("unauthorized", 401);
    }
    if (result.status === "invalid") {
      return jsonError("invalid_request", 400);
    }
    if (result.status !== "ok") {
      return jsonError("creation_failed", 502);
    }

    return NextResponse.json(
      { community: result.community },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return jsonError("creation_failed", 502);
  }
}
