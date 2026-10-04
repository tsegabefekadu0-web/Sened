import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isUuid } from "./rules";

/**
 * Record, or correct, WHO PAID a contribution that did not come through a bank
 * verification (M4.2).
 *
 * The authority is the database: `record_ledger_entry_attribution_v1` and
 * `supersede_ledger_entry_attribution_v1` take no "recorded by" argument (it is
 * `auth.uid()`), refuse anyone who is not an owner/treasurer of the group, refuse
 * an entry of another group, a non-contribution, a reversed contribution, a
 * member who is not active in the group, and an entry a verified bank receipt
 * already names (bank provenance wins). This file forwards the call and translates
 * the SQL error contract; it decides nothing.
 *
 * The attribution lives beside the hash-chained entry: it never alters
 * `entryHash` or the chain head.
 */

export interface AttributionRecord {
  readonly entryId: string;
  readonly memberUserId: string;
  readonly source: "bank_verification" | "treasurer";
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly cycleId: string | null;
  readonly round: number | null;
  readonly revision: number;
  readonly reason: string | null;
}

export type AttributionRefusal =
  | { readonly status: "forbidden" }
  /** The entry, the member or the cycle is not in this group (or does not exist). */
  | { readonly status: "not_found"; readonly code: string }
  | { readonly status: "invalid"; readonly code: string }
  /** The request is valid but the ledger's current state refuses it. */
  | { readonly status: "conflict"; readonly code: string };

export type AttributionResult =
  | { readonly status: "ok"; readonly attribution: AttributionRecord; readonly replayed: boolean }
  | AttributionRefusal;

const NOT_FOUND_CODES = ["ledger_entry_not_found", "ledger_member_not_found", "ledger_cycle_not_found", "attribution_not_found"];
const INVALID_CODES = ["ledger_invalid_request", "attribution_not_contribution"];
const CONFLICT_CODES = [
  "attribution_bank_verified",
  "attribution_entry_corrected",
  "attribution_exists",
  "attribution_unchanged",
  "attribution_conflict"
];

function refusal(error: { readonly message?: string; readonly code?: string }): AttributionRefusal | null {
  const message = error.message ?? "";
  if (message.includes("ledger_forbidden") || error.code === "42501") {
    return { status: "forbidden" };
  }
  const notFound = NOT_FOUND_CODES.find((code) => message.includes(code));
  if (notFound) return { status: "not_found", code: notFound };
  const invalid = INVALID_CODES.find((code) => message.includes(code));
  if (invalid) return { status: "invalid", code: invalid };
  const conflict = CONFLICT_CODES.find((code) => message.includes(code));
  if (conflict) return { status: "conflict", code: conflict };
  return null;
}

export function parseAttributionRecord(value: unknown): AttributionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const cycleId = row.cycleId ?? null;
  const round = row.round ?? null;
  const reason = row.reason ?? null;
  if (
    typeof row.entryId !== "string" ||
    !isUuid(row.entryId) ||
    typeof row.memberUserId !== "string" ||
    !isUuid(row.memberUserId) ||
    (row.source !== "bank_verification" && row.source !== "treasurer") ||
    typeof row.recordedBy !== "string" ||
    !isUuid(row.recordedBy) ||
    typeof row.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(row.recordedAt)) ||
    (cycleId !== null && (typeof cycleId !== "string" || !isUuid(cycleId))) ||
    (round !== null && (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1)) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    (reason !== null && typeof reason !== "string")
  ) {
    return null;
  }
  return {
    entryId: row.entryId.toLowerCase(),
    memberUserId: row.memberUserId.toLowerCase(),
    source: row.source,
    recordedBy: row.recordedBy.toLowerCase(),
    recordedAt: row.recordedAt,
    cycleId: cycleId === null ? null : (cycleId as string).toLowerCase(),
    round: round as number | null,
    revision: row.revision,
    reason: reason as string | null
  };
}

function toResult(data: unknown): AttributionResult {
  const envelope = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const attribution = parseAttributionRecord(envelope.attribution);
  if (attribution === null || typeof envelope.replayed !== "boolean") {
    throw new Error("attribution_integrity_failure");
  }
  return { status: "ok", attribution, replayed: envelope.replayed };
}

export interface AttributionInput {
  readonly groupId: string;
  readonly entryId: string;
  readonly memberUserId: string;
  readonly cycleId?: string;
  readonly round?: number;
}

/** First attribution of an entry. A different one already there is `attribution_exists`. */
export async function recordAttribution(client: SupabaseClient, input: AttributionInput): Promise<AttributionResult> {
  const { data, error } = await client.rpc("record_ledger_entry_attribution_v1", {
    p_group_id: input.groupId,
    p_entry_id: input.entryId,
    p_member_user_id: input.memberUserId,
    p_cycle_id: input.cycleId ?? null,
    p_round: input.round ?? null
  });
  if (error) {
    const known = refusal(error);
    if (known) return known;
    throw new Error("attribution_storage_failure", { cause: error });
  }
  return toResult(data);
}

/** Correct an attribution: a NEW record that names the one it replaces and says why. Never an edit. */
export async function supersedeAttribution(
  client: SupabaseClient,
  input: AttributionInput & { readonly reason: string }
): Promise<AttributionResult> {
  const { data, error } = await client.rpc("supersede_ledger_entry_attribution_v1", {
    p_group_id: input.groupId,
    p_entry_id: input.entryId,
    p_member_user_id: input.memberUserId,
    p_reason: input.reason,
    p_cycle_id: input.cycleId ?? null,
    p_round: input.round ?? null
  });
  if (error) {
    const known = refusal(error);
    if (known) return known;
    throw new Error("attribution_storage_failure", { cause: error });
  }
  return toResult(data);
}
