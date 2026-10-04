import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The server modules and the migration must agree on every function's argument
 * names, and the migration must keep the properties the SQL harness proves by
 * running it (`scripts/verify-migrations.sql`, "ALL ATTRIBUTION AND COLLATERAL
 * CHECKS PASSED"): this is the static half, so a rename or a dropped guard is
 * caught without a database.
 */
const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261010100000_contribution_attribution_and_collateral.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");
const attributionServer = readFileSync(join(process.cwd(), "src/lib/ledger/attribution.ts"), "utf8");
const collateralServer = readFileSync(join(process.cwd(), "src/lib/draw/collateralServer.ts"), "utf8");
const reader = readFileSync(join(process.cwd(), "src/lib/ledger/reader.ts"), "utf8");

function args(name: string): string[] {
  const match = new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)`).exec(code);
  expect(match, name).not.toBeNull();
  return match![1]!
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0]!)
    .filter(Boolean);
}

function body(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = code.indexOf("create or replace function public.", start + 10);
  return code.slice(start, next === -1 ? undefined : next);
}

describe("attribution functions", () => {
  it("take exactly the arguments the server module sends, and none that names who is recording", () => {
    expect(args("record_ledger_entry_attribution_v1")).toEqual(["p_group_id", "p_entry_id", "p_member_user_id", "p_cycle_id", "p_round"]);
    expect(args("supersede_ledger_entry_attribution_v1")).toEqual([
      "p_group_id",
      "p_entry_id",
      "p_member_user_id",
      "p_reason",
      "p_cycle_id",
      "p_round"
    ]);
    expect(args("get_ledger_entry_attributions_v1")).toEqual(["p_group_id", "p_entry_ids"]);
    for (const name of ["p_group_id", "p_entry_id", "p_member_user_id", "p_cycle_id", "p_round", "p_reason"]) {
      expect(attributionServer).toContain(`${name}:`);
    }
    expect(reader).toContain('client.rpc("get_ledger_entry_attributions_v1"');
    expect(attributionServer).toContain('"record_ledger_entry_attribution_v1"');
    expect(attributionServer).toContain('"supersede_ledger_entry_attribution_v1"');
    for (const name of ["record_ledger_entry_attribution_v1", "supersede_ledger_entry_attribution_v1", "sened_attribute_entry"]) {
      expect(args(name).join(" ")).not.toMatch(/recorded_by|actor|user_id_of|p_user\b|source/);
    }
  });

  it("takes the recorder from auth.uid(), and gates writes on the group's manager role", () => {
    const write = body("sened_attribute_entry");
    expect(write).toMatch(/actor uuid := auth\.uid\(\)/);
    expect(write).toMatch(/sened_ledger_can_manage_group\(p_group_id, tenant\)/);
    expect(write).toMatch(/recorded_by|actor/);
    expect(write).toMatch(/values\s*\(p_entry_id, p_group_id, tenant, p_member_user_id, actor, p_cycle_id, p_round\)/);
  });

  it("refuses non-contributions, another group's entry, inactive members, reversed entries and bank-verified entries", () => {
    const write = body("sened_attribute_entry");
    expect(write).toMatch(/entry_row\.entry_type <> 'contribution'/);
    expect(write).toMatch(/ledger_row\.group_id = p_group_id/);
    expect(write).toMatch(/sened_ledger_is_active_member\(p_group_id, p_member_user_id\)/);
    expect(write).toMatch(/fix\.corrects_entry_id = p_entry_id/);
    expect(write).toMatch(/attribution_bank_verified/);
    expect(write).toMatch(/intent_row\.state = 'VERIFIED'/);
    // The same bank rule is held by the trigger for any writer.
    expect(body("sened_attribution_validate_insert")).toMatch(/attribution_bank_verified/);
    expect(body("sened_attribution_validate_insert")).toMatch(/attribution_not_contribution/);
  });

  it("is append-only: no update or delete of the table, immutability and truncate triggers, unique roots and successors", () => {
    expect(code).toMatch(/before update or delete on public\.ledger_entry_attributions/);
    expect(code).toMatch(/before truncate on public\.ledger_entry_attributions/);
    expect(code).toMatch(/ledger_attributions_one_root_per_entry_idx[\s\S]*where supersedes_id is null/);
    expect(code).toMatch(/ledger_attributions_one_successor_idx[\s\S]*where supersedes_id is not null/);
    expect(code).not.toMatch(/update public\.ledger_entry_attributions/i);
    expect(code).not.toMatch(/delete from public\.ledger_entry_attributions/i);
    expect(code).toMatch(/revoke all on table public\.ledger_entry_attributions from anon, authenticated/);
    expect(code).toMatch(/grant select on table public\.ledger_entry_attributions to authenticated/);
    expect(code).not.toMatch(/grant (insert|update|delete|all) on table public\.ledger_entry_attributions/i);
  });

  it("never touches the hash-chained entry: no change to ledger_entries, postings or the head", () => {
    expect(code).not.toMatch(/alter table public\.ledger_entries/i);
    expect(code).not.toMatch(/(update|delete from|insert into) public\.ledger_entries\b/i);
    expect(code).not.toMatch(/(update|delete from|insert into) public\.ledger_entry_postings/i);
    expect(code).not.toMatch(/(update|insert into|delete from) public\.ledger_group_heads/i);
    expect(code).not.toMatch(/entry_hash\s*=|previous_hash\s*=/i);
  });

  it("gives bank provenance priority 0 over the treasurer's record and exposes the same fields the reader parses", () => {
    const effective = body("sened_effective_attribution");
    expect(effective).toMatch(/0 as priority/);
    expect(effective).toMatch(/1\s*\n\s*from public\.ledger_entry_attributions tip|,\s*1\s*\n\s*from public\.ledger_entry_attributions tip/);
    expect(effective).toMatch(/order by picked\.priority/);
    const json = body("sened_attribution_json");
    for (const key of ["entryId", "memberUserId", "source", "recordedBy", "recordedAt", "cycleId", "round", "revision", "reason"]) {
      expect(json).toContain(`'${key}'`);
      expect(reader.slice(reader.indexOf("function parseAttribution"))).toContain(key);
    }
  });

  it("is granted to signed-in users only, and the internals to nobody", () => {
    for (const signature of [
      "get_ledger_entry_attributions_v1(uuid, uuid[])",
      "record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer)",
      "supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer)"
    ]) {
      expect(code).toContain(`revoke all on function public.${signature} from public, anon;`);
      expect(code).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    for (const internal of [
      "sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text)",
      "sened_effective_attribution(uuid, uuid)",
      "sened_attribution_json(uuid, uuid)",
      "sened_collateral_member_entries(uuid, uuid)"
    ]) {
      expect(code).toContain(`revoke all on function public.${internal} from public, anon, authenticated;`);
      expect(code).not.toContain(`grant execute on function public.${internal}`);
    }
    for (const name of [
      "get_ledger_entry_attributions_v1",
      "sened_attribute_entry",
      "record_ledger_entry_attribution_v1",
      "supersede_ledger_entry_attribution_v1"
    ]) {
      expect(body(name)).toMatch(/security definer/);
      expect(body(name)).toMatch(/set search_path = public, pg_temp/);
    }
  });
});

describe("collateral functions", () => {
  it("take exactly the arguments the server module sends, and none that names the acting user", () => {
    expect(args("propose_collateral_guarantee_v1")).toEqual(["p_cycle_id", "p_winner_member_id", "p_guarantor_member_id"]);
    expect(args("respond_collateral_guarantee_v1")).toEqual(["p_guarantee_id", "p_accept", "p_reason"]);
    expect(args("release_collateral_guarantee_v1")).toEqual(["p_guarantee_id", "p_reason"]);
    expect(args("supersede_collateral_guarantee_v1")).toEqual(["p_guarantee_id", "p_new_guarantor_member_id", "p_reason"]);
    expect(args("get_draw_cycle_collateral_v1")).toEqual(["p_cycle_id"]);
    for (const name of [
      "p_cycle_id",
      "p_winner_member_id",
      "p_guarantor_member_id",
      "p_guarantee_id",
      "p_accept",
      "p_reason",
      "p_new_guarantor_member_id"
    ]) {
      expect(collateralServer).toContain(`${name}:`);
    }
    for (const rpc of [
      "propose_collateral_guarantee_v1",
      "respond_collateral_guarantee_v1",
      "release_collateral_guarantee_v1",
      "supersede_collateral_guarantee_v1",
      "get_draw_cycle_collateral_v1"
    ]) {
      expect(collateralServer).toContain(`"${rpc}"`);
    }
  });

  it("holds the guarantor's own consent in the RPC and again in a trigger", () => {
    const respond = body("respond_collateral_guarantee_v1");
    expect(respond).toMatch(/actor uuid := auth\.uid\(\)/);
    expect(respond).toMatch(/guarantee_row\.guarantor_member_id <> actor/);
    expect(respond).toMatch(/values \(p_guarantee_id, guarantee_row\.group_id, wanted, actor, clean_reason\)/);
    const trigger = body("sened_collateral_validate_event");
    expect(trigger).toMatch(/new\.event_type in \('accepted', 'declined'\)/);
    expect(trigger).toMatch(/new\.actor_id <> guarantee_row\.guarantor_member_id/);
    // Superseding is for managers only, at table level too.
    expect(trigger).toMatch(/sened_ledger_user_manages_group\(new\.group_id, new\.actor_id\)/);
  });

  it("proposes only for a manager, a real winner with rounds left, an active guarantor who is not the winner", () => {
    const propose = body("propose_collateral_guarantee_v1");
    expect(propose).toMatch(/sened_ledger_can_manage_group\(cyc\.group_id, tenant\)/);
    expect(propose).toMatch(/sened_collateral_win_round\(p_cycle_id, p_winner_member_id\)/);
    expect(propose).toMatch(/win_round >= cyc\.total_rounds/);
    expect(propose).toMatch(/sened_ledger_is_active_member\(cyc\.group_id, p_guarantor_member_id\)/);
    expect(propose).toMatch(/p_winner_member_id = p_guarantor_member_id/);
    expect(code).toMatch(/draw_guarantees_guarantor_not_winner check \(guarantor_member_id <> winner_member_id\)/);
    expect(body("sened_collateral_validate_guarantee")).toMatch(/collateral_winner_not_found/);
  });

  it("is append-only with the state derived from events, never a stored column", () => {
    expect(code).toMatch(/before update or delete on public\.draw_collateral_guarantees/);
    expect(code).toMatch(/before update or delete on public\.draw_collateral_guarantee_events/);
    expect(code).toMatch(/before truncate on public\.draw_collateral_guarantees/);
    expect(code).toMatch(/before truncate on public\.draw_collateral_guarantee_events/);
    expect(code).not.toMatch(/update public\.draw_collateral_guarantee/i);
    expect(code).not.toMatch(/delete from public\.draw_collateral_guarantee/i);
    const guaranteeTable = /create table if not exists public\.draw_collateral_guarantees \(([\s\S]*?)\n\);/.exec(code)![1]!;
    expect(guaranteeTable).not.toMatch(/\bstatus\b|\bstate\b|\bflagged\b|\bpaid\b/);
    expect(body("sened_collateral_guarantee_state")).toMatch(/order by ev\.seq desc/);
    expect(code).toMatch(/event_type in \('released', 'superseded'\) and reason is not null/);
  });

  it("is ADVISORY: it never writes the ledger, a posting or a draw table", () => {
    const collateral = code.slice(code.indexOf("-- B1. Guarantee tables"));
    expect(collateral).not.toMatch(/(insert into|update|delete from) public\.ledger_/i);
    expect(collateral).not.toMatch(/post_ledger_entry_v1/);
    expect(collateral).not.toMatch(/(insert into|update|delete from) public\.draw_(commitments|reveals|payouts|sessions|cycles)/i);
  });

  it("derives the default flags on read, from the documented rule", () => {
    const view = body("get_draw_cycle_collateral_v1");
    expect(view).toMatch(/security definer/);
    expect(view).toMatch(/sened_ledger_can_access_group\(cyc\.group_id, tenant\)/);
    expect(view).toMatch(/'met'/);
    expect(view).toMatch(/'flagged'/);
    expect(view).toMatch(/'not_due'/);
    // The five conditions live in the entries helper.
    const entries = body("sened_collateral_member_entries");
    expect(entries).toMatch(/entry_row\.entry_type = 'contribution'/);
    expect(entries).toMatch(/entry_row\.recorded_at >= cyc\.started_at/);
    expect(entries).toMatch(/fix\.corrects_entry_id = entry_row\.id/);
    expect(entries).toMatch(/account_row\.code = 'POT_CASH'/);
    expect(entries).toMatch(/eff\.cycle_id is null or eff\.cycle_id = cyc\.id/);
    expect(entries).toMatch(/>= greatest\(coalesce\(cyc\.contribution_amount, 0\.01\), 0\.01\)/);
    expect(view).toMatch(/c\.recorded_at > prev_at/);
  });

  it("is granted to signed-in users only", () => {
    for (const signature of [
      "propose_collateral_guarantee_v1(uuid, uuid, uuid)",
      "respond_collateral_guarantee_v1(uuid, boolean, text)",
      "release_collateral_guarantee_v1(uuid, text)",
      "supersede_collateral_guarantee_v1(uuid, uuid, text)",
      "get_draw_cycle_collateral_v1(uuid)"
    ]) {
      expect(code).toContain(`revoke all on function public.${signature} from public, anon;`);
      expect(code).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    expect(code).toMatch(/revoke all on table public\.draw_collateral_guarantees from anon, authenticated/);
    expect(code).toMatch(/revoke all on table public\.draw_collateral_guarantee_events from anon, authenticated/);
    expect(code).not.toMatch(/grant (insert|update|delete|all) on table public\.draw_collateral/i);
  });

  it("is a new migration after every released one", () => {
    expect("20261010100000_contribution_attribution_and_collateral.sql" > "20261009100000_member_attire.sql").toBe(true);
  });
});
