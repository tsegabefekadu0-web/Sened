import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  counterAccountCodeFor,
  isLedgerAccountCode,
  LEDGER_ACCOUNT_CODES,
  resolveGroupAccounts,
  STANDARD_ACCOUNTS,
  STANDARD_ACCOUNT_LIST,
  type LedgerAccountCode
} from "@/lib/ledger/accounts";
import { LedgerAccountLookupError, SupabaseLedgerAccountResolver } from "@/lib/ledger/accountResolver";

/**
 * O-2 — a group's chart of accounts.
 *
 * `ledger_accounts` had a table, a unique constraint and RLS policies, and
 * nothing had ever written a row into it. No seed, no function, no application
 * code. The visible consequence was that the ledger sink built to close the
 * trust loop could only ever fail closed: it had no account ids to resolve, so
 * a verified bank result produced no ledger entry.
 *
 * These tests pin the two halves of the fix together, because they are separate
 * files in separate languages and nothing else would notice them drifting: the
 * TypeScript code list, and the `values` list the migration inserts.
 */

const groupId = "22222222-2222-4222-8222-222222222222";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";
const expenseAccount = "55555555-5555-4555-8555-555555555555";

const MIGRATION = "supabase/migrations/20260927100000_ledger_group_provisioning.sql";

describe("the canonical chart of accounts", () => {
  it("has the four accounts an Equb needs", () => {
    expect(LEDGER_ACCOUNT_CODES).toEqual([
      "POT_CASH",
      "CONTRIBUTION_INCOME",
      "PAYOUT_EXPENSE",
      "EQUITY_OPENING"
    ]);
    expect(STANDARD_ACCOUNT_LIST).toHaveLength(LEDGER_ACCOUNT_CODES.length);
  });

  it("types each account so the ledger's own enum is satisfied", () => {
    // income for money arriving, expense for money leaving, asset for the pot,
    // equity for its opening balance. A wrong type here would not fail at
    // insert — the column accepts all five — it would corrupt every balance.
    expect(STANDARD_ACCOUNTS.POT_CASH.type).toBe("asset");
    expect(STANDARD_ACCOUNTS.CONTRIBUTION_INCOME.type).toBe("income");
    expect(STANDARD_ACCOUNTS.PAYOUT_EXPENSE.type).toBe("expense");
    expect(STANDARD_ACCOUNTS.EQUITY_OPENING.type).toBe("equity");
  });

  it("names every account in Amharic, because a treasurer reads it", () => {
    for (const account of STANDARD_ACCOUNT_LIST) {
      expect(account.name.trim().length).toBeGreaterThan(0);
      // Ge'ez, not a transliteration.
      expect(account.name).toMatch(/[\u1200-\u137f]/);
    }
  });

  it("maps a bank movement to the account it is recognised against", () => {
    expect(counterAccountCodeFor("inbound")).toBe("CONTRIBUTION_INCOME");
    expect(counterAccountCodeFor("outbound")).toBe("PAYOUT_EXPENSE");
  });

  it("rejects a code that is not in the chart", () => {
    expect(isLedgerAccountCode("POT_CASH")).toBe(true);
    expect(isLedgerAccountCode("DRAW_POT_CASH")).toBe(false);
    expect(isLedgerAccountCode(null)).toBe(false);
  });
});

