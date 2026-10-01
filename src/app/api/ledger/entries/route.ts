import { authenticateRead } from "@/lib/authRead";
import {
  LedgerService,
  SupabaseLedgerRepository,
  isLedgerError,
  listGroupLedgerEntries,
  type LedgerEntry
} from "@/lib/ledger";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { ledgerEntriesQuerySchema, ledgerEntryRequestSchema, parse } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32_768;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function publicEntry(entry: LedgerEntry): Omit<LedgerEntry, "tenantId" | "requestFingerprint" | "idempotencyKey"> {
  return {
    id: entry.id,
    groupId: entry.groupId,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt,
    entryType: entry.entryType,
    correctsEntryId: entry.correctsEntryId,
    rationale: entry.rationale,
    actorId: entry.actorId,
    nonce: entry.nonce,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    postings: entry.postings
  };
}

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (!token) {
    return jsonError("unauthorized", 401);
  }

  const supabase = getUserScopedClient(token);
  if (!supabase) {
    return jsonError("not_configured", 503);
  }

  const authResult = await supabase.auth.getUser().catch(() => null);
  if (!authResult) {
    return jsonError("auth_unavailable", 503);
  }
  const { data, error } = authResult;
  if (error || !data.user) {
    return jsonError("unauthorized", 401);
  }
  // Write authorization is the caller's role in the group, enforced by
  // post_ledger_entry_v1 against ledger_group_memberships; a refusal comes back
  // as FORBIDDEN below. The JWT carries no role and is not consulted.

  const contentType = request.headers.get("content-type")?.toLowerCase();
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    !contentType?.startsWith("application/json") ||
    (contentType !== "application/json" && !contentType.startsWith("application/json;"))
  ) {
    return jsonError("bad_request", 400);
  }
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonError("bad_request", 400);
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonError("bad_request", 400);
    }
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return jsonError("bad_request", 400);
  }

  const parsed = parse(ledgerEntryRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const service = new LedgerService(new SupabaseLedgerRepository(supabase));
    const result = await service.append(parsed.data, { actorId: data.user.id });
    return Response.json(
      { entry: publicEntry(result.entry), replayed: result.replayed },
      {
        status: result.replayed ? 200 : 201,
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch (error) {
    if (!isLedgerError(error)) {
      return jsonError("ledger_write_failed", 502);
    }
    switch (error.code) {
      case "NOT_FOUND":
        return jsonError("not_found", 404);
      case "FORBIDDEN":
        return jsonError("forbidden", 403);
      case "IDEMPOTENCY_CONFLICT":
        return jsonError("idempotency_conflict", 409);
      case "INVALID_AMOUNT":
      case "INVALID_REQUEST":
      case "UNBALANCED":
      case "INVALID_CORRECTION":
        return jsonError("unprocessable_ledger_entry", 422);
      case "UNAVAILABLE":
        return jsonError("ledger_unavailable", 503);
      case "STORAGE_FAILURE":
      case "INTEGRITY_FAILURE":
        return jsonError("ledger_write_failed", 502);
    }
  }
}

/**
 * `GET /api/ledger/entries?groupId=<uuid>[&limit=1..100]` — a group's entries,
 * newest first, each with its postings. Read-only.
 *
 * What the O-3 correction form needs in order to name the entry it corrects.
 * Authorization is the tables' own row-level security under the caller's JWT:
 * any active member of the group may read it (the write route's treasurer role
 * is a *write* gate and deliberately not applied here). A group the caller
 * cannot see is 404, whether it is absent or merely not theirs.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return jsonError(auth.error, auth.status);
  }

  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = params[key];
    params[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  const parsed = parse(ledgerEntriesQuerySchema, params);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }

  try {
    const entries = await listGroupLedgerEntries(auth.client, parsed.data.groupId, parsed.data.limit);
    if (entries === null) {
      return jsonError("not_found", 404);
    }
    return Response.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return jsonError("storage_failure", 502);
  }
}
