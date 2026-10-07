import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source-level contract of `20261013100000_post_win_fill_and_commit_gate.sql`: the post-win fill
 * rule, the gate re-checked at commit, the arities PostgREST will see, who can call what. The
 * behaviour itself (the grid under the new rule, stability on a timeline, the commit refusals and
 * the override records) is proven by running the migration chain: `scripts/verify-migrations.sql`.
 *
 * Deliberately NOT asserted: that this is the last migration. A newer one may follow; where the
 * repository must agree with "the live definition" the test reads the last file that defines it.
 */

const DIR = "supabase/migrations";
const FILE = "20261013100000_post_win_fill_and_commit_gate.sql";
const sql = readFileSync(join(process.cwd(), DIR, FILE), "utf8");
const code = sql.replace(/--.*$/gm, "");
const repository = readFileSync(join(process.cwd(), "src/lib/draw/repository.ts"), "utf8");
const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");
const powershell = readFileSync(join(process.cwd(), "scripts/verify-migrations.ps1"), "utf8");

function allFiles(): string[] {
  return readdirSync(join(process.cwd(), DIR)).filter((name) => name.endsWith(".sql")).sort();
}

/** The text of the last migration (in apply order) that defines `name`. */
function liveDefinition(name: string): string {
  let live: string | null = null;
  for (const file of allFiles()) {
    const text = readFileSync(join(process.cwd(), DIR, file), "utf8").replace(/--.*$/gm, "");
    if (text.includes(`create or replace function public.${name}(`)) live = text;
  }
  if (live === null) throw new Error(`no migration defines ${name}`);
  return live;
}

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`${name} is not defined`);
  const next = source.indexOf("create or replace function public.", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}
const body = (name: string): string => bodyOf(code, name);

function parameters(source: string, name: string): string[] {
  const text = bodyOf(source, name);
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

describe("a new file after the ones it builds on, none edited", () => {
  it("sorts after the grid and gate migration and the attribution channel migration", () => {
    const files = allFiles();
    expect(files).toContain(FILE);
    for (const earlier of ["20261011100000_contribution_grid_and_gate.sql", "20261012100000_attribution_channel_and_note.sql"]) {
      expect(files.indexOf(earlier), earlier).toBeGreaterThan(-1);
      expect(files.indexOf(earlier), earlier).toBeLessThan(files.indexOf(FILE));
    }
    // It does not alter anything in the released files: it only re-creates functions and adds a column.
    expect(code).not.toMatch(/update\s+public\.draw_/i);
    expect(code).not.toMatch(/delete\s+from\s+public\./i);
  });

  it("never writes the ledger", () => {
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.ledger_/i);
    expect(code).not.toMatch(/post_ledger_entry_v1/);
  });
});

