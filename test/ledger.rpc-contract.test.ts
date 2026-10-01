import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseLedgerRepository } from "@/lib/ledger/repository";

function migrationParameterNames(): string[] {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260924214531_ledger_core.sql"),
    "utf8"
  );
  const match = /create or replace function public\.post_ledger_entry_v1\(([^)]*)\)/i.exec(sql);
  if (!match) {
    throw new Error("post_ledger_entry_v1 declaration not found");
  }
  return match[1]
    .split(",")
    .map((parameter) => parameter.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe("post_ledger_entry_v1 RPC contract", () => {
  it("sends exactly the parameter names the SQL function declares", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const repository = new SupabaseLedgerRepository({ rpc } as unknown as SupabaseClient);

    await repository
      .append(
        {
          groupId: "22222222-2222-4222-8222-222222222222",
          idempotencyKey: "contract-001",
          occurredAt: "2026-09-25T10:30:00.000Z",
          entryType: "contribution",
          postings: [
            {
              accountId: "33333333-3333-4333-8333-333333333333",
              direction: "debit",
              amount: "25.00"
            },
            {
              accountId: "44444444-4444-4444-8444-444444444444",
              direction: "credit",
              amount: "25.00"
            }
          ]
        },
        { actorId: "11111111-1111-4111-8111-111111111111" } as never
      )
      .catch(() => undefined);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("post_ledger_entry_v1");
    expect(Object.keys(args).sort()).toEqual(migrationParameterNames().sort());
  });
});

describe("post_ledger_entry_v1 error mapping", () => {
  it("maps the one-correction-per-entry unique index (23505) to INVALID_CORRECTION, not a storage failure", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "ledger_entries_one_correction_per_original_idx"'
      }
    });
    const repository = new SupabaseLedgerRepository({ rpc } as unknown as SupabaseClient);
    await expect(
      repository.append(
        {
          groupId: "22222222-2222-4222-8222-222222222222",
          idempotencyKey: "k-1",
          occurredAt: "2026-09-25T10:30:00.000Z",
          entryType: "correction",
          correctsEntryId: "55555555-5555-4555-8555-555555555555",
          rationale: "wrong amount entered",
          postings: [
            { accountId: "33333333-3333-4333-8333-333333333333", direction: "credit", amount: "25.00" },
            { accountId: "44444444-4444-4444-8444-444444444444", direction: "debit", amount: "25.00" }
          ]
        },
        { actorId: "11111111-1111-4111-8111-111111111111" } as never
      )
    ).rejects.toMatchObject({ code: "INVALID_CORRECTION" });
  });
});
