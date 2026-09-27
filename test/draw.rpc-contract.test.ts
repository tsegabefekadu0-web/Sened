import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The repository and the migration must agree on the RPC's parameters.
 *
 * This is the bug that made the bank migration unappliable, twice over: revoke
 * and grant statements naming a function that did not exist, in a chain where one
 * failure stops every migration after it. It was found by executing the SQL, which
 * is the only way it *can* be found — `scripts/verify-migrations.ps1` needs a
 * Postgres container and this environment has no runnable Docker.
 *
 * So this test does the part that can be checked without a database: it reads the
 * parameter names straight out of the migration and compares them with the keys
 * the TypeScript repository sends. A rename on either side fails here rather than
 * in production.
 *
 * It is a real check, not a proxy: PostgREST matches named arguments, so a
 * parameter that exists in the SQL but is never sent is a silent `null`, and one
 * that is sent but does not exist is an error at call time. Both are exactly what
 * the commit RPC's new refusal is guarding against.
 */

const MIGRATION = "supabase/migrations/20260927130000_draw_member_rpcs.sql";
const REPOSITORY = "src/lib/draw/repository.ts";

/** Parameter names from a `create or replace function public.<name>( ... )` block. */
function sqlParameters(sql: string, functionName: string): string[] {
  const marker = `create or replace function public.${functionName}(`;
  const start = sql.indexOf(marker);
  if (start === -1) {
    throw new Error(`${functionName} is not defined in the migration`);
  }
  const open = start + marker.length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    throw new Error(`could not find the end of ${functionName}'s parameter list`);
  }
  return [...sql.slice(open + 1, close).matchAll(/p_(\w+)\s+\w+/g)].map((match) => match[1]!);
}

/** Keys the repository sends to a named RPC. */
function repositoryKeys(source: string, functionName: string): string[] {
  const marker = `.rpc("${functionName}", {`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`the repository does not call ${functionName}`);
  }
  const open = start + marker.length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  return [...source.slice(open + 1, close).matchAll(/p_(\w+):/g)].map((match) => match[1]!);
}

const migration = readFileSync(join(process.cwd(), MIGRATION), "utf8");
const repository = readFileSync(join(process.cwd(), REPOSITORY), "utf8");

describe("the draw RPCs carry the member contributions", () => {
  it("commit_draw_v1 takes the member digest and the sealed set", () => {
    const parameters = sqlParameters(migration, "commit_draw_v1");

    expect(parameters).toContain("member_digest");
    expect(parameters).toContain("member_commitments");
  });

  it("reveal_draw_v1 takes the member digest and the revealed nonces", () => {
    const parameters = sqlParameters(migration, "reveal_draw_v1");

    expect(parameters).toContain("member_digest");
    expect(parameters).toContain("member_nonces");
  });

  it("drops the old arities, so neither can be called by mistake", () => {
    // `create or replace` with a different argument list creates an overload.
    // Without an explicit drop, the pre-M4.3 thirteen-argument version would
    // still exist and still accept a commitment with no member set.
    expect(migration).toMatch(
      /drop function if exists public\.commit_draw_v1\(\s*uuid, uuid, integer, uuid, text, text, text, jsonb, numeric, integer, integer, text, timestamptz\s*\)/
    );
    expect(migration).toMatch(/drop function if exists public\.reveal_draw_v1\(/);
  });

  it("grants exactly the arities it creates", () => {
    // The defect in the bank migration: a grant naming a function that does not
    // exist, which aborts the whole chain.
    for (const name of ["commit_draw_v1", "reveal_draw_v1"]) {
      const arity = sqlParameters(migration, name).length;
      const created = new RegExp(
        `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\)`,
        "m"
      ).test(migration);
      const granted = [
        ...migration.matchAll(
          new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to authenticated;`, "g")
        )
      ];
      expect(created, `${name} should be created`).toBe(true);
      expect(granted, `${name} should be granted to authenticated`).toHaveLength(1);
      expect(
        granted[0]![1]!.split(",").length,
        `${name} grant arity must match its definition`
      ).toBe(arity);
    }
  });

  it("revokes from anon on both", () => {
    for (const name of ["commit_draw_v1", "reveal_draw_v1"]) {
      expect(
        migration,
        `${name} must not be executable by anon`
      ).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
    }
  });
});

describe("the repository sends what the migration declares", () => {
  it("commit: every declared parameter is sent, and nothing invented", () => {
    const declared = sqlParameters(migration, "commit_draw_v1");
    const sent = repositoryKeys(repository, "commit_draw_v1");

    expect([...sent].sort()).toEqual([...declared].sort());
  });

  it("reveal: every declared parameter is sent, and nothing invented", () => {
    const declared = sqlParameters(migration, "reveal_draw_v1");
    const sent = repositoryKeys(repository, "reveal_draw_v1");

    expect([...sent].sort()).toEqual([...declared].sort());
  });

  it("sends the member set rather than leaving it to a default", () => {
    const commit = repository.slice(
      repository.indexOf('.rpc("commit_draw_v1"'),
      repository.indexOf('.rpc("reveal_draw_v1"')
    );

    // A `null` here would be indistinguishable from a member who sealed nothing.
    expect(commit).toMatch(/p_member_digest: commitment\.memberDigest/);
    expect(commit).toMatch(/p_member_commitments: commitment\.memberCommitments\.map/);
  });

  it("sends every revealed nonce, not just the digest", () => {
    const reveal = repository.slice(repository.indexOf('.rpc("reveal_draw_v1"'));

    expect(reveal).toMatch(/p_member_digest: reveal\.memberDigest/);
    expect(reveal).toMatch(/p_member_nonces: reveal\.memberNonces\.map/);
  });
});

describe("the refusal is in the database too, not only the application", () => {
  it("refuses a commit with no member set before touching any table", () => {
    const body = migration.slice(
      migration.indexOf("create or replace function public.commit_draw_v1("),
      migration.indexOf("create or replace function public.reveal_draw_v1(")
    );

    expect(body).toMatch(/jsonb_array_length\(p_member_commitments\) < 1/);
    expect(body).toMatch(/draw_member_commitment_missing/);
  });

  it("refuses a reveal that opens fewer nonces than were sealed", () => {
    const body = migration.slice(migration.indexOf("create or replace function public.reveal_draw_v1("));

    expect(body).toMatch(
      /jsonb_array_length\(p_member_nonces\) <> jsonb_array_length\(commitment_row\.member_commitments\)/
    );
  });

  it("refuses a retry that swaps the contributing members", () => {
    // Otherwise the same idempotency key could silently produce a different
    // ceremony on the second attempt.
    expect(migration).toMatch(
      /existing_row\.member_digest is distinct from p_member_digest[\s\S]{0,120}draw_idempotency_conflict/
    );
  });
});

describe("the harness exercises the new arities", () => {
  const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");

  it("checks that the RPCs refuse an empty member set", () => {
    expect(harness).toMatch(/RPC 1 FAILED: commit_draw_v1 ACCEPTED an empty member set/);
    expect(harness).toMatch(/RPC 4 FAILED: reveal_draw_v1 ACCEPTED an empty nonce set/);
  });

  it("checks the arity and the grants, which is how the bank migration failed", () => {
    expect(harness).toMatch(/pg_proc\.proname = 'commit_draw_v1'\s*\n\s*and pg_proc\.pronargs <> 15/);
    expect(harness).toMatch(/has_function_privilege\(\s*'authenticated'/);
    expect(harness).toMatch(/anon can execute commit_draw_v1/);
  });
});

// Referenced so the unused-import guard does not fire; the mock keeps the
// Supabase client from being constructed for a source-text test.
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