describe("the post-win fill rule", () => {
  const derivation = body("sened_draw_cycle_member_rounds");

  it("keeps the signature and the output columns of the derivation (the RPC shapes do not change)", () => {
    expect(code).toMatch(/create or replace function public\.sened_draw_cycle_member_rounds\(p_cycle_id uuid, p_member_id uuid default null\)/);
    expect(derivation).toMatch(/member_id uuid,\s+is_active boolean,\s+win_round integer,\s+round_no integer,\s+cell_status text,\s+due_at timestamptz,\s+entry_id uuid,\s+source text/);
    // The collateral and grid RPCs are not redefined for the rule: they read the derivation.
    expect(code).not.toMatch(/create or replace function public\.get_draw_cycle_collateral_v1/);
  });

  it("explicit cycle+round attributions claim their round before anything is placed by order", () => {
    expect(derivation.indexOf("if e_round[i] = r then")).toBeGreaterThan(-1);
    expect(derivation.indexOf("if e_round[i] = r then")).toBeLessThan(derivation.indexOf("continue when e_round[i] is not null"));
    expect(derivation).toMatch(/continue when e_round\[i\] is not null/);
  });

  it("places the remaining entries one at a time in recorded order, one entry one round", () => {
    expect(derivation).toMatch(/order by c\.recorded_at, c\.entry_id/);
    expect(derivation).toMatch(/claimed\[pick\] := i/);
    expect(derivation).not.toMatch(/used_idx/);
  });

  it("a post-win entry: (1) an unmet post-win round that was open BEFORE the entry, (2) the earliest unmet round up to the win, (3) the prepayment", () => {
    const post = derivation.slice(derivation.indexOf("if post_win then"), derivation.indexOf("top_round :="));
    const loops = [...post.matchAll(/for r in ([^\n]+) loop/g)].map((match) => match[1]);
    // Comments are stripped from `code`, so the steps are told apart by their loops: after the win, up to the win, after the win.
    expect(loops).toEqual(["(win_no + 1) .. cyc.total_rounds", "1 .. win_no", "(win_no + 1) .. cyc.total_rounds"]);
    const [stepOne, stepTwo, stepThree] = post.split(/for r in /).slice(1);
    // Step 1 is reachable (the previous round was revealed before the entry) and was open before the entry.
    expect(stepOne).toMatch(/due_arr\[r\] is not null and due_arr\[r\] < e_at\[i\]/);
    expect(stepOne).toMatch(/reveal_arr\[r - 1\] is not null and reveal_arr\[r - 1\] < e_at\[i\]/);
    // Step 2 only looks at rounds up to the win, which were all open and revealed before it.
    expect(stepTwo).toMatch(/\(r = 1 or \(reveal_arr\[r - 1\] is not null and reveal_arr\[r - 1\] < e_at\[i\]\)\)/);
    expect(stepTwo).not.toMatch(/due_arr\[r\] < e_at\[i\]/);
    // Step 3 reads "open NOW", not "open before the entry": it is only the next round once it opens.
    expect(stepThree).toMatch(/due_arr\[r\] is not null/);
    expect(stepThree).not.toMatch(/due_arr\[r\] < e_at\[i\]/);
    // Each step is tried only when the one before found nothing.
    expect(post.match(/if pick is null then/g)).toHaveLength(2);
  });

  it("the choice between step 1 and step 2 is made on the state AT THE ENTRY'S TIME, so opening a later round cannot move a placed payment", () => {
    // Step 1 is the only place a round's open time is compared with the entry's time, and it is strict: an entry
    // recorded while a round was not yet open can never be placed on it by step 1, only by the prepayment (step 3).
    expect([...derivation.matchAll(/due_arr\[r\] < e_at\[i\]/g)]).toHaveLength(1);
  });

  it("a pre-win entry or a non-winner keeps the previous rule: earliest unmet, reachable, open round; a winner's earlier entries only up to the win", () => {
    const rest = derivation.slice(derivation.indexOf("top_round :="));
    expect(rest).toMatch(/top_round := case when win_no is null then cyc\.total_rounds else win_no end/);
    expect(rest).toMatch(/due_arr\[r\] is not null/);
    expect(rest).toMatch(/reveal_arr\[r - 1\] < e_at\[i\]/);
    expect(derivation).toMatch(/post_win := win_no is not null and e_at\[i\] > win_rev/);
  });

  it("stores nothing: the derivation is read-only", () => {
    expect(derivation).not.toMatch(/\binsert\s+into\b/i);
    expect(derivation).toMatch(/\bstable\b/);
  });
});

