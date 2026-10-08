import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Invite links and the member list.
 *
 * Every authorization decision is made in SQL under the caller's own JWT (see
 * 20260930100000_ledger_group_invites.sql). This file forwards the calls,
 * translates the SQL error contract into results, and validates the shape of
 * what comes back. The raw token exists only in `createInvite`'s result; it is
 * never logged, and thrown errors here carry no cause (a driver error could
 * echo the RPC arguments, which include the token on redeem).
 */

export type InviteFailure =
  | { readonly status: "forbidden" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "expired" }
  | { readonly status: "revoked" }
  | { readonly status: "exhausted" };

function classify(error: { code?: string; message?: string }): InviteFailure {
  const message = error.message ?? "";
  if (message.includes("ledger_forbidden") || error.code === "42501") return { status: "forbidden" };
  if (message.includes("ledger_invite_expired")) return { status: "expired" };
  if (message.includes("ledger_invite_revoked")) return { status: "revoked" };
  if (message.includes("ledger_invite_exhausted")) return { status: "exhausted" };
  if (message.includes("ledger_invite_invalid") || message.includes("ledger_group_not_found")) {
    return { status: "not-found" };
  }
  if (message.includes("ledger_invalid_request") || error.code === "22023") return { status: "invalid" };
  throw new Error("invite_storage_failure");
}

export type CreateInviteResult =
  | {
      readonly status: "ok";
      readonly inviteId: string;
      readonly groupId: string;
      readonly token: string;
      readonly expiresAt: string;
      readonly maxUses: number;
    }
  | InviteFailure;

export async function createInvite(
  client: SupabaseClient,
  input: { readonly groupId: string; readonly expiresInHours: number; readonly maxUses: number }
): Promise<CreateInviteResult> {
  const { data, error } = await client.rpc("create_group_invite_v1", {
    requested_group_id: input.groupId,
    expires_in_hours: input.expiresInHours,
    requested_max_uses: input.maxUses
  });
  if (error) return classify(error);
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.inviteId !== "string" ||
    typeof row.groupId !== "string" ||
    typeof row.token !== "string" ||
    typeof row.expiresAt !== "string" ||
    typeof row.maxUses !== "number"
  ) {
    throw new Error("invite_integrity_failure");
  }
  return {
    status: "ok",
    inviteId: row.inviteId,
    groupId: row.groupId,
    token: row.token,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses
  };
}

export type RedeemInviteResult =
  | {
      readonly status: "ok";
      readonly outcome: "joined" | "already_member";
      readonly groupId: string;
      readonly role: string;
    }
  | InviteFailure;

export async function redeemInvite(client: SupabaseClient, token: string): Promise<RedeemInviteResult> {
  const { data, error } = await client.rpc("redeem_group_invite_v1", { requested_token: token });
  if (error) return classify(error);
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    (row.status !== "joined" && row.status !== "already_member") ||
    typeof row.groupId !== "string" ||
    typeof row.role !== "string"
  ) {
    throw new Error("invite_integrity_failure");
  }
  return { status: "ok", outcome: row.status, groupId: row.groupId, role: row.role };
}

export type RevokeInviteResult =
  | { readonly status: "ok"; readonly inviteId: string; readonly changed: boolean }
  | InviteFailure;

export async function revokeInvite(client: SupabaseClient, inviteId: string): Promise<RevokeInviteResult> {
  const { data, error } = await client.rpc("revoke_group_invite_v1", { requested_invite_id: inviteId });
  if (error) return classify(error);
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.inviteId !== "string" || typeof row.changed !== "boolean") {
    throw new Error("invite_integrity_failure");
  }
  return { status: "ok", inviteId: row.inviteId, changed: row.changed };
}

export interface InviteSummary {
  readonly inviteId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly useCount: number;
  readonly revokedAt: string | null;
  readonly status: "active" | "expired" | "revoked" | "used_up";
}

export type ListInvitesResult =
  | { readonly status: "ok"; readonly invites: readonly InviteSummary[] }
  | InviteFailure;

const INVITE_STATUSES = ["active", "expired", "revoked", "used_up"];

export async function listInvites(client: SupabaseClient, groupId: string): Promise<ListInvitesResult> {
  const { data, error } = await client.rpc("list_group_invites_v1", { requested_group_id: groupId });
  if (error) return classify(error);
  if (!Array.isArray(data)) throw new Error("invite_integrity_failure");
  const invites: InviteSummary[] = [];
  for (const entry of data as Record<string, unknown>[]) {
    if (
      typeof entry.inviteId !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.expiresAt !== "string" ||
      typeof entry.maxUses !== "number" ||
      typeof entry.useCount !== "number" ||
      typeof entry.status !== "string" ||
      !INVITE_STATUSES.includes(entry.status)
    ) {
      throw new Error("invite_integrity_failure");
    }
    // Explicit field copy: nothing else the database returns is passed through.
    invites.push({
      inviteId: entry.inviteId,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      maxUses: entry.maxUses,
      useCount: entry.useCount,
      revokedAt: typeof entry.revokedAt === "string" ? entry.revokedAt : null,
      status: entry.status as InviteSummary["status"]
    });
  }
  return { status: "ok", invites };
}

export interface GroupMember {
  readonly userId: string;
  readonly role: "owner" | "treasurer" | "member";
  readonly joinedAt: string;
  /** Present only when the caller is the group's owner. */
  readonly email: string | null;
  /** The member's own avatar choice (a display preference, shown to every member). */
  readonly attire: "none" | "gabi" | "netela";
}

export type ListMembersResult =
  | { readonly status: "ok"; readonly members: readonly GroupMember[] }
  | InviteFailure;

export async function listMembers(client: SupabaseClient, groupId: string): Promise<ListMembersResult> {
  const { data, error } = await client.rpc("list_group_members_v1", { requested_group_id: groupId });
  if (error) return classify(error);
  if (!Array.isArray(data)) throw new Error("invite_integrity_failure");
  const members: GroupMember[] = [];
  for (const entry of data as Record<string, unknown>[]) {
    if (
      typeof entry.userId !== "string" ||
      typeof entry.joinedAt !== "string" ||
      (entry.role !== "owner" && entry.role !== "treasurer" && entry.role !== "member")
    ) {
      throw new Error("invite_integrity_failure");
    }
    // Absent (a database one migration behind) is none; anything else must be a known value.
    const attire = entry.attire ?? "none";
    if (attire !== "none" && attire !== "gabi" && attire !== "netela") {
      throw new Error("invite_integrity_failure");
    }
    members.push({
      userId: entry.userId,
      role: entry.role,
      joinedAt: entry.joinedAt,
      email: typeof entry.email === "string" ? entry.email : null,
      attire
    });
  }
  return { status: "ok", members };
}
