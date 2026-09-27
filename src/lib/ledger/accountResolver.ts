import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  counterAccountCodeFor,
  isLedgerAccountCode,
  resolveGroupAccounts,
  type GroupAccounts,
  type LedgerAccountCode
} from "./accounts";

/**
 * Reads a group's chart of accounts by code, through the client's own RLS.
 *
 * The read goes through PostgREST rather than a bespoke RPC because
 * `ledger_accounts` already carries the tenant-isolation policies from the
 * baseline migration: a treasurer can read the accounts of a group they belong
 * to and nothing else. A new function would have had to re-implement that check,
 * which is how access-control drift starts.
 *
 * `ledgerAccountId` on the bank account binding is the cash side and is
 * already trusted — it was resolved through `get_bank_account_binding_v1`. Only
 * the counter-account has to be looked up by code, and one row per direction is
 * read rather than the whole chart.
 */
export class SupabaseLedgerAccountResolver {
  constructor(private readonly client: SupabaseClient) {}

  /**
   * @returns the two account ids, or `null` when the group's chart is missing
   *   the account this movement needs. Never a guess.
   */
  async resolve(
    groupId: string,
    cashAccountId: string,
    direction: "inbound" | "outbound"
  ): Promise<GroupAccounts | null> {
    if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(cashAccountId)) {
      return null;
    }
    const code = counterAccountCodeFor(direction);

    const { data, error } = await this.client
      .from("ledger_accounts")
      .select("id, code")
      .eq("group_id", groupId)
      .eq("code", code)
      .limit(1)
      .maybeSingle();

    if (error) {
      // Storage trouble is not the same as "this group has no such account", and
      // the difference matters to whoever reads the result. An empty answer
      // would tell a treasurer their group is unprovisioned when the truth is
      // that the database was unreachable.
      throw new LedgerAccountLookupError(code, error.message);
    }
    if (!data || !isLedgerAccountCode(data.code)) {
      return null;
    }
    if (typeof data.id !== "string") {
      return null;
    }

    const index = new Map<LedgerAccountCode, string>([[code, data.id]]);
    return resolveGroupAccounts(index, cashAccountId, direction);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LedgerAccountLookupError extends Error {
  constructor(readonly code: LedgerAccountCode, detail: string) {
    super(`Could not read ledger account ${code}: ${detail}`);
    this.name = "LedgerAccountLookupError";
  }
}