describe("the commit function", () => {
  const live = liveDefinition("commit_draw_from_seals_v1");
  const commit = body("commit_draw_from_seals_v1");

  it("gains exactly one trailing optional parameter and the repository sends every declared parameter by name", () => {
    expect(parameters(code, "commit_draw_from_seals_v1")).toEqual([
      "draw_id", "commitment", "commitment_nonce", "roster_digest", "member_digest", "participants",
      "idempotency_key", "occurred_at", "protocol_version", "override_reason"
    ]);
    expect(commit).toMatch(/p_override_reason text default null/);
    // The live definition is the last one in apply order, whatever file that is.
    expect(parameters(live, "commit_draw_from_seals_v1")).toContain("override_reason");
    expect(rpcKeys(repository, "commit_draw_from_seals_v1").sort()).toEqual([...parameters(live, "commit_draw_from_seals_v1")].sort());
  });

  it("drops the nine-argument signature first, so PostgREST has one function of the name to choose", () => {
    const drop = code.indexOf("drop function if exists public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text);");
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(code.indexOf("create or replace function public.commit_draw_from_seals_v1("));
    expect(code).toContain("revoke all on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text) from public, anon;");
    const grants = [...code.matchAll(/grant execute on function public\.commit_draw_from_seals_v1\(([^)]*)\) to authenticated;/g)];
    expect(grants).toHaveLength(1);
    expect(grants[0]![1]).toBe("uuid, text, text, text, text, jsonb, text, timestamptz, text, text");
  });

  it("identity is auth.uid(): nothing names who is overriding", () => {
    expect(parameters(code, "commit_draw_from_seals_v1").some((parameter) => /actor|user|member_id/.test(parameter))).toBe(false);
    expect(commit).toMatch(/actor uuid := auth\.uid\(\)/);
    expect(commit).toMatch(/sess\.cycle_id, sess\.group_id, sess\.tenant_id, sess\.round, p_draw_id, actor, clean_override, flagged, 'commit'/);
  });

  it("order: role first, then the reason, then a replay, then the gate, then the insert, then the override record", () => {
    const role = commit.indexOf("sened_ledger_can_manage_group(sess.group_id, sess.tenant_id)");
    const reason = commit.indexOf("draw_override_reason_invalid");
    const replay = commit.indexOf("'replayed', true");
    const quorum = commit.indexOf("draw_member_commitment_mismatch");
    const gate = commit.indexOf("sened_draw_cycle_gate_flags(sess.cycle_id, sess.round)");
    const insert = commit.indexOf("insert into public.draw_commitments");
    const record = commit.indexOf("insert into public.draw_contribution_gate_overrides");
    for (const position of [role, reason, replay, quorum, gate, insert, record]) expect(position).toBeGreaterThan(-1);
    expect(role).toBeLessThan(reason);
    expect(reason).toBeLessThan(replay);
    expect(replay).toBeLessThan(quorum);
    expect(quorum).toBeLessThan(gate);
    expect(gate).toBeLessThan(insert);
    expect(insert).toBeLessThan(record);
  });

  it("reads the EFFECTIVE policy now, serialised with policy changes, and only looks when it is not off", () => {
    expect(commit).toMatch(/perform 1 from public\.draw_cycles locked where locked\.id = sess\.cycle_id for share/);
    expect(commit).toMatch(/gate_policy := public\.sened_draw_cycle_gate\(sess\.cycle_id\)/);
    expect(commit).toMatch(/if gate_policy <> 'off' then/);
    expect(commit).toMatch(/gate_policy = 'block' and jsonb_array_length\(flagged\) > 0/);
  });

  it("an override given at open stands for the pairs it named, otherwise the refusal carries them and a reason is recorded with stage commit", () => {
    expect(commit).toMatch(/acknowledged := public\.sened_draw_open_override_flags\(p_draw_id\)/);
    expect(commit).toMatch(/if public\.sened_draw_flags_covered\(flagged, acknowledged\) then\s+carried_over := true/);
    expect(commit).toMatch(/message = 'draw_contribution_gate_blocked',\s+detail = flagged::text/);
    expect(commit).toMatch(/errcode = 'P0001'/);
    expect(commit).toMatch(/char_length\(clean_override\) not between 10 and 1000/);
    expect(commit).toMatch(/'contributionGate', jsonb_build_object\(\s+'policy', gate_policy,\s+'flagged', flagged,\s+'overridden', overridden,\s+'carriedOver', carried_over/);
  });

  it("the sealed set is still whatever is stored: the commit gained no argument that could change it", () => {
    expect(commit).toMatch(/from public\.draw_seals se/);
    expect(commit).toMatch(/cyc\.pot_amount, cyc\.total_rounds, cyc\.reserve_ratio_bps/);
    for (const forbidden of ["member_commitments", "pot_amount", "total_rounds", "reserve_ratio_bps", "group_id", "cycle_id"]) {
      expect(parameters(code, "commit_draw_from_seals_v1")).not.toContain(forbidden);
    }
  });
});

