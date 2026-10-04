import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MASKED_REFERENCE_PATTERN } from "@/lib/banking/referenceMask";

/**
 * The reference-display migration, the server's RPC call and the harness must
 * agree. The SQL itself is executed by `scripts/verify-migrations.sql`; this
 * guards what a static read can: argument names, the single create function,
 * the CHECK constraint matching the TypeScript shape, and that provenance never
 * selects anything but the masked column.
 */
const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261008100000_bank_reference_display.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");
const server = readFileSync(join(process.cwd(), "src/lib/banking/server.ts"), "utf8");
const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");
const runner = readFileSync(join(process.cwd(), "scripts/verify-migrations.ps1"), "utf8");

function signature(fn: string): string[] {
  const match = new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`).exec(code);
  expect(match, fn).not.toBeNull();
  return match![1].split(",").map((part) => part.trim().split(/\s+/)[0]);
}

describe("20261008100000_bank_reference_display.sql", () => {
  it("adds the same optional argument the server sends, last, with a default", () => {
    const names = signature("create_bank_verification_intent_v1");
    expect(names.at(-1)).toBe("p_reference_display");
    expect(code).toMatch(/p_reference_display text default null/);
    const rpc = server.slice(server.indexOf('client.rpc("create_bank_verification_intent_v1"'));
    for (const name of names) {
      expect(rpc.slice(0, 900), name).toContain(`${name}:`);
    }
  });

  it("drops the old ten-argument function so PostgREST never sees two candidates", () => {
    expect(code).toMatch(
      /drop function if exists public\.create_bank_verification_intent_v1\(\s*uuid, text, text, text, text, numeric, text, text, timestamptz, text\s*\)/
    );
  });

  it("re-grants the new signature to authenticated only", () => {
    const eleven = "uuid, text, text, text, text, numeric, text, text, timestamptz, text, text";
    expect(code).toContain(`revoke all on function public.create_bank_verification_intent_v1(${eleven}) from public, anon;`);
    expect(code).toContain(`grant execute on function public.create_bank_verification_intent_v1(${eleven}) to authenticated;`);
  });

  it("enforces the masked shape in a CHECK constraint that matches the TypeScript pattern", () => {
    expect(code).toMatch(/add column if not exists reference_display text;/);
    const checks = [...code.matchAll(/~ '(\^\\u2022\{4\}\[!-~\]\{1,4\}\$)'/g)].map((match) => match[1]);
    // the constraint, the create RPC's own pre-check and the backfill setter's
    expect(checks).toHaveLength(3);
    const tsPattern = MASKED_REFERENCE_PATTERN.source.replace(/\\u2022/, "•");
    for (const check of checks) {
      expect(check.replace("\\u2022", "•")).toBe(tsPattern);
    }
    expect(code).toContain("add constraint bank_intents_reference_display_masked");
  });

  it("exposes the display only as referenceMasked in provenance, and as referenceDisplay on the owner's intent", () => {
    const start = code.indexOf("create or replace function public.get_ledger_entry_provenance_v1");
    const provenance = code.slice(start, code.indexOf("revoke all on function public.get_ledger_entry_provenance_v1", start));
    expect(provenance).toContain("'referenceMasked', intent_row.reference_display");
    for (const forbidden of ["provider_reference", "ciphertext", "hmac", "idempotency_key", "bank_verification_secrets"]) {
      expect(provenance, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("'referenceDisplay', intent_row.reference_display");
  });

  it("exposes the backfill helpers to service_role only, with exactly the arguments the script sends", () => {
    expect(signature("list_bank_reference_display_backfill_v1")).toEqual(["p_after", "p_limit"]);
    expect(signature("set_bank_reference_display_v1")).toEqual(["p_verification_id", "p_reference_display"]);
    expect(code).toContain("revoke all on function public.list_bank_reference_display_backfill_v1(uuid, integer) from public, anon, authenticated;");
    expect(code).toContain("revoke all on function public.set_bank_reference_display_v1(uuid, text) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.list_bank_reference_display_backfill_v1(uuid, integer) to service_role;");
    expect(code).toContain("grant execute on function public.set_bank_reference_display_v1(uuid, text) to service_role;");
    expect(code).not.toMatch(/grant execute on function public\.(list|set)_bank_reference_display\w+\([^)]*\) to (authenticated|anon|public)/);
    const script = readFileSync(join(process.cwd(), "scripts/backfill-reference-display.ts"), "utf8");
    expect(script).toContain("p_after");
    expect(script).toContain("p_limit");
    expect(script).toContain("p_verification_id");
    expect(script).toContain("p_reference_display");
  });

  it("widens no table policy or privilege", () => {
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant (select|all)/i);
  });

  it("is covered by the SQL harness and its runner", () => {
    expect(harness).toContain("ALL BANK REFERENCE DISPLAY CHECKS PASSED");
    expect(runner).toContain("ALL BANK REFERENCE DISPLAY CHECKS PASSED");
  });
});
