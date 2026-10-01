import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Grant or clear the treasurer role for a member of a group.
 *
 * The authority is `sened_ledger_set_member_role_v1`, which runs under the
 * caller's own JWT and checks, in SQL, that the caller is an active owner of the
 * group, that the target is already an active member, and that the target is not
 * an owner. This file only forwards the call and translates the SQL error
 * contract into a result; it makes no authorization decision of its own.
 */

export type MemberRoleResult =
  | {
      readonly status: "ok";
      readonly groupId: string;
      readonly userId: string;
      readonly role: "treasurer" | "member";
      readonly changed: boolean;
    }
  | { readonly status: "forbidden" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" };

export async function setMemberRole(
  client: SupabaseClient,
  input: { readonly groupId: string; readonly userId: string; readonly role: "treasurer" | "member" }
): Promise<MemberRoleResult> {
  const { data, error } = await client.rpc("sened_ledger_set_member_role_v1", {
    requested_group_id: input.groupId,
    requested_user_id: input.userId,
    requested_role: input.role
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("ledger_forbidden") || error.code === "42501") {
      return { status: "forbidden" };
    }
    if (message.includes("ledger_group_not_found") || message.includes("ledger_member_not_found")) {
      return { status: "not-found" };
    }
    if (message.includes("ledger_invalid_request") || error.code === "22023") {
      return { status: "invalid" };
    }
    throw new Error("member_role_storage_failure", { cause: error });
  }
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.groupId !== "string" ||
    typeof row.userId !== "string" ||
    (row.role !== "treasurer" && row.role !== "member") ||
    typeof row.changed !== "boolean"
  ) {
    throw new Error("member_role_integrity_failure");
  }
  return { status: "ok", groupId: row.groupId, userId: row.userId, role: row.role, changed: row.changed };
}
