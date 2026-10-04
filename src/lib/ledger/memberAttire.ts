import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Set the CALLER's own avatar attire (none, gabi or netela) in a group.
 *
 * The authority is `sened_ledger_set_member_attire_v1`, which takes no user
 * argument: it changes the row of `auth.uid()` in that group and nothing else,
 * and refuses anyone who is not an active member. This file only forwards the
 * call and translates the SQL error contract; it makes no decision of its own.
 */

export type MemberAttireValue = "none" | "gabi" | "netela";

export type MemberAttireResult =
  | { readonly status: "ok"; readonly groupId: string; readonly attire: MemberAttireValue; readonly changed: boolean }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" };

export async function setMemberAttire(
  client: SupabaseClient,
  input: { readonly groupId: string; readonly attire: MemberAttireValue }
): Promise<MemberAttireResult> {
  const { data, error } = await client.rpc("sened_ledger_set_member_attire_v1", {
    requested_group_id: input.groupId,
    requested_attire: input.attire
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("ledger_forbidden") || error.code === "42501") {
      return { status: "forbidden" };
    }
    if (message.includes("ledger_invalid_request") || error.code === "22023") {
      return { status: "invalid" };
    }
    throw new Error("member_attire_storage_failure", { cause: error });
  }
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.groupId !== "string" ||
    (row.attire !== "none" && row.attire !== "gabi" && row.attire !== "netela") ||
    typeof row.changed !== "boolean"
  ) {
    throw new Error("member_attire_integrity_failure");
  }
  return { status: "ok", groupId: row.groupId, attire: row.attire, changed: row.changed };
}
