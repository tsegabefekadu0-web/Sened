/**
 * A treasury's standard chart of accounts.
 *
 * `ledger_accounts` has existed since the baseline migration and nothing has
 * ever written a row into it. There is no group-provisioning path, no seed, and
 * no read — so the ledger sink built in the last commit could only fail closed,
 * because it had no account ids to resolve. This file is the answer to the
 * question AGENT-3 filed as R-5 ("confirm the two account codes I post against
 * exist in every group's `ledger_accounts`"): no canonical pair existed, so
 * there is one now, and it lives here rather than being spelled out at each call
 * site.
 *
 * Four accounts, because an Equb has exactly four things money can be:
 *
 * | code | type | holds |
 * |---|---|---|
 * | `POT_CASH` | asset | the money members can see in the ደብተር |
 * | `CONTRIBUTION_INCOME` | income | contributions recognised as they arrive |
 * | `PAYOUT_EXPENSE` | expense | the pot's obligation discharged to a winner |
 * | `EQUITY_OPENING` | equity | the pot's opening balance at formation |
 *
 * `EQUITY_OPENING` is not used by the verification path. It exists because a
 * group that starts with a balance and no equity account has no way to record
 * where that balance came from, and inventing one later would be a correction
 * entry against a fiction.
 *
 * The codes are part of the product's wire contract: they are stored in
 * `ledger_accounts.code` and matched by
 * `sened_ledger_provision_group_v1`, so changing one is a migration, not an
 * edit.
 */

export const LEDGER_ACCOUNT_CODES = [
  "POT_CASH",
  "CONTRIBUTION_INCOME",
  "PAYOUT_EXPENSE",
  "EQUITY_OPENING"
] as const;

export type LedgerAccountCode = (typeof LEDGER_ACCOUNT_CODES)[number];

// The type union is not re-declared here: `types.ts` owns it, derived from
// `LEDGER_ACCOUNT_TYPES`, and two definitions of one union is how a migration
// and an application end up disagreeing about what an account may be.
import type { LedgerAccountType } from "./types";

export interface StandardAccount {
  readonly code: LedgerAccountCode;
  readonly name: string;
  readonly type: LedgerAccountType;
}

/**
 * Amharic first: this is a Ge'ez-primary product and a treasurer is the one who
 * reads this list. `src/lib/ledger/**` carries no `t()`, and these names are
 * seeded into the database once per group, so they are literals by design.
 */
export const STANDARD_ACCOUNTS: Readonly<Record<LedgerAccountCode, StandardAccount>> = {
  POT_CASH: { code: "POT_CASH", name: "የእቁብ ጥሬ ሂሳብ", type: "asset" },
  CONTRIBUTION_INCOME: {
    code: "CONTRIBUTION_INCOME",
    name: "የስጠታ ገቢ",
    type: "income"
  },
  PAYOUT_EXPENSE: {
    code: "PAYOUT_EXPENSE",
    name: "የእጣ ክፍያ ወጪ",
    type: "expense"
  },
  EQUITY_OPENING: {
    code: "EQUITY_OPENING",
    name: "የመክፈት ቀድሞ ሂሳብ",
    type: "equity"
  }
};

export const STANDARD_ACCOUNT_LIST: readonly StandardAccount[] = LEDGER_ACCOUNT_CODES.map(
  (code) => STANDARD_ACCOUNTS[code]
);

export function isLedgerAccountCode(value: unknown): value is LedgerAccountCode {
  return typeof value === "string" && (LEDGER_ACCOUNT_CODES as readonly string[]).includes(value);
}

/**
 * The account a bank movement is recognised against.
 *
 * Money arriving is income; money leaving discharges the pot's obligation, which
 * is an expense. Both are the mirror image of the cash posting, which is what
 * makes the two-posting entry balance without anyone computing a total.
 */
export function counterAccountCodeFor(direction: "inbound" | "outbound"): LedgerAccountCode {
  return direction === "inbound" ? "CONTRIBUTION_INCOME" : "PAYOUT_EXPENSE";
}

export interface GroupAccounts {
  readonly cashAccountId: string;
  readonly counterAccountId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve a cash and counter account from a per-group code index.
 *
 * Returns `null` rather than a partial answer. The sink treats `null` as "post
 * nothing", which is the only safe reading of a group whose chart of accounts is
 * incomplete — a contribution landing in an expense account, or against the pot
 * account twice, would balance arithmetically and mislead everyone who reads
 * the balance afterwards.
 */
export function resolveGroupAccounts(
  index: ReadonlyMap<LedgerAccountCode, string>,
  cashAccountId: string,
  direction: "inbound" | "outbound"
): GroupAccounts | null {
  if (!UUID_PATTERN.test(cashAccountId)) {
    return null;
  }
  const counterAccountId = index.get(counterAccountCodeFor(direction));
  if (counterAccountId === undefined || !UUID_PATTERN.test(counterAccountId)) {
    return null;
  }
  if (counterAccountId === cashAccountId) {
    return null;
  }
  return { cashAccountId, counterAccountId };
}
