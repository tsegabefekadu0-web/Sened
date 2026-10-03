import "server-only";
import { authenticateRead } from "@/lib/authRead";
import {
  LedgerService,
  SupabaseLedgerRepository,
  isLedgerError,
  readLedgerChainSlice
} from "@/lib/ledger";
import {
  ledgerEntryRequestSchema,
  parse,
  syncPullRequestSchema,
  syncPushRequestSchema
} from "@/lib/validation";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server half of the offline sync contract (`src/lib/offline/contract.ts`).
 *
 * Push replays each outbox draft through the very path
 * `POST /api/ledger/entries` uses: `LedgerService.append` ->
 * `post_ledger_entry_v1`. Idempotency, owner/treasurer role checks, validation
 * and balancing are therefore that path's, not a copy of it. The idempotency
 * key is the envelope's (the contract's), and the RPC's unique
 * (group, key) row plus request fingerprint is what makes a replay return the
 * original entry (`REPLAYED`) rather than a second one.
 */

// 25 envelopes of up to ~100 postings each; the entries route caps one at 32 KiB.
const MAX_BODY_BYTES = 262_144;
const TRANSIENT_RETRY_AFTER_MS = 5_000;

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (
    !contentType?.startsWith("application/json") ||
    (contentType !== "application/json" && !contentType.startsWith("application/json;"))
  ) {
    return { ok: false };
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return { ok: false };
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return { ok: false };
    }
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

type PushResult =
  | {
      readonly mutationId: string;
      readonly outcome: "ACCEPTED" | "REPLAYED";
      readonly serverEntryId: string;
      readonly serverEntryHash: string;
      readonly serverSequence: string;
    }
  | {
      readonly mutationId: string;
      readonly outcome: "REJECTED";
      readonly error: string;
      readonly retryAfterMs?: number;
    };

function rejected(mutationId: string, error: string, retryAfterMs?: number): PushResult {
  return { mutationId, outcome: "REJECTED", error, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/** Same vocabulary as the entries route's error codes, one verdict per item. */
function mapLedgerFailure(mutationId: string, error: unknown): PushResult {
  if (!isLedgerError(error)) {
    return rejected(mutationId, "ledger_write_failed", TRANSIENT_RETRY_AFTER_MS);
  }
  switch (error.code) {
    case "NOT_FOUND":
      return rejected(mutationId, "not_found");
    case "FORBIDDEN":
      return rejected(mutationId, "forbidden");
    case "IDEMPOTENCY_CONFLICT":
      return rejected(mutationId, "idempotency_conflict");
    case "INVALID_AMOUNT":
    case "INVALID_REQUEST":
    case "UNBALANCED":
    case "INVALID_CORRECTION":
      return rejected(mutationId, "unprocessable_ledger_entry");
    case "UNAVAILABLE":
      // Transient: a retry-after verdict keeps the draft queued instead of
      // dead-ending it, and the engine bounds the attempts.
      return rejected(mutationId, "ledger_unavailable", TRANSIENT_RETRY_AFTER_MS);
    case "STORAGE_FAILURE":
    case "INTEGRITY_FAILURE":
      return rejected(mutationId, "ledger_write_failed", TRANSIENT_RETRY_AFTER_MS);
  }
}

async function pushOne(
  service: LedgerService,
  actorId: string,
  envelope: {
    readonly mutationId: string;
    readonly idempotencyKey: string;
    readonly kind: string;
    readonly groupId: string;
    readonly payload?: unknown;
  }
): Promise<PushResult> {
  if (envelope.kind !== "ledger-draft") {
    // Spoken notes and roster members have no server path yet. Refusing is
    // honest; reporting them as accepted would be a fabricated success.
    return rejected(envelope.mutationId, "unsupported_mutation_kind");
  }
  const parsed = parse(ledgerEntryRequestSchema, envelope.payload);
  if (!parsed.ok) {
    return rejected(envelope.mutationId, "invalid_request");
  }
  // The envelope's group is what the client matches results on; the payload's
  // is what the ledger acts on. They must be the same thing.
  if (parsed.data.groupId !== envelope.groupId) {
    return rejected(envelope.mutationId, "envelope_mismatch");
  }
  // The contract makes the envelope's key *the* ledger idempotency key. The
  // outbox derives it from the draft id and keeps it stable across retries,
  // whereas the draft's own `request.idempotencyKey` is only a local label.
  const request = { ...parsed.data, idempotencyKey: envelope.idempotencyKey };
  try {
    const result = await service.append(request, { actorId });
    return {
      mutationId: envelope.mutationId,
      outcome: result.replayed ? "REPLAYED" : "ACCEPTED",
      serverEntryId: result.entry.id,
      serverEntryHash: result.entry.entryHash,
      serverSequence: result.entry.sequence
    };
  } catch (error) {
    return mapLedgerFailure(envelope.mutationId, error);
  }
}

async function handlePush(client: SupabaseClient, actorId: string, body: unknown): Promise<Response> {
  const parsed = parse(syncPushRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  const service = new LedgerService(new SupabaseLedgerRepository(client));
  // Sequential, in outbox order: appends to one group's chain are ordered, and
  // a verdict is returned for every envelope, in order, whatever happens to its
  // neighbours.
  const results: PushResult[] = [];
  for (const envelope of parsed.data.mutations) {
    results.push(await pushOne(service, actorId, envelope));
  }
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}

async function handlePull(client: SupabaseClient, body: unknown): Promise<Response> {
  const parsed = parse(syncPullRequestSchema, body);
  if (!parsed.ok) {
    return jsonError("invalid_request", 400, parsed.message);
  }
  try {
    const slice = await readLedgerChainSlice(
      client,
      parsed.data.groupId,
      parsed.data.sinceSequence,
      parsed.data.limit
    );
    if (slice === null) {
      return jsonError("not_found", 404);
    }
    return Response.json(
      { groupId: slice.head.groupId, head: slice.head, entries: slice.entries, hasMore: slice.hasMore },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return jsonError("storage_failure", 502);
  }
}

async function authenticatedBody(
  request: Request
): Promise<{ ok: true; client: SupabaseClient; userId: string; body: unknown } | { ok: false; response: Response }> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return { ok: false, response: jsonError(auth.error, auth.status) };
  }
  const body = await readJsonBody(request);
  if (!body.ok) {
    return { ok: false, response: jsonError("bad_request", 400) };
  }
  return { ok: true, client: auth.client, userId: auth.userId, body: body.body };
}

function isPullShaped(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && !("mutations" in body);
}

/**
 * `POST /api/sync`: `{ mutations }` is a push, `{ groupId, sinceSequence,
 * limit }` is a pull. This is the single URL `HttpSyncTransport` posts both to.
 */
export async function postSync(request: Request): Promise<Response> {
  const input = await authenticatedBody(request);
  if (!input.ok) {
    return input.response;
  }
  return isPullShaped(input.body)
    ? handlePull(input.client, input.body)
    : handlePush(input.client, input.userId, input.body);
}
