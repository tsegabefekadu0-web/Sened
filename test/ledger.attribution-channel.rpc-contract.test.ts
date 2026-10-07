import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTRIBUTION_CHANNELS, CONTRIBUTION_NOTE_MAX, checkContributionNote, isBlankNote, isContributionChannel } from "@/lib/ledger/paymentChannel";

/**
 * The static half of the channel/note migration's contract; the other half runs the
 * SQL (`scripts/verify-migrations.sql`, "ALL PAYMENT CHANNEL AND NOTE CHECKS PASSED").
 * The server module, the validation schema and the TypeScript rules must agree with
 * the SQL on the channel list, the note rules and every argument name.
 */
const FILE = "20261012100000_attribution_channel_and_note.sql";
const DIR = "supabase/migrations";
const sql = readFileSync(join(process.cwd(), DIR, FILE), "utf8");
const code = sql.replace(/--.*$/gm, "");
const attributionServer = readFileSync(join(process.cwd(), "src/lib/ledger/attribution.ts"), "utf8");
const reader = readFileSync(join(process.cwd(), "src/lib/ledger/reader.ts"), "utf8");

function parameters(name: string): string[] {
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

describe("the migration is new and the earlier ones are untouched", () => {
  it("sorts after the grid and gate migration and only adds a file", () => {
    const files = readdirSync(join(process.cwd(), DIR)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261011100000_contribution_grid_and_gate.sql"));
  });

  it("never touches the hash-chained entry, its postings or the head", () => {
    expect(code).not.toMatch(/alter table public\.ledger_entries/i);
    expect(code).not.toMatch(/alter table public\.ledger_entry_postings/i);
    expect(code).not.toMatch(/(update|delete from|insert into) public\.ledger_(entries|entry_postings|group_heads)\b/i);
    expect(code).not.toMatch(/entry_hash\s*=|previous_hash\s*=/i);
  });

  it("does not rewrite the append-only table: only columns and constraints are added", () => {
    expect(code).toMatch(/alter table public\.ledger_entry_attributions add column if not exists channel text/);
    expect(code).toMatch(/alter table public\.ledger_entry_attributions add column if not exists note text/);
    expect(code).not.toMatch(/update public\.ledger_entry_attributions/i);
    expect(code).not.toMatch(/delete from public\.ledger_entry_attributions/i);
    expect(code).not.toMatch(/drop trigger/i);
    expect(code).not.toMatch(/grant (insert|update|delete|all) on table/i);
  });

  it("does not change sened_effective_attribution, whose return type earlier migrations re-create", () => {
    expect(code).not.toMatch(/function public\.sened_effective_attribution/);
  });
});

describe("channel and note rules agree between SQL and TypeScript", () => {
  it("lists exactly the channels the code lists, in the table constraint and in the RPC", () => {
    const list = CONTRIBUTION_CHANNELS.map((channel) => `'${channel}'`).join(", ");
    expect(code).toContain(`channel in (${list})`);
    expect(body("sened_attribute_entry")).toContain(`not in (${list})`);
    expect([...CONTRIBUTION_CHANNELS]).toEqual(["telebirr", "cbe", "awash", "cash", "other"]);
  });

  it("the first three are the bank providers", () => {
    const providers = ["telebirr", "cbe", "awash"];
    expect(CONTRIBUTION_CHANNELS.slice(0, 3)).toEqual(providers);
    expect(readFileSync(join(process.cwd(), DIR, "20260925120000_bank_verification_reconciliation.sql"), "utf8")).toContain(
      "provider in ('telebirr', 'cbe', 'awash')"
    );
  });

  it("states the same note rule: trimmed, 1..280 characters, no control or invisible formatting characters", () => {
    expect(code).toMatch(/note = btrim\(note\)/);
    expect(code).toMatch(/char_length\(note\) between 1 and 280/);
    expect(CONTRIBUTION_NOTE_MAX).toBe(280);
    const forbidden = "[\\u0001-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]";
    expect(code).toContain(`note !~ '${forbidden}'`);
    expect(body("sened_attribute_entry")).toContain(`in_note ~ '${forbidden}'`);
    // The same set, as a TypeScript test of each end of every range.
    for (const code of [0x01, 0x1f, 0x7f, 0x9f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
      expect(checkContributionNote(`a${String.fromCharCode(code)}b`), code.toString(16)).toEqual({ ok: false, problem: "forbidden-characters" });
    }
    for (const code of [0x20, 0x7e, 0xa0, 0x1220, 0x2010, 0x2065]) {
      expect(checkContributionNote(`a${String.fromCharCode(code)}b`).ok, code.toString(16)).toBe(true);
    }
  });

  it("counts characters, trims, and tells an empty note from a too-long one", () => {
    expect(checkContributionNote("  hi  ")).toEqual({ ok: true, note: "hi" });
    expect(checkContributionNote("   ")).toEqual({ ok: false, problem: "empty" });
    expect(isBlankNote("   ")).toBe(true);
    expect(isBlankNote(" a ")).toBe(false);
    expect(checkContributionNote("ሠ".repeat(280)).ok).toBe(true);
    expect(checkContributionNote("ሠ".repeat(281))).toEqual({ ok: false, problem: "too-long" });
    // An astral character is one character, as in Postgres (char_length counts code points).
    expect(checkContributionNote("\u{1F4B8}".repeat(280)).ok).toBe(true);
    expect(checkContributionNote("\u{1F4B8}".repeat(281)).ok).toBe(false);
  });

  it("recognises exactly the five channels", () => {
    for (const channel of CONTRIBUTION_CHANNELS) expect(isContributionChannel(channel)).toBe(true);
    for (const bad of ["", "CASH", "paypal", "cbe-birr", "bank-transfer", null, undefined, 1]) expect(isContributionChannel(bad)).toBe(false);
  });
});

describe("one signature per RPC, sent by name", () => {
  it("adds exactly two trailing optional parameters and drops the old arities", () => {
    expect(parameters("record_ledger_entry_attribution_v1")).toEqual([
      "p_group_id",
      "p_entry_id",
      "p_member_user_id",
      "p_cycle_id",
      "p_round",
      "p_channel",
      "p_note"
    ]);
    expect(parameters("supersede_ledger_entry_attribution_v1")).toEqual([
      "p_group_id",
      "p_entry_id",
      "p_member_user_id",
      "p_reason",
      "p_cycle_id",
      "p_round",
      "p_channel",
      "p_note"
    ]);
    expect(body("record_ledger_entry_attribution_v1")).toMatch(/p_channel text default null,\s*p_note text default null/);
    expect(body("supersede_ledger_entry_attribution_v1")).toMatch(/p_channel text default null,\s*p_note text default null/);
    for (const old of [
      "record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer)",
      "supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer)",
      "sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text)"
    ]) {
      expect(code).toContain(`drop function if exists public.${old};`);
    }
  });

  it("is sent by the server module with exactly those names, and still names no recorder", () => {
    for (const name of ["p_channel", "p_note"]) {
      expect(attributionServer.match(new RegExp(`${name}:`, "g"))).toHaveLength(2);
    }
    expect(parameters("sened_attribute_entry").join(" ")).not.toMatch(/recorded_by|actor|p_user\b|source/);
  });

  it("is granted to signed-in users only, and the internals to nobody", () => {
    for (const signature of [
      "record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)",
      "supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text)"
    ]) {
      expect(code).toContain(`revoke all on function public.${signature} from public, anon;`);
      expect(code).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    for (const internal of [
      "sened_attribution_channel_note(uuid, uuid, text)",
      "sened_attribution_json(uuid, uuid)",
      "sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text, text, text)"
    ]) {
      expect(code).toContain(`revoke all on function public.${internal} from public, anon, authenticated;`);
    }
  });
});

describe("the write keeps its rules", () => {
  it("still takes the recorder from auth.uid(), gates on the manager role, and refuses a bank-verified entry whatever it carries", () => {
    const write = body("sened_attribute_entry");
    expect(write).toMatch(/actor uuid := auth\.uid\(\)/);
    expect(write).toMatch(/sened_ledger_can_manage_group\(p_group_id, tenant\)/);
    expect(write).toMatch(/attribution_bank_verified/);
    expect(write).toMatch(/intent_row\.state = 'VERIFIED'/);
    // Validation of the channel and note comes before anything is read.
    expect(write.indexOf("in_channel not in")).toBeGreaterThan(-1);
    expect(write.indexOf("in_channel not in")).toBeLessThan(write.indexOf("pg_advisory_xact_lock"));
    expect(write.indexOf("in_note ~")).toBeLessThan(write.indexOf("pg_advisory_xact_lock"));
  });

  it("includes channel and note in the same-values test that decides replay, exists and unchanged", () => {
    const write = body("sened_attribute_entry");
    expect(write).toMatch(/tip_row\.channel is not distinct from new_channel/);
    expect(write).toMatch(/tip_row\.note is not distinct from new_note/);
    // Supersede keeps on null and clears on the empty string.
    expect(write).toMatch(/when in_channel is null then tip_row\.channel else nullif\(in_channel, ''\)/);
    expect(write).toMatch(/when in_note is null then tip_row\.note else nullif\(in_note, ''\)/);
  });

  it("stores them on the new row, and reads the bank's provider as the channel with no note", () => {
    const write = body("sened_attribute_entry");
    expect(write).toMatch(/member_user_id, recorded_by, cycle_id, round, channel, note\)/);
    expect(write).toMatch(/supersedes_id, reason, channel, note\)/);
    const read = body("sened_attribution_channel_note");
    expect(read).toMatch(/intent_row\.provider::text, null::text/);
    expect(read).toMatch(/p_source = 'bank_verification'/);
    expect(read).toMatch(/tip\.channel, tip\.note/);
    expect(read).toMatch(/p_source = 'treasurer'/);
    const json = body("sened_attribution_json");
    expect(json).toContain("'channel', cn.channel");
    expect(json).toContain("'note', cn.note");
  });

  it("is read by the reader with the same keys", () => {
    const parse = reader.slice(reader.indexOf("function parseAttribution"));
    expect(parse).toContain("channel");
    expect(parse).toContain("note");
  });
});
