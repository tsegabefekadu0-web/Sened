import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The reader and the migration must agree on `get_ledger_balances_v1`: argument
 * name, result keys, grants and scoping. The SQL is executed by
 * `scripts/verify-migrations.sql`; this guards what a static read can, so TS and
 * SQL cannot drift apart silently.
 */
const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261007100000_ledger_balances.sql"), "utf8");
const reader = readFileSync(join(process.cwd(), "src/lib/ledger/reader.ts"), "utf8");
// Windows checkouts convert to CRLF (core.autocrlf); the contract is about the SQL, not its line endings.
const code = sql.split("\r\n").join("\n").replace(/--.*$/gm, "");

describe("get_ledger_balances_v1", () => {
  it("takes exactly the argument the reader sends", () => {
    const signature = /create or replace function public\.get_ledger_balances_v1\(([^)]*)\)/.exec(code);
    expect(signature).not.toBeNull();
    const names = signature![1].split(",").map((part) => part.trim().split(/\s+/)[0]);
    expect(names).toEqual(["p_group_id"]);
    expect(reader).toContain('client.rpc("get_ledger_balances_v1"');
    expect(reader).toContain("p_group_id:");
  });

  it("returns the keys the reader parses, and nothing else the reader would ignore", () => {
    const top = ["groupId", "headSequence", "entryCount", "balances"];
    const perAccount = ["accountId", "code", "name", "accountType", "balance"];
    for (const key of [...top, ...perAccount]) {
      expect(code, key).toContain(`'${key}'`);
      expect(reader.includes(`"${key}"`) || reader.includes(`.${key}`), key).toBe(true);
    }
    const emitted = [...code.matchAll(/'([A-Za-z]+)',/g)].map((match) => match[1]);
    expect(new Set(emitted)).toEqual(new Set([...top, ...perAccount]));
  });

  it("renders amounts, head and count as text, so no client ever sees a float", () => {
    expect(code).toMatch(/round\(coalesce\(net\.balance, 0\), 2\)::text/);
    expect(code).toMatch(/\)::text,\s*\n\s*'entryCount'/);
    expect(code).toMatch(/\)::text,\s*\n\s*'balances'/);
  });

  it("computes head, count and balances in one statement, so they share one snapshot", () => {
    const body = code.slice(code.indexOf("begin\n"), code.lastIndexOf("end;"));
    // Exactly one statement reads the ledger tables: a single `with ... select ... into`.
    expect(body.match(/\bwith net as\b/g)).toHaveLength(1);
    expect(body.match(/\binto result\b/g)).toHaveLength(1);
    expect(body.match(/\bfrom public\.ledger_(entries|group_heads|entry_postings)\b/g)?.length).toBeGreaterThanOrEqual(3);
    const afterInto = body.slice(body.indexOf("into result;"));
    expect(afterInto).not.toMatch(/\bselect\b/i);
  });

  it("is debit-positive for every account type", () => {
    expect(code).toMatch(/case posting\.direction when 'debit' then posting\.amount else -posting\.amount end/);
  });

  it("is scoped to group membership exactly like the other ledger reads and callable only by signed-in users", () => {
    expect(code).toMatch(/security definer/i);
    expect(code).toMatch(/set search_path = public, pg_temp/);
    expect(code).toMatch(/auth\.uid\(\)/);
    expect(code).toMatch(/sened_ledger_can_access_group\(p_group_id, tenant\)/);
    expect(code).toMatch(/errcode = '42501', message = 'ledger_forbidden'/);
    expect(code).toMatch(/revoke all on function public\.get_ledger_balances_v1\(uuid\) from public, anon/);
    expect(code).toMatch(/grant execute on function public\.get_ledger_balances_v1\(uuid\) to authenticated/);
    // Every table read is filtered to the requested group.
    expect(code).toMatch(/posting\.group_id = p_group_id/);
    expect(code).toMatch(/head_row\.group_id = p_group_id/);
    expect(code).toMatch(/entry_row\.group_id = p_group_id/);
    expect(code).toMatch(/account_row\.group_id = p_group_id/);
  });

  it("is a read: it writes nothing and widens no policy or privilege", () => {
    expect(code).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant (select|all)/i);
    expect(code).not.toMatch(/create (unique )?index/i);
  });

  it("the route refuses with 404 on the same code the function raises", () => {
    expect(reader).toContain('"ledger_forbidden"');
    expect(reader).toContain('"42501"');
  });
});
