import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listGroupLedgerEntries } from "@/lib/ledger/reader";

const groupId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const cash = "33333333-3333-4333-8333-333333333333";
const income = "44444444-4444-4444-8444-444444444444";

const pad = (n: number, width = 12) => String(n).padStart(width, "0");
const entryId = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;
const postingId = (n: number, k: number) => `${pad(n, 8)}-0000-4000-8000-${pad(k)}`;

function entryRow(n: number) {
  return {
    id: entryId(n),
    group_id: groupId,
    sequence: n,
    occurred_at: "2026-09-25T10:30:00+00:00",
    recorded_at: "2026-09-25T10:30:01+00:00",
    entry_type: "journal",
    corrects_entry_id: null,
    rationale: null,
    actor_id: actorId,
    nonce: `00000000-0000-4000-8000-${pad(n + 5000)}`,
    previous_hash: "0".repeat(64),
    entry_hash: String(n % 10).repeat(64)
  };
}

/** Pairs of one debit and one credit of equal amount per entry; `drop` removes rows to model a truncated read. */
function fakeClient(entryCount: number, postingsPerEntry: number, drop: (id: string) => boolean = () => false) {
  const inCalls: number[] = [];
  const entries = Array.from({ length: entryCount }, (_, index) => entryRow(entryCount - index));
  const postingTable = Array.from({ length: entryCount }, (_, index) => index + 1).flatMap((n) =>
    Array.from({ length: postingsPerEntry }, (_, k) => ({
      id: postingId(n, k),
      entry_id: entryId(n),
      account_id: k % 2 === 0 ? cash : income,
      direction: k % 2 === 0 ? "debit" : "credit",
      amount: 10,
      ordinal: k + 1
    }))
  );
  const builder = (table: string) => {
    let ids: string[] = [];
    const self: Record<string, unknown> = {};
    for (const op of ["select", "eq", "lt", "order", "limit"]) {
      self[op] = () => self;
    }
    self.maybeSingle = () => Promise.resolve({ data: { id: groupId }, error: null });
    self.in = (_column: string, values: string[]) => {
      ids = values;
      inCalls.push(values.length);
      return self;
    };
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({
        data:
          table === "ledger_entries"
            ? entries
            : postingTable.filter((row) => ids.includes(row.entry_id) && !drop(row.id)),
        error: null
      }).then(resolve, reject);
    return self;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: [], error: null })
  } as unknown as SupabaseClient;
  return { client, inCalls };
}

describe("ledger reads fetch postings in chunks and check that each entry balances", () => {
  it("never asks for more than 25 entries postings in one request", async () => {
    const { client, inCalls } = fakeClient(60, 2);
    const page = await listGroupLedgerEntries(client, groupId, 100);
    expect(page).toHaveLength(60);
    expect(inCalls.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...inCalls)).toBeLessThanOrEqual(25);
    expect(inCalls.reduce((sum, size) => sum + size, 0)).toBe(60);
    for (const entry of page ?? []) {
      expect(entry.postings).toHaveLength(2);
    }
  });

  it("keeps an entry with many postings whole across chunk boundaries", async () => {
    const { client } = fakeClient(30, 40);
    const page = await listGroupLedgerEntries(client, groupId, 100);
    expect(page?.every((entry) => entry.postings.length === 40)).toBe(true);
  });

  it("throws an integrity failure when an entry has lost a posting", async () => {
    const { client } = fakeClient(5, 4, (id) => id === postingId(3, 3));
    await expect(listGroupLedgerEntries(client, groupId, 100)).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });
});
