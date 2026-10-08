import { authenticateRead } from "@/lib/authRead";
import {
  LedgerService,
  SupabaseLedgerRepository,
  isLedgerError,
  readGroupLedgerPage,
  type LedgerEntry
} from "@/lib/ledger";
import { recordAttribution, type AttributionResult } from "@/lib/ledger/attribution";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import {
  ledgerEntriesQuerySchema,
  ledgerEntryAttributionSchema,
  ledgerEntryRequestSchema,
  parse
} from "@/lib/validation";

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

/**
 * What became of the optional `attribution` (payer, optional cycle/round, optional
 * `channel` and `note`) that rode along on a contribution post. The entry and its attribution are two writes: the ledger is the source of
 * truth and is never held back by, or rolled back for, the second one, so a refused
 * attribution is REPORTED (`status: "refused"` with the database's own code) and
 * the treasurer attributes the row afterwards (`POST /api/ledger/attributions`).
 */
type AttributionOutcome =
  | { readonly status: "recorded"; readonly replayed: boolean }
  | { readonly status: "refused"; readonly error: string }
  | { readonly status: "failed" };

function describeAttribution(result: AttributionResult): AttributionOutcome {
  if (result.status === "ok") {
    return { status: "recorded", replayed: result.replayed };
  }
  return { status: "refused", error: result.status === "forbidden" ? "forbidden" : result.code };
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

  // `attribution` is not part of the entry: it is split off before the entry is
  // validated, fingerprinted or hashed, so it can never alter an `entryHash`.
  let entryBody = body;
  let attributionBody: unknown;
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "attribution" in body) {
    const { attribution, ...rest } = body as Record<string, unknown>;
    entryBody = rest;
    attributionBody = attribution;
  }

  const parsed = parse(ledgerEntryRequestSchema, entryBody);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  let attribution: ReturnType<typeof ledgerEntryAttributionSchema.parse> | undefined;
  if (attributionBody !== undefined) {
    const parsedAttribution = parse(ledgerEntryAttributionSchema, attributionBody);
    if (!parsedAttribution.ok) {
      return jsonError("invalid_request", 400, parsedAttribution.message);
    }
    // Only a contribution has a payer. Refused before anything is written.
    if (parsed.data.entryType !== "contribution") {
      return jsonError("invalid_request", 400, "Only a contribution can carry an attribution");
    }
    attribution = parsedAttribution.data;
  }

  try {
    const service = new LedgerService(new SupabaseLedgerRepository(supabase));
    const result = await service.append(parsed.data, { actorId: data.user.id });
    let attributionOutcome: AttributionOutcome | undefined;
    if (attribution !== undefined) {
      try {
        attributionOutcome = describeAttribution(
          await recordAttribution(supabase, {
            groupId: parsed.data.groupId,
            entryId: result.entry.id,
            memberUserId: attribution.memberUserId,
            cycleId: attribution.cycleId,
            round: attribution.round,
            channel: attribution.channel,
            note: attribution.note
          })
        );
      } catch {
        attributionOutcome = { status: "failed" };
      }
    }
    return Response.json(
      {
        entry: publicEntry(result.entry),
        replayed: result.replayed,
        ...(attributionOutcome ? { attribution: attributionOutcome } : {})
      },
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
 * `GET /api/ledger/entries?groupId=<uuid>[&limit=1..100][&beforeSequence=<n>]` —
 * a group's entries, newest first, each with its postings, an `attribution` field and a `provenance` field: `null`, or the
 * verified bank receipt that posted the entry (`{ kind: "bank_verification",
 * provider, verifiedAt, verificationId, memberUserId, referenceMasked }`, where `referenceMasked`
 * is `••••` plus the last 1-4 characters of the bank reference or `null`, never the full reference).
 * `attribution` is `null` or who paid a contribution: `{ source: "bank_verification" | "treasurer",
 * memberUserId, recordedBy, recordedAt, cycleId, round, revision, reason, channel, note }`. `bank_verification` is the
 * same fact as `provenance`; `treasurer` is an owner's or treasurer's record for an entry with no bank
 * provenance, never a verification. Bank provenance wins when both exist. `channel` is how it was paid
 * (`telebirr | cbe | awash | cash | other`, or `null`): the treasurer's word for a `treasurer` record, the
 * verification's provider for a `bank_verification` one. `note` is the treasurer's plain-text note (1..280
 * characters) or `null`; it is data, never markup, and is always `null` for a bank-verified entry. Both keys
 * are additive. Read-only.
 *
 * Paging: the body is `{ entries, hasMore, nextCursor }`. `beforeSequence` is an
 * exclusive upper bound on sequence; when `hasMore` is true, `nextCursor` is the
 * value to send as `beforeSequence` for the next older page, and `null` marks the
 * last page. Omitting it returns the newest page, as before.
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
    const page = await readGroupLedgerPage(auth.client, parsed.data.groupId, {
      limit: parsed.data.limit,
      beforeSequence: parsed.data.beforeSequence
    });
    if (page === null) {
      return jsonError("not_found", 404);
    }
    return Response.json(
      { entries: page.entries, hasMore: page.hasMore, nextCursor: page.nextCursor },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return jsonError("storage_failure", 502);
  }
}
