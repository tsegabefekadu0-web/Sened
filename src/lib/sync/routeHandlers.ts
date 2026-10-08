import "server-only";
import { authenticateRead } from "@/lib/authRead";
import { SYNC_PULL_RULE, SYNC_PUSH_ENTRIES_RULE, consumeRateLimit, type RateLimitRule } from "@/lib/rateLimit";
import {
  LedgerService,
  SupabaseLedgerRepository,
  isLedgerError,
  readLedgerChainSlice
} from "@/lib/ledger";
import { recordAttribution, type AttributionResult } from "@/lib/ledger/attribution";
import {
  ledgerEntryAttributionSchema,
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
 *
 * A `ledger-draft` payload may carry an `attribution` (who paid, and for which
 * cycle round), split off before the entry is validated, fingerprinted or hashed,
 * exactly as `POST /api/ledger/entries` does. It is a second write after the
 * entry: the entry's verdict (`ACCEPTED` / `REPLAYED`) is never changed by it, and
 * the outcome is reported beside it as `attribution: { outcome: "RECORDED" |
 * "REFUSED", error? }`. A replay attempts the attribution again; the database's
 * `record_ledger_entry_attribution_v1` answers an identical record with the
 * existing one (`replayed: true`, so `RECORDED`) rather than writing a second.
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

async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; tooLarge: boolean }> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (
    !contentType?.startsWith("application/json") ||
    (contentType !== "application/json" && !contentType.startsWith("application/json;"))
  ) {
    return { ok: false, tooLarge: false };
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, tooLarge: false };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

type PushResult =
  | {
      readonly mutationId: string;
      readonly outcome: "ACCEPTED" | "REPLAYED";
      readonly serverEntryId: string;
      readonly serverEntryHash: string;
      readonly serverSequence: string;
      /** Present only when the draft's payload carried an `attribution`. */
      readonly attribution?: PushAttribution;
    }
  | {
      readonly mutationId: string;
      readonly outcome: "REJECTED";
      readonly error: string;
      readonly retryAfterMs?: number;
    };

type PushAttribution =
  | { readonly outcome: "RECORDED" }
  | { readonly outcome: "REFUSED"; readonly error: string };

function describeAttribution(result: AttributionResult): PushAttribution {
  if (result.status === "ok") {
    return { outcome: "RECORDED" };
  }
  return { outcome: "REFUSED", error: result.status === "forbidden" ? "forbidden" : result.code };
}

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
  client: SupabaseClient,
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
  // `attribution` is not part of the entry: it is split off before the entry is
  // validated, so the strict entry schema (and the entry's hash) never sees it.
  let entryPayload = envelope.payload;
  let attributionPayload: unknown;
  if (typeof entryPayload === "object" && entryPayload !== null && !Array.isArray(entryPayload) && "attribution" in entryPayload) {
    const { attribution, ...rest } = entryPayload as Record<string, unknown>;
    entryPayload = rest;
    attributionPayload = attribution;
  }
  const parsed = parse(ledgerEntryRequestSchema, entryPayload);
  if (!parsed.ok) {
    return rejected(envelope.mutationId, "invalid_request");
  }
  let attribution: ReturnType<typeof ledgerEntryAttributionSchema.parse> | undefined;
  // Same rule as `POST /api/ledger/entries`: a present `attribution` must be a valid
  // one. `null` is not "no payer" (leave the key out), it is a malformed request.
  if (attributionPayload !== undefined) {
    const parsedAttribution = parse(ledgerEntryAttributionSchema, attributionPayload);
    // Only a contribution has a payer. A malformed one is that draft's rejection
    // before anything is written, the same as on the entries route.
    if (!parsedAttribution.ok || parsed.data.entryType !== "contribution") {
      return rejected(envelope.mutationId, "invalid_request");
    }
    attribution = parsedAttribution.data;
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
    let attributionResult: PushAttribution | undefined;
    if (attribution !== undefined) {
      try {
        attributionResult = describeAttribution(
          await recordAttribution(client, {
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
        // The attribution write itself failed. The entry is posted and stays
        // posted; this is reported as a refusal the treasurer can retry.
        attributionResult = { outcome: "REFUSED", error: "attribution_failed" };
      }
    }
    return {
      mutationId: envelope.mutationId,
      outcome: result.replayed ? "REPLAYED" : "ACCEPTED",
      serverEntryId: result.entry.id,
      serverEntryHash: result.entry.entryHash,
      serverSequence: result.entry.sequence,
      ...(attributionResult ? { attribution: attributionResult } : {})
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
    results.push(await pushOne(service, client, actorId, envelope));
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
    return body.tooLarge
      ? { ok: false, response: jsonError("payload_too_large", 413) }
      : { ok: false, response: jsonError("bad_request", 400) };
  }
  return { ok: true, client: auth.client, userId: auth.userId, body: body.body };
}

/** Entries a push body claims to carry (a malformed body costs one; its own 400 follows). */
function pushCost(body: unknown): number {
  const mutations = (body as { mutations?: unknown } | null)?.mutations;
  return Array.isArray(mutations) ? Math.max(1, Math.min(mutations.length, SYNC_PUSH_ENTRIES_RULE.limit)) : 1;
}

function meter(key: string, rule: RateLimitRule, cost: number): Response | null {
  const result = consumeRateLimit(key, rule, Date.now(), cost);
  if (result.allowed) {
    return null;
  }
  return Response.json(
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
  const pull = isPullShaped(input.body);
  // Metered here, not in the middleware, because only here is the body known.
  // A push spends one unit per entry it carries; a pull has a bucket of its own.
  const limited = pull
    ? meter(`sync:pull:${input.userId}`, SYNC_PULL_RULE, 1)
    : meter(`sync:push:${input.userId}`, SYNC_PUSH_ENTRIES_RULE, pushCost(input.body));
  if (limited) {
    return limited;
  }
  return pull ? handlePull(input.client, input.body) : handlePush(input.client, input.userId, input.body);
}
