import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The reader and the migration must agree on the provenance function, and the
 * function must stay a narrow window onto `bank_verification_intents`. The SQL
 * itself is executed by `scripts/verify-migrations.sql`; this guards the parts a
 * static read can: parameter names, grants, and that no reference material is
 * ever selected into the response.
 */
const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261006100000_ledger_entry_provenance.sql"), "utf8");
const reader = readFileSync(join(process.cwd(), "src/lib/ledger/reader.ts"), "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("get_ledger_entry_provenance_v1", () => {
  it("takes exactly the arguments the reader sends", () => {
    const signature = /create or replace function public\.get_ledger_entry_provenance_v1\(([^)]*)\)/.exec(code);
    expect(signature).not.toBeNull();
    const names = signature![1].split(",").map((part) => part.trim().split(/\s+/)[0]);
    expect(names).toEqual(["p_group_id", "p_entry_ids"]);
    expect(reader).toContain('client.rpc("get_ledger_entry_provenance_v1"');
    for (const name of names) {
      expect(reader).toContain(`${name}:`);
    }
  });

  it("is scoped to group membership and callable only by signed-in users", () => {
    expect(code).toMatch(/security definer/i);
    expect(code).toMatch(/sened_ledger_can_access_group\(p_group_id, tenant\)/);
    expect(code).toMatch(/revoke all on function public\.get_ledger_entry_provenance_v1\(uuid, uuid\[\]\) from public, anon/);
    expect(code).toMatch(/grant execute on function public\.get_ledger_entry_provenance_v1\(uuid, uuid\[\]\) to authenticated/);
    expect(code).toMatch(/intent_row\.group_id = p_group_id/);
    expect(code).toMatch(/intent_row\.state = 'VERIFIED'/);
  });

  it("never selects reference material, the key, the fingerprint or the secrets table", () => {
    const body = code.slice(code.indexOf("create or replace function public.get_ledger_entry_provenance_v1"));
    for (const forbidden of [
      "provider_reference",
      "ciphertext",
      "hmac",
      "idempotency_key",
      "request_fingerprint",
      "evidence_fingerprint",
      "bank_verification_secrets",
      "bank_account_binding"
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("does not widen any table policy or privilege", () => {
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant (select|all)/i);
  });
});
