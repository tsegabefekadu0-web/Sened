import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source-level contract of `20261011100000_contribution_grid_and_gate.sql`: the arities PostgREST
 * will see, who can call what, where the gate bites, and that nothing derived is stored. The
 * behaviour itself (the grid's statuses, the gate's refusals, the override record) is proven by
 * running the migration chain: `scripts/verify-migrations.sql`.
 */

const DIR = "supabase/migrations";
const FILE = "20261011100000_contribution_grid_and_gate.sql";
const sql = readFileSync(join(process.cwd(), DIR, FILE), "utf8");
const code = sql.replace(/--.*$/gm, "");
const repository = readFileSync(join(process.cwd(), "src/lib/draw/repository.ts"), "utf8");
const server = readFileSync(join(process.cwd(), "src/lib/draw/contributionsServer.ts"), "utf8");
const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");
const powershell = readFileSync(join(process.cwd(), "scripts/verify-migrations.ps1"), "utf8");

function body(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`${name} is not defined`);
  const next = code.indexOf("create or replace function public.", start + 10);
  return code.slice(start, next === -1 ? undefined : next);
}

function parameters(name: string): string[] {
  const text = body(name);
  const open = text.indexOf("(");
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  return [...text.slice(open + 1, close).matchAll(/\bp_(\w+)\s+\w+/g)].map((match) => match[1]!);
}

