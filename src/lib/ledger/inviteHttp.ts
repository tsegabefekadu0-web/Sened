import "server-only";

import type { InviteFailure } from "@/lib/ledger/invites";

/**
 * Shared HTTP plumbing for the invite and member routes. Every response is
 * `Cache-Control: no-store`; an error body never contains request input (the
 * redeem token in particular).
 */

export const INVITE_MAX_BODY_BYTES = 1_024;

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The same status mapping as the member-roles route, plus 410 for dead invites. */
export function failureResponse(failure: InviteFailure): Response {
  switch (failure.status) {
    case "forbidden":
      return jsonError("forbidden", 403);
    case "not-found":
      return jsonError("not_found", 404);
    case "invalid":
      return jsonError("unprocessable_invite", 422);
    case "expired":
      return jsonError("invite_expired", 410);
    case "revoked":
      return jsonError("invite_revoked", 410);
    case "exhausted":
      return jsonError("invite_exhausted", 410);
  }
}

/** Parse a small JSON POST body, or return the 400 response to send. */
export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType !== "application/json" && !contentType?.startsWith("application/json;")) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > INVITE_MAX_BODY_BYTES) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > INVITE_MAX_BODY_BYTES) {
      return { ok: false, response: jsonError("bad_request", 400) };
    }
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
}

export function queryParams(request: Request): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = params[key];
    params[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return params;
}
