import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { BankVerificationError } from "@/lib/banking/errors";

/**
 * The groups a signed-in treasurer belongs to, and their chart of accounts.
 *
 * The second half is the reason this exists. `SupabaseLedgerAccountResolver`
 * looks an account up by **code**, and a client cannot know a group's codes
 * without being told them — so a group that exists with an unseeded chart is
 * indistinguishable from one that was never provisioned, and both make the
 * ledger sink fail closed with nothing to act on.
 *
 * Scoped to `auth.uid()` by `list_my_groups_v1()`; this only parses what comes
 * back, and refuses to invent a group rather than falling back to one.
 */

export interface GroupAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
}

export interface MyGroup {
  readonly groupId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly currency: string;
  readonly role: string;
  readonly accounts: readonly GroupAccount[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEDGER_ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
const MEMBERSHIP_ROLES = ["owner", "treasurer", "member"] as const;

interface SupabaseErrorLike {
  readonly code?: string;
  readonly message?: string;
}

function fail(error: SupabaseErrorLike): never {
  throw new BankVerificationError("STORAGE_FAILURE", "Group storage returned an error", {
    cause: error
  });
}

function parseAccount(value: unknown): GroupAccount | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.code !== "string" ||
    row.code.length === 0 ||
    typeof row.name !== "string" ||
    typeof row.type !== "string" ||
    !LEDGER_ACCOUNT_TYPES.includes(row.type as (typeof LEDGER_ACCOUNT_TYPES)[number])
  ) {
    return null;
  }
  return { id: row.id, code: row.code, name: row.name, type: row.type };
}

function parseGroup(value: unknown): MyGroup | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.groupId !== "string" ||
    !UUID_PATTERN.test(row.groupId) ||
    typeof row.tenantId !== "string" ||
    !UUID_PATTERN.test(row.tenantId) ||
    typeof row.name !== "string" ||
    typeof row.currency !== "string" ||
    typeof row.role !== "string" ||
    !MEMBERSHIP_ROLES.includes(row.role as (typeof MEMBERSHIP_ROLES)[number]) ||
    !Array.isArray(row.accounts)
  ) {
    return null;
  }
  return {
    groupId: row.groupId,
    tenantId: row.tenantId,
    name: row.name,
    currency: row.currency,
    role: row.role,
    accounts: row.accounts
      .map((account) => parseAccount(account))
      .filter((account): account is GroupAccount => account !== null)
  };
}

export async function listMyGroups(client: SupabaseClient): Promise<readonly MyGroup[]> {
  const { data, error } = await client.rpc("list_my_groups_v1");
  if (error) {
    fail(error);
  }
  if (!Array.isArray(data)) {
    throw new BankVerificationError("INTEGRITY_FAILURE", "Group list storage returned an invalid response");
  }
  return data.map((entry) => parseGroup(entry)).filter((group): group is MyGroup => group !== null);
}
