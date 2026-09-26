import { LedgerService, SupabaseLedgerRepository, isLedgerError, type LedgerEntry } from "@/lib/ledger";
import { canWriteLedger } from "@/lib/roles";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { ledgerEntryRequestSchema, parse } from "@/lib/validation";

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
  if (!canWriteLedger(data.user)) {
    return jsonError("forbidden", 403);
  }

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