describe("the migration seeds exactly those accounts", () => {
  const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");

  it("inserts every code the resolver can ask for", () => {
    for (const code of LEDGER_ACCOUNT_CODES) {
      expect(sql).toContain(`('${code}',`);
    }
  });

  it("seeds no account the TypeScript side does not know about", () => {
    // The reverse direction matters more: an account created in SQL and absent
    // from the resolver is an account nothing can post to, silently.
    const inserted = [...sql.matchAll(/\('([A-Z][A-Z0-9_]*)',\s*'[^']*',\s*'(?:asset|liability|equity|income|expense)'\)/g)]
      .map((match) => match[1]);
    expect(inserted.length).toBeGreaterThanOrEqual(LEDGER_ACCOUNT_CODES.length);
    for (const code of inserted) {
      expect(LEDGER_ACCOUNT_CODES).toContain(code);
    }
  });

  it("agrees with the resolver on the direction mapping", () => {
    expect(sql).toContain("('CONTRIBUTION_INCOME',");
    expect(sql).toContain("('PAYOUT_EXPENSE',");
  });

  it("is idempotent, so re-running adds nothing", () => {
    expect(sql).toContain("on conflict (group_id, code) do nothing");
  });

  it("refuses an unauthenticated caller", () => {
    expect(sql).toContain("ledger_provision_unauthorized");
    expect(sql).toMatch(/revoke all on function public\.sened_ledger_provision_group_v1\(text\) from public, anon;/);
    expect(sql).toContain(
      "grant execute on function public.sened_ledger_provision_group_v1(text) to authenticated;"
    );
  });
});

describe("resolving a group's accounts", () => {
  it("returns the pot and the income account for money arriving", () => {
    const index = new Map<LedgerAccountCode, string>([
      ["CONTRIBUTION_INCOME", incomeAccount],
      ["PAYOUT_EXPENSE", expenseAccount]
    ]);

    expect(resolveGroupAccounts(index, cashAccount, "inbound")).toEqual({
      cashAccountId: cashAccount,
      counterAccountId: incomeAccount
    });
  });

  it("returns the pot and the expense account for money leaving", () => {
    const index = new Map<LedgerAccountCode, string>([
      ["CONTRIBUTION_INCOME", incomeAccount],
      ["PAYOUT_EXPENSE", expenseAccount]
    ]);

    expect(resolveGroupAccounts(index, cashAccount, "outbound")).toEqual({
      cashAccountId: cashAccount,
      counterAccountId: expenseAccount
    });
  });

  it("returns null when the counter-account is missing", () => {
    expect(resolveGroupAccounts(new Map(), cashAccount, "inbound")).toBeNull();
    expect(
      resolveGroupAccounts(
        new Map<LedgerAccountCode, string>([["PAYOUT_EXPENSE", expenseAccount]]),
        cashAccount,
        "inbound"
      )
    ).toBeNull();
  });

  it("returns null rather than posting an account against itself", () => {
    const index = new Map<LedgerAccountCode, string>([["CONTRIBUTION_INCOME", cashAccount]]);
    expect(resolveGroupAccounts(index, cashAccount, "inbound")).toBeNull();
  });

  it("returns null for an id that is not a uuid", () => {
    const index = new Map<LedgerAccountCode, string>([["CONTRIBUTION_INCOME", incomeAccount]]);
    expect(resolveGroupAccounts(index, "not-a-uuid", "inbound")).toBeNull();
    expect(
      resolveGroupAccounts(new Map<LedgerAccountCode, string>([["CONTRIBUTION_INCOME", "nope"]]), cashAccount, "inbound")
    ).toBeNull();
  });
});

describe("the Supabase-backed resolver", () => {
  function fakeClient(handlers: {
    readonly select?: unknown;
    readonly error?: { readonly message: string } | null;
  }) {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({
        data: handlers.select ?? null,
        error: handlers.error ?? null
      }))
    };
    return { from: vi.fn(() => chain), chain };
  }

  it("asks for exactly the one account the direction needs", async () => {
    const client = fakeClient({ select: { id: incomeAccount, code: "CONTRIBUTION_INCOME" } });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    const resolved = await resolver.resolve(groupId, cashAccount, "inbound");

    expect(resolved).toEqual({ cashAccountId: cashAccount, counterAccountId: incomeAccount });
    expect(client.from).toHaveBeenCalledWith("ledger_accounts");
    expect(client.chain.eq).toHaveBeenNthCalledWith(1, "group_id", groupId);
    expect(client.chain.eq).toHaveBeenNthCalledWith(2, "code", "CONTRIBUTION_INCOME");
  });

  it("asks for the expense account when money leaves", async () => {
    const client = fakeClient({ select: { id: expenseAccount, code: "PAYOUT_EXPENSE" } });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    await resolver.resolve(groupId, cashAccount, "outbound");

    expect(client.chain.eq).toHaveBeenNthCalledWith(2, "code", "PAYOUT_EXPENSE");
  });

  it("returns null for a group that has not been provisioned", async () => {
    const client = fakeClient({ select: null });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    expect(await resolver.resolve(groupId, cashAccount, "inbound")).toBeNull();
  });

  it("returns null when a row comes back that is not one of our codes", async () => {
    // Trusting an arbitrary `code` from the row would let a group post a
    // contribution against whatever account it liked.
    const client = fakeClient({ select: { id: incomeAccount, code: "SOMETHING_ELSE" } });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    expect(await resolver.resolve(groupId, cashAccount, "inbound")).toBeNull();
  });

  it("does not query at all for a malformed id", async () => {
    const client = fakeClient({ select: { id: incomeAccount, code: "CONTRIBUTION_INCOME" } });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    expect(await resolver.resolve("not-a-uuid", cashAccount, "inbound")).toBeNull();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("throws when storage fails, rather than reporting an unprovisioned group", async () => {
    // These are different faults and a treasurer must be able to tell them
    // apart: one means "set your accounts up", the other means "try again".
    const client = fakeClient({ error: { message: "connection reset" } });
    const resolver = new SupabaseLedgerAccountResolver(client as never);

    await expect(resolver.resolve(groupId, cashAccount, "inbound")).rejects.toBeInstanceOf(
      LedgerAccountLookupError
    );
  });
});

describe("the production wiring actually builds a sink", () => {
  const composition = readFileSync(join(process.cwd(), "src", "lib", "banking", "server.ts"), "utf8");

  it("constructs the sink and passes it to the service", () => {
    // `BankVerificationService` accepted a `ledgerSink` option and the
    // production factory never passed one, so the whole trust loop was dead in
    // the only code path that runs in production. The behaviour is covered by
    // test/banking.ledger-sink.test.ts; this guards the wiring, which nothing
    // else observes because the field is private.
    expect(composition).toContain("new LedgerBankVerificationSink(");
    expect(composition).toMatch(/new BankVerificationService\(\{[\s\S]*?ledgerSink/);
  });

  it("resolves accounts through the RLS-checked client, not a hard-coded id", () => {
    expect(composition).toContain("new SupabaseLedgerAccountResolver(client)");
    expect(composition).toContain("intent.ledgerAccountId");
    expect(composition).toContain("intent.direction");
  });
});