function rpcKeys(source: string, rpc: string): string[] {
  const start = source.indexOf(`.rpc("${rpc}", {`);
  if (start === -1) throw new Error(`${rpc} is not called`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  return [...source.slice(open + 1, close).matchAll(/p_(\w+):/g)].map((match) => match[1]!);
}

describe("the migration is last and does not edit earlier ones", () => {
  it("sorts after every other migration (new file only)", () => {
    const files = readdirSync(join(process.cwd(), DIR)).filter((name) => name.endsWith(".sql")).sort();
    expect(files[files.length - 1]).toBe(FILE);
  });
});

describe("the arities, the repository and the server agree", () => {
  it("open_draw_v1 gains exactly one trailing optional parameter, sent by name", () => {
    expect(parameters("open_draw_v1")).toEqual(["cycle_id", "round", "idempotency_key", "override_reason"]);
    expect(body("open_draw_v1")).toMatch(/p_override_reason text default null/);
    expect(rpcKeys(repository, "open_draw_v1").sort()).toEqual([...parameters("open_draw_v1")].sort());
  });

  it("create_draw_cycle_v1 gains exactly one trailing optional parameter, defaulting to off", () => {
    expect(parameters("create_draw_cycle_v1")).toEqual([
      "group_id", "name", "contribution_amount", "total_rounds", "reserve_ratio_bps", "started_at", "idempotency_key", "contribution_gate"
    ]);
    expect(body("create_draw_cycle_v1")).toMatch(/p_contribution_gate text default 'off'/);
    expect(rpcKeys(repository, "create_draw_cycle_v1").sort()).toEqual([...parameters("create_draw_cycle_v1")].sort());
  });

  it("the old arities are dropped, not left as overloads PostgREST cannot choose between", () => {
    const dropOpen = code.indexOf("drop function if exists public.open_draw_v1(uuid, integer, text);");
    const dropCreate = code.indexOf("drop function if exists public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text);");
    expect(dropOpen).toBeGreaterThan(-1);
    expect(dropCreate).toBeGreaterThan(-1);
    expect(dropOpen).toBeLessThan(code.indexOf("create or replace function public.open_draw_v1("));
    expect(dropCreate).toBeLessThan(code.indexOf("create or replace function public.create_draw_cycle_v1("));
  });

  it("the policy change and the grid read take only what the repository and the server send", () => {
    expect(parameters("set_draw_cycle_contribution_gate_v1")).toEqual(["cycle_id", "gate", "reason"]);
    expect(rpcKeys(repository, "set_draw_cycle_contribution_gate_v1").sort()).toEqual(["cycle_id", "gate", "reason"]);
    expect(parameters("get_draw_cycle_contributions_v1")).toEqual(["cycle_id"]);
    expect(rpcKeys(server, "get_draw_cycle_contributions_v1")).toEqual(["cycle_id"]);
  });

  it("no function takes who is acting or who is overriding: identity is auth.uid()", () => {
    for (const name of ["open_draw_v1", "set_draw_cycle_contribution_gate_v1", "get_draw_cycle_contributions_v1"]) {
      expect(parameters(name).some((parameter) => /actor|user|member/.test(parameter)), name).toBe(false);
      expect(body(name)).toMatch(/auth\.uid\(\)/);
    }
    // The override and the event are written as the caller.
    expect(body("open_draw_v1")).toMatch(/cyc\.id, cyc\.group_id, cyc\.tenant_id, next_round, created_row\.draw_id, actor, clean_override, flagged/);
    expect(body("set_draw_cycle_contribution_gate_v1")).toMatch(/current_gate, p_gate, actor, clean_reason/);
  });
});

describe("where the gate bites", () => {
  const open = body("open_draw_v1");

  it("after the role check and the reason check, before the draw is created", () => {
    const role = open.indexOf("sened_ledger_can_manage_group");
    const reason = open.indexOf("draw_override_reason_invalid");
    const gate = open.indexOf("sened_draw_cycle_gate_flags");
    const blocked = open.indexOf("draw_contribution_gate_blocked");
    const insert = open.indexOf("insert into public.draw_sessions");
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeLessThan(reason);
    expect(reason).toBeLessThan(gate);
    expect(gate).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(insert);
  });

  it("not on a replay or on the continuation of a draw that is already sealing (nothing new is opened)", () => {
    const gate = open.indexOf("sened_draw_cycle_gate_flags");
    expect(open.indexOf("existing_row.draw_id")).toBeLessThan(gate);
    expect(open.indexOf("live_row.draw_id")).toBeLessThan(gate);
  });

  it("looks only at rounds before the one being opened, and only under warn or block", () => {
    expect(open).toMatch(/sened_draw_cycle_gate_flags\(cyc\.id, next_round\)/);
    expect(open).toMatch(/if gate_policy <> 'off' then/);
    expect(open).toMatch(/gate_policy = 'block' and jsonb_array_length\(flagged\) > 0/);
    expect(body("sened_draw_cycle_gate_flags")).toMatch(/g\.round_no < p_before_round/);
    expect(body("sened_draw_cycle_gate_flags")).toMatch(/g\.is_active/);
    expect(body("sened_draw_cycle_gate_flags")).toMatch(/g\.cell_status = 'flagged'/);
  });

  it("the refusal carries who/which rounds in the DETAIL, and the override is recorded in the same statement flow", () => {
    expect(open).toMatch(/detail = flagged::text/);
    expect(open).toMatch(/errcode = 'P0001'/);
    expect(open.indexOf("insert into public.draw_sessions")).toBeLessThan(open.indexOf("insert into public.draw_contribution_gate_overrides"));
    expect(open).toMatch(/char_length\(clean_override\) not between 10 and 1000/);
  });

  it("is not enforced at commit (the gate sits at open, which is the decision point)", () => {
    const commit = readFileSync(join(process.cwd(), DIR, "20261005100000_draw_cycles_and_member_seals.sql"), "utf8");
    expect(commit).not.toMatch(/contribution_gate/);
    expect(code).not.toMatch(/commit_draw_from_seals_v1/);
  });
});

describe("nothing derived is stored, and nothing moves money", () => {
  it("creates only two tables, both audit logs, and neither has a status of a member or a round", () => {
    const tables = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
    expect(tables).toEqual(["draw_cycle_gate_events", "draw_contribution_gate_overrides"]);
    expect(code).not.toMatch(/\bcell_status text not null\b/);
    expect(code).not.toMatch(/create table[^;]*\bstatus\b/);
  });

  it("the status vocabulary is met / flagged / not_due: there is no partial", () => {
    expect(code).not.toMatch(/'partial'/);
    for (const status of ["'met'", "'flagged'", "'not_due'"]) expect(code).toContain(status);
  });

  it("never writes the ledger", () => {
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.ledger_/i);
    expect(code).not.toMatch(/post_ledger_entry_v1/);
  });

  it("the collateral view is rebuilt on the shared derivation instead of repeating it", () => {
    const collateral = body("get_draw_cycle_collateral_v1");
    expect(collateral).toMatch(/sened_draw_cycle_member_rounds\(p_cycle_id, winner_row\.member_id\)/);
    expect(collateral).not.toMatch(/sened_collateral_member_entries/);
    expect(collateral).toMatch(/g\.round_no > winner_row\.win_round/);
  });

  it("winners are split at their win so a post-win payment never clears a pre-win round", () => {
    expect(body("sened_draw_cycle_member_rounds")).toMatch(/win_no is null or r > win_no or e_at\[i\] <= win_rev/);
  });
});

