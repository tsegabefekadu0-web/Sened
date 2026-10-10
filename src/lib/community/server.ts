import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunityCreateRequest } from "@/lib/validation";
import type { CreatedCommunity } from "./types";

export type CommunityResult =
  | { readonly status: "ok"; readonly community: CreatedCommunity }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" }
  | { readonly status: "error" };

export function formatJoinUrl(origin: string, token: string): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}/join#token=${encodeURIComponent(token)}`;
}

export async function createCommunityOnServer(
  client: SupabaseClient,
  input: CommunityCreateRequest,
  origin: string = ""
): Promise<CommunityResult> {
  const { data, error } = await client.rpc("sened_community_create_v1", {
    requested_name: input.name,
    requested_kind: input.kind,
    requested_amount: input.amount,
    requested_frequency: input.frequency,
    requested_target_members: input.members
  });

  if (error) {
    if (error.code === "42501" || error.message?.includes("ledger_forbidden")) {
      return { status: "forbidden" };
    }
    if (error.code === "22023" || error.message?.includes("ledger_invalid")) {
      return { status: "invalid" };
    }
    return { status: "error" };
  }

  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.groupId !== "string" || !row.invite || typeof row.invite !== "object") {
    return { status: "error" };
  }

  const inviteObj = row.invite as Record<string, unknown>;
  const token = typeof inviteObj.token === "string" ? inviteObj.token : "";
  const joinUrl = origin && token ? formatJoinUrl(origin, token) : undefined;

  const community: CreatedCommunity = {
    groupId: row.groupId,
    tenantId: typeof row.tenantId === "string" ? row.tenantId : "",
    name: typeof row.name === "string" ? row.name : input.name,
    kind: row.kind === "iddir" ? "iddir" : "equb",
    amount: typeof row.amount === "number" ? row.amount : input.amount,
    frequency: row.frequency === "weekly" ? "weekly" : "monthly",
    members: typeof row.members === "number" ? row.members : input.members,
    role: typeof row.role === "string" ? row.role : "owner",
    invite: {
      inviteId: typeof inviteObj.inviteId === "string" ? inviteObj.inviteId : "",
      token,
      expiresAt: typeof inviteObj.expiresAt === "string" ? inviteObj.expiresAt : "",
      maxUses: typeof inviteObj.maxUses === "number" ? inviteObj.maxUses : input.members,
      joinUrl
    }
  };

  return { status: "ok", community };
}
