// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { LedgerBankVerificationSink } from "@/lib/banking/ledgerSink";
import type { BankVerificationIntent } from "@/lib/banking/types";
import { LedgerService, SupabaseLedgerRepository } from "@/lib/ledger/repository";

const actor = "11111111-1111-4111-8111-111111111111";
const group = "22222222-2222-4222-8222-222222222222";
const cash = "33333333-3333-4333-8333-333333333333";
const income = "44444444-4444-4444-8444-444444444444";
const lease = "99999999-9999-4999-8999-999999999999";

const request = {
  groupId: group,
  idempotencyKey: "bank-verified-k",
  occurredAt: "2026-10-01T10:00:00.000Z",
  entryType: "contribution" as const,
  postings: [
    { accountId: cash, direction: "debit" as const, amount: "25.00" },
    { accountId: income, direction: "credit" as const, amount: "25.00" }
  ]
};

describe("the worker ledger post carries the claimed job lease token", () => {
  it("refuses to post as the worker without a lease token, before any RPC", async () => {
    const rpc = vi.fn();
    const repository = new SupabaseLedgerRepository({ rpc } as unknown as SupabaseClient, { postAsReconciliationWorker: true });
    await expect(new LedgerService(repository).append(request, { actorId: actor })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends requested_lease_token to the worker RPC, and never to the user RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "ledger_forbidden" } }));
    const worker = new SupabaseLedgerRepository({ rpc } as unknown as SupabaseClient, { postAsReconciliationWorker: true });
    await new LedgerService(worker).append(request, { actorId: actor, reconciliationLeaseToken: lease }).catch(() => undefined);
    expect(rpc).toHaveBeenCalledWith(
      "post_ledger_entry_for_reconciliation_v1",
      expect.objectContaining({ requested_actor_id: actor, requested_lease_token: lease })
    );

    const userRpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "ledger_forbidden" } }));
    const user = new SupabaseLedgerRepository({ rpc: userRpc } as unknown as SupabaseClient);
    await new LedgerService(user).append(request, { actorId: actor, reconciliationLeaseToken: lease }).catch(() => undefined);
    const [name, args] = userRpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("post_ledger_entry_v1");
    expect(args).not.toHaveProperty("requested_lease_token");
  });

  it("the sink hands the lease token from the drain to the ledger", async () => {
    const append = vi.fn(async () => ({ entry: { id: "e1" } }));
    const sink = new LedgerBankVerificationSink({
      ledger: { append } as never,
      accounts: () => ({ cashAccountId: cash, counterAccountId: income })
    });
    const intent = {
      state: "VERIFIED",
      direction: "inbound",
      groupId: group,
      userId: actor,
      amount: "25.00",
      idempotencyKey: "k",
      occurredAt: "2026-10-01T10:00:00.000Z"
    } as unknown as BankVerificationIntent;
    await sink.postVerifiedContribution(intent, { leaseToken: lease });
    expect(append).toHaveBeenCalledWith(expect.anything(), { actorId: actor, reconciliationLeaseToken: lease });
    await sink.postVerifiedContribution(intent);
    expect(append).toHaveBeenLastCalledWith(expect.anything(), { actorId: actor });
  });
});

describe("20261014110000_review_hardening.sql", () => {
  const raw = readFileSync(join(process.cwd(), "supabase/migrations/20261014110000_review_hardening.sql"), "utf8");
  const sql = raw.split("\r\n").join("\n").replace(/--.*$/gm, "");

  it("replaces the 8-argument worker post with one that takes and checks the lease token", () => {
    expect(sql).toMatch(/drop function if exists public\.post_ledger_entry_for_reconciliation_v1\(\s*uuid, uuid, text, timestamptz, text, uuid, text, jsonb\s*\)/);
    expect(sql).toMatch(/requested_lease_token uuid/);
    expect(sql).toMatch(/job_row\.lease_token = requested_lease_token/);
  });

  it("requires the cash leg direction and the group's own counter account", () => {
    expect(sql).toMatch(/\(posting ->> 'direction'\) = case intent_row\.direction when 'inbound' then 'debit' else 'credit' end/);
    expect(sql).toMatch(/counter\.code = case intent_row\.direction when 'inbound' then 'CONTRIBUTION_INCOME' else 'PAYOUT_EXPENSE' end/);
    expect(sql).toMatch(/counter\.group_id = intent_row\.group_id/);
  });

  it("stays callable by service_role only, and drops extensions from list_group_members_v1", () => {
    expect(sql).toMatch(/grant execute on function public\.post_ledger_entry_for_reconciliation_v1\([^)]*\) to service_role/);
    expect(sql).toMatch(/revoke all on function public\.post_ledger_entry_for_reconciliation_v1\([^)]*\)\s*from public, anon, authenticated/);
    const members = sql.slice(sql.indexOf("function public.list_group_members_v1"));
    expect(members).toMatch(/set search_path = public, pg_temp/);
    expect(members).not.toMatch(/extensions/);
  });
});
