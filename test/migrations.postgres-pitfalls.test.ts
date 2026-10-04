import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for mistakes that only a real Postgres reports, found by running
 * the app against a real PostgREST/GoTrue stack.
 */
const dir = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));

describe("migration SQL pitfalls", () => {
  it("never uses chr(0): Postgres text cannot hold a NUL (54000 null character not permitted)", () => {
    for (const { name, sql } of migrations) {
      expect(sql, name).not.toMatch(/chr\(\s*0\s*\)/i);
    }
  });

  it("never uses a regex repetition bound above 255: Postgres refuses it at run time (2201B invalid repetition count)", () => {
    // `'^[!-~]{16,256}$'` parses, passes review, and fails only when the function
    // runs. Only a real Postgres notices, so guard the text.
    for (const { name, sql } of migrations) {
      const withoutComments = sql.replace(/--.*$/gm, "");
      for (const match of withoutComments.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
        const bounds = [match[1], match[2]].filter((value) => value !== undefined && value !== "").map(Number);
        for (const bound of bounds) {
          // Only inside a quoted regular expression, not a format string like %L{...}.
          expect(bound, `${name}: {${match[1]}${match[2] !== undefined ? "," + match[2] : ""}}`).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("a plpgsql function that selects a row into a variable named like its table alias opts into #variable_conflict use_column", () => {
    const pattern = /select (\w+)\.\*\s+into \1\s+from [\w.]+ \1\b/gi;
    for (const { name, sql } of migrations) {
      const functions = sql.split(/(?=create or replace function )/i);
      for (const fn of functions) {
        if (!/language plpgsql/i.test(fn) || !new RegExp(pattern.source, "i").test(fn)) {
          continue;
        }
        expect(fn.slice(0, 120), `${name}: ${fn.slice(0, 80)}`).toBeTruthy();
        expect(fn, `${name}: ${fn.split("(")[0]}`).toMatch(/#variable_conflict use_column/);
      }
    }
  });

  it("draw round responses carry the nested commitment object and text amounts parseRound needs", () => {
    const latest = migrations
      .filter(({ sql }) => /create or replace function public\.sened_draw_round_response/i.test(sql))
      .at(-1)!;
    expect(latest.sql).toMatch(/'commitment', jsonb_build_object\(/);
    expect(latest.sql).toMatch(/'memberCommitments'/);
    expect(latest.sql).toMatch(/'memberNonces'/);
    expect(latest.sql).toMatch(/pot_amount::text/);
    expect(latest.sql).toMatch(/payout_amount::text/);
  });
});