describe("who can call what", () => {
  const rpcs: [string, string][] = [
    ["get_draw_cycle_contributions_v1", "uuid"],
    ["get_draw_cycle_collateral_v1", "uuid"],
    ["set_draw_cycle_contribution_gate_v1", "uuid, text, text"],
    ["create_draw_cycle_v1", "uuid, text, numeric, integer, integer, timestamptz, text, text"],
    ["open_draw_v1", "uuid, integer, text, text"]
  ];

  it("grants every RPC to authenticated exactly once and revokes it from public and anon", () => {
    for (const [name, signature] of rpcs) {
      const grants = [...code.matchAll(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to authenticated;`, "g"))];
      expect(grants, name).toHaveLength(1);
      expect(grants[0]![1], name).toBe(signature);
      expect(code, name).toContain(`revoke all on function public.${name}(${signature}) from public, anon;`);
    }
  });

  it("the helpers are never granted to a client role", () => {
    for (const helper of ["sened_gate_block_mutation()", "sened_draw_cycle_gate(uuid)", "sened_draw_cycle_member_rounds(uuid, uuid)", "sened_draw_cycle_gate_flags(uuid, integer)"]) {
      expect(code).toContain(`revoke all on function public.${helper} from public, anon, authenticated;`);
      expect(code).not.toMatch(new RegExp(`grant execute on function public\\.${helper.replace(/[()]/g, "\\$&")} to`));
    }
  });

  it("the audit tables have row level security, members read, and no client role can write", () => {
    for (const table of ["draw_cycle_gate_events", "draw_contribution_gate_overrides"]) {
      expect(code).toContain(`alter table public.${table} enable row level security;`);
      expect(code).toContain(`revoke all on table public.${table} from anon, authenticated;`);
      expect(code).toContain(`grant select on table public.${table} to authenticated;`);
      expect(code).toMatch(new RegExp(`create trigger \\w+_block_mutation\\s+before update or delete on public\\.${table}`));
      expect(code).toMatch(new RegExp(`create trigger \\w+_block_truncate\\s+before truncate on public\\.${table}`));
    }
    expect(code).not.toMatch(/grant (insert|update|delete)/i);
    expect(code).toMatch(/sened_ledger_can_access_group\(group_id, tenant_id\)/);
  });

  it("every existing cycle is off: the column defaults to off and is constrained", () => {
    expect(code).toMatch(/add column if not exists contribution_gate text not null default 'off'/);
    expect(code).toMatch(/check \(contribution_gate in \('off', 'warn', 'block'\)\)/);
  });

  it("the migration only touches the cycle policy through the new function: no update of draw_cycles", () => {
    expect(code).not.toMatch(/update\s+public\.draw_cycles/i);
  });
});

describe("the harness covers it", () => {
  it("has the success marker, and the PowerShell wrapper requires it", () => {
    expect(harness).toContain("select 'ALL CONTRIBUTION GRID AND GATE CHECKS PASSED' as result;");
    expect(powershell).toContain("ALL CONTRIBUTION GRID AND GATE CHECKS PASSED");
  });

  it("checks the timeline cases the feature promises", () => {
    for (const label of ["GRID 5", "GRID 10", "GRID 12", "GRID 13", "GRID 14", "GRID 17", "COLLATERAL-GRID 2", "GATE 7", "GATE 10", "GATE 11", "GATE 17", "GATE 20", "GATE 28", "GATE 39"]) {
      expect(harness, label).toContain(`${label} FAILED`);
    }
  });
});