describe("the overrides table: one stage per override", () => {
  it("adds a constrained stage column defaulting to open, and makes (draw, stage) unique instead of draw alone", () => {
    expect(code).toMatch(/add column if not exists stage text not null default 'open'/);
    expect(code).toMatch(/check \(stage in \('open', 'commit'\)\)/);
    expect(code).toMatch(/drop constraint if exists draw_contribution_gate_overrides_draw_id_key/);
    expect(code).toMatch(/create unique index if not exists draw_gate_overrides_draw_stage_idx\s+on public\.draw_contribution_gate_overrides \(draw_id, stage\)/);
    // No new table, and no policy or trigger duplicated: the existing ones cover the new column.
    expect(code).not.toMatch(/create table/);
  });

  it("the grid read reports each override's stage and is otherwise the same function", () => {
    const read = body("get_draw_cycle_contributions_v1");
    expect(read).toMatch(/'stage', ov\.stage/);
    expect(read).toMatch(/auth\.uid\(\)/);
    expect(read).toMatch(/sened_ledger_can_access_group\(cyc\.group_id, tenant\)/);
    expect(code).toContain("revoke all on function public.get_draw_cycle_contributions_v1(uuid) from public, anon;");
    expect(code).toContain("grant execute on function public.get_draw_cycle_contributions_v1(uuid) to authenticated;");
  });

  it("the helpers are never granted to a client role", () => {
    for (const helper of ["sened_draw_open_override_flags(uuid)", "sened_draw_flags_covered(jsonb, jsonb)", "sened_draw_cycle_member_rounds(uuid, uuid)"]) {
      expect(code).toContain(`revoke all on function public.${helper} from public, anon, authenticated;`);
      expect(code).not.toMatch(new RegExp(`grant execute on function public\\.${helper.replace(/[()]/g, "\\$&")} to`));
    }
  });
});

describe("the harness covers it", () => {
  it("has the success marker, and the PowerShell wrapper requires it", () => {
    expect(harness).toContain("select 'ALL POST-WIN FILL AND COMMIT GATE CHECKS PASSED' as result;");
    expect(powershell).toContain("ALL POST-WIN FILL AND COMMIT GATE CHECKS PASSED");
  });

  it("checks the timeline cases the feature promises", () => {
    for (const label of [
      "FILL 1", "FILL 2", "FILL 3", "FILL 4", "FILL 5", "FILL 7", "FILL 8", "FILL 9", "FILL 10",
      "GRID 17", "GRID 20", "COLLATERAL-GRID 2",
      "COMMIT-GATE 1", "COMMIT-GATE 3", "COMMIT-GATE 5", "COMMIT-GATE 6", "COMMIT-GATE 7", "COMMIT-GATE 8", "COMMIT-GATE 10", "COMMIT-GATE 11",
      "COMMIT-GATE 12", "COMMIT-GATE 13", "COMMIT-GATE 14", "COMMIT-GATE 15", "COMMIT-GATE 16", "COMMIT-GATE 17", "COMMIT-GATE 18", "COMMIT-GATE 19",
      "COMMIT-GATE 21", "COMMIT-GATE 22", "COMMIT-GATE 23"
    ]) {
      expect(harness, label).toContain(`${label} FAILED`);
    }
  });

  it("proves stability on a timeline and compares the collateral output with the verbatim old derivation", () => {
    expect(harness).toContain("create or replace function pg_temp.fill_stable");
    expect(harness).toContain("create or replace function pg_temp.fill_owed_diff");
    expect(harness).toContain("pg_temp.legacy_owed(");
  });
});
