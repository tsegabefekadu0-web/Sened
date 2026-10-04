import { readdirSync, readFileSync } from "node:fs";
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
/** Protocol v3 reissued commit_draw_v1 with a sixteenth argument. */
const V3_MIGRATION = "supabase/migrations/20261004100000_draw_protocol_v3.sql";
const MIGRATION_DIR = "supabase/migrations";
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

const original = readFileSync(join(process.cwd(), MIGRATION), "utf8");
const v3 = readFileSync(join(process.cwd(), V3_MIGRATION), "utf8");

/**
 * The migration whose definition of `name` is the one that is live: the last file,
 * in apply order, that creates it. Reading the original file instead would let
 * the repository drift from the function the database actually has, which is the
 * exact failure this test exists to catch.
 */
function liveDefinition(name: string): string {
  const files = readdirSync(join(process.cwd(), MIGRATION_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  let live: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(process.cwd(), MIGRATION_DIR, file), "utf8");
    if (sql.includes(`create or replace function public.${name}(`)) live = sql;
  }
  if (live === null) throw new Error(`no migration defines ${name}`);
  return live;
}

const migration = original;
const commitSql = liveDefinition("commit_draw_v1");
const revealSql = liveDefinition("reveal_draw_v1");
const sqlOf = (name: string): string => (name === "commit_draw_v1" ? commitSql : revealSql);
const repository = readFileSync(join(process.cwd(), REPOSITORY), "utf8");

describe("the draw RPCs carry the member contributions", () => {
  it("commit_draw_v1 takes the member digest and the sealed set", () => {
    const parameters = sqlParameters(commitSql, "commit_draw_v1");

    expect(parameters).toContain("member_digest");
    expect(parameters).toContain("member_commitments");
  });

  it("reveal_draw_v1 takes the member digest and the revealed nonces", () => {
    const parameters = sqlParameters(revealSql, "reveal_draw_v1");

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
    // Protocol v3 added a sixteenth argument; the fifteen-argument arity, which
    // would still accept a v2 commitment, is dropped in that same file.
    expect(v3).toMatch(
      /drop function if exists public\.commit_draw_v1\(\s*uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz\s*\)/
    );
  });

  it("grants exactly the arities it creates", () => {
    // The defect in the bank migration: a grant naming a function that does not
    // exist, which aborts the whole chain.
    for (const name of ["commit_draw_v1", "reveal_draw_v1"]) {
      const sql = sqlOf(name);
      const arity = sqlParameters(sql, name).length;
      const created = new RegExp(
        `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\)`,
        "m"
      ).test(sql);
      const granted = [
        ...sql.matchAll(
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
        sqlOf(name),
        `${name} must not be executable by anon`
      ).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
    }
  });
});

describe("the repository sends what the migration declares", () => {
  it("commit: goes through commit_draw_from_seals_v1, every declared parameter sent and nothing invented", () => {
    const sql = liveDefinition("commit_draw_from_seals_v1");
    const declared = sqlParameters(sql, "commit_draw_from_seals_v1");
    const sent = repositoryKeys(repository, "commit_draw_from_seals_v1");

    expect([...sent].sort()).toEqual([...declared].sort());
    // The repository no longer calls the client-seals commit at all.
    expect(repository).not.toMatch(/\.rpc\("commit_draw_v1"/);
  });

  it("reveal: every declared parameter is sent, and nothing invented", () => {
    const declared = sqlParameters(revealSql, "reveal_draw_v1");
    const sent = repositoryKeys(repository, "reveal_draw_v1");

    expect([...sent].sort()).toEqual([...declared].sort());
  });

  it("sends the member digest it computed, and NO sealed set, roster terms or group (the database holds those)", () => {
    const commit = repository.slice(
      repository.indexOf('.rpc("commit_draw_from_seals_v1"'),
      repository.indexOf("async saveReveal")
    );

    expect(commit).toMatch(/p_member_digest: commitment\.memberDigest/);
    for (const forbidden of ["p_member_commitments", "p_pot_amount", "p_total_rounds", "p_reserve_ratio_bps", "p_group_id", "p_cycle_id", "p_round:"]) {
      expect(commit, `${forbidden} must not be a client input`).not.toContain(forbidden);
    }
  });

  it("sends every revealed nonce, not just the digest, to be bound to the stored ones", () => {
    const reveal = repository.slice(repository.indexOf('.rpc("reveal_draw_v1"'), repository.indexOf("async savePayout"));

    expect(reveal).toMatch(/p_member_digest: reveal\.memberDigest/);
    expect(reveal).toMatch(/p_member_nonces: reveal\.memberNonces\.map/);
  });
});

describe("the refusal is in the database too, not only the application", () => {
  it("refuses a commit with no member set before touching any table", () => {
    const body = commitSql.slice(
      commitSql.indexOf("create or replace function public.commit_draw_v1("),
      commitSql.indexOf("create or replace function public.reveal_draw_v1(")
    );

    expect(body).toMatch(/jsonb_array_length\(p_member_commitments\) < 1/);
    expect(body).toMatch(/draw_member_commitment_missing/);
  });

  it("refuses a reveal that opens fewer nonces than were sealed", () => {
    const body = revealSql.slice(revealSql.indexOf("create or replace function public.reveal_draw_v1("));

    expect(body).toMatch(
      /jsonb_array_length\(p_member_nonces\) <> jsonb_array_length\(commitment_row\.member_commitments\)/
    );
  });

  it("refuses a retry that swaps the contributing members", () => {
    // Otherwise the same idempotency key could silently produce a different
    // ceremony on the second attempt.
    expect(commitSql).toMatch(
      /existing_row\.member_digest is distinct from p_member_digest[\s\S]{0,120}draw_idempotency_conflict/
    );
  });
});

describe("protocol v3 is pinned in the database, not only in the application", () => {
  it("adds an immutable-by-construction protocol_version, backfilling existing rows as v2", () => {
    // Added with default 'v2' (so every historical row is v2), then the default
    // moves to 'v3'. The table is append-only, so the value cannot change later.
    expect(v3).toMatch(/add column if not exists protocol_version text not null default 'v2'/);
    expect(v3).toMatch(/alter column protocol_version set default 'v3'/);
    expect(v3).toMatch(/check \(protocol_version in \('v2', 'v3'\)\)/);
  });

  it("commit_draw_v1 refuses anything but v3, so a direct RPC call cannot open a grindable draw", () => {
    const body = commitSql.slice(
      commitSql.indexOf("create or replace function public.commit_draw_v1("),
      commitSql.indexOf("create or replace function public.reveal_draw_v1(")
    );

    expect(sqlParameters(commitSql, "commit_draw_v1")).toContain("protocol_version");
    expect(body).toMatch(/p_protocol_version is distinct from 'v3'[\s\S]{0,160}draw_protocol_version_unsupported/);
    expect(body).toMatch(/protocol_version\s*\n\s*\) values/);
  });

  it("publishes the version in the round response, which the verifier dispatches on", () => {
    const response = liveDefinition("sened_draw_round_response");
    expect(response).toMatch(/'protocolVersion', commitment_row\.protocol_version/);
  });

  it("repository sends the version the engine committed under, rather than a constant", () => {
    expect(repository).toMatch(/p_protocol_version: commitment\.protocolVersion/);
  });

  it("a v3 reveal must open exactly the sealed set of members", () => {
    expect(revealSql).toMatch(/commitment_row\.protocol_version = 'v3'/);
    expect(revealSql).toMatch(/count\(distinct opened\.entry ->> 'memberId'\)/);
  });
});

describe("the harness exercises the new arities", () => {
  const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");

  it("checks that the RPCs refuse an empty member set", () => {
    expect(harness).toMatch(/RPC 1 FAILED: commit_draw_v1 ACCEPTED an empty member set/);
    expect(harness).toMatch(/RPC 4 FAILED: reveal_draw_v1 ACCEPTED an empty nonce set/);
  });

  it("checks protocol v3 end to end against a real Postgres", () => {
    for (const check of ["PROTO 1", "PROTO 3", "PROTO 4", "PROTO 6", "PROTO 7", "PROTO 8"]) {
      expect(harness, `${check} should be in the harness`).toContain(`${check} FAILED`);
    }
  });

  it("checks the arity and the grants, which is how the bank migration failed", () => {
    expect(harness).toMatch(/pg_proc\.proname = 'commit_draw_v1'\s*\n\s*and pg_proc\.pronargs <> 16/);
    expect(harness).toMatch(/has_function_privilege\(\s*'authenticated'/);
    expect(harness).toMatch(/anon can execute commit_draw_v1/);
  });
});

// Referenced so the unused-import guard does not fire; the mock keeps the
// Supabase client from being constructed for a source-text test.
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));


// ---------------------------------------------------------------------------
// Cycles, server-created draws, stored seals and nonces
// ---------------------------------------------------------------------------

const NEW_MIGRATION = "supabase/migrations/20261005100000_draw_cycles_and_member_seals.sql";
const sessions = readFileSync(join(process.cwd(), NEW_MIGRATION), "utf8");

/** Repository method -> the RPC it calls, for every RPC this migration added. */
const NEW_RPCS = [
  "create_draw_cycle_v1",
  "list_draw_cycles_v1",
  "get_draw_cycle_v1",
  "open_draw_v1",
  "get_draw_session_v1",
  "submit_draw_seal_v1",
  "submit_draw_nonce_v1",
  "commit_draw_from_seals_v1",
  "open_draw_reveal_v1"
] as const;

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`${name} is not defined`);
  const next = sql.indexOf("create or replace function public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("the new RPCs and the repository agree on every parameter", () => {
  for (const name of NEW_RPCS) {
    it(`${name}: declared parameters are exactly the ones sent`, () => {
      const declared = sqlParameters(liveDefinition(name), name);
      const sent = repositoryKeys(repository, name);
      expect([...sent].sort()).toEqual([...declared].sort());
    });
  }

  it("grants every new RPC to authenticated exactly once, and revokes it from anon", () => {
    for (const name of NEW_RPCS) {
      const arity = sqlParameters(sessions, name).length;
      const granted = [
        ...sessions.matchAll(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to authenticated;`, "g"))
      ];
      expect(granted, `${name} grant`).toHaveLength(1);
      expect(granted[0]![1]!.split(",").length, `${name} grant arity`).toBe(arity);
      expect(sessions).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
    }
  });
});

describe("identity comes from auth.uid(), never from the request", () => {
  it("no seal or nonce function takes a member id, and neither does the repository send one", () => {
    for (const name of ["submit_draw_seal_v1", "submit_draw_nonce_v1"]) {
      expect(sqlParameters(sessions, name), name).not.toContain("member_id");
      expect(sqlParameters(sessions, name).some((parameter) => parameter.includes("member")), name).toBe(false);
      expect(repositoryKeys(repository, name).some((key) => key.includes("member")), name).toBe(false);
      expect(functionBody(sessions, name)).toMatch(/actor uuid := auth\.uid\(\)/);
    }
    // The member written is the caller.
    expect(functionBody(sessions, "submit_draw_seal_v1")).toMatch(/values \(p_draw_id, actor, p_sealed\)/);
    expect(functionBody(sessions, "submit_draw_nonce_v1")).toMatch(/values \(p_draw_id, actor, p_nonce\)/);
  });

  it("the commit takes no sealed set, roster terms or group from the caller", () => {
    const parameters = sqlParameters(sessions, "commit_draw_from_seals_v1");
    for (const forbidden of ["member_commitments", "pot_amount", "total_rounds", "reserve_ratio_bps", "group_id", "cycle_id", "round"]) {
      expect(parameters, forbidden).not.toContain(forbidden);
    }
    const body = functionBody(sessions, "commit_draw_from_seals_v1");
    expect(body).toMatch(/from public\.draw_seals se/);
    expect(body).toMatch(/cyc\.pot_amount, cyc\.total_rounds, cyc\.reserve_ratio_bps/);
  });

  it("takes the client-seals commit away from clients", () => {
    expect(sessions).toMatch(
      /revoke all on function public\.commit_draw_v1\(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text\) from public, anon, authenticated;/
    );
  });
});

describe("a stored nonce cannot be read before the reveal is requested", () => {
  it("draw_nonces has row level security, no policy, and no client privilege", () => {
    expect(sessions).toMatch(/alter table public\.draw_nonces enable row level security;/);
    expect(sessions).not.toMatch(/create policy[^;]*on\s+public\.draw_nonces/);
    expect(sessions).toMatch(/revoke all on table public\.draw_nonces from anon, authenticated;/);
    expect(sessions).not.toMatch(/grant [a-z, ]+ on table public\.draw_nonces/);
  });

  it("only open_draw_reveal_v1 selects a nonce, and only after the seed matches the commitment", () => {
    const withoutComments = sessions.replace(/--.*$/gm, "");
    const selectsNonce = withoutComments
      .split("create or replace function public.")
      .slice(1)
      .filter((body) => /\bn\.nonce\b/.test(body))
      .map((body) => body.slice(0, body.indexOf("(")));
    expect(selectsNonce).toEqual(["open_draw_reveal_v1"]);

    const view = functionBody(sessions, "sened_draw_session_view");
    expect(view).not.toMatch(/'nonce'/);
    const open = functionBody(sessions, "open_draw_reveal_v1");
    expect(open.indexOf("sened_draw_commit_hash_v3(")).toBeGreaterThan(-1);
    expect(open.indexOf("sened_draw_commit_hash_v3(")).toBeLessThan(open.indexOf("from public.draw_nonces n"));
    expect(open).toMatch(/draw_commitment_mismatch/);
    expect(open).toMatch(/sened_ledger_can_manage_group\(sess\.group_id, sess\.tenant_id\)/);
  });

  it("the session and listing projections and the repository never pass a nonce along", () => {
    for (const name of ["sened_draw_session_view", "get_draw_cycle_v1"]) {
      expect(functionBody(sessions, name), name).not.toMatch(/'nonce'\s*,/);
    }
    // The repository copies two fields of the nonce result (who, replayed), not the nonce.
    const submit = repository.slice(repository.indexOf("async submitNonce"), repository.indexOf("async requestReveal"));
    expect(submit).toMatch(/return \{ memberId: row\.memberId, replayed: row\.replayed \}/);
    expect(submit).not.toMatch(/row\.nonce/);
  });

  it("reveal_draw_v1 binds a session-backed reveal to the published opening", () => {
    const reveal = functionBody(sessions, "reveal_draw_v1");
    expect(reveal).toMatch(/from public\.draw_sessions s where s\.draw_id = p_draw_id/);
    expect(reveal).toMatch(/opening_row\.seed <> p_seed/);
    expect(reveal).toMatch(/stored\.entry ->> 'nonce' = supplied\.entry ->> 'nonce'/);
  });
});

describe("the harness exercises the new behaviour against a real Postgres", () => {
  const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");

  it("covers role refusal, isolation, self-only seals and nonces, early nonces, secrecy and transitions", () => {
    for (const check of [
      "CYCLE 3", "CYCLE 4", "CYCLE 5", "STATE 1", "STATE 3", "STATE 4", "STATE 5",
      "SEAL 2", "SEAL 3", "SEAL 4", "SEAL 5", "COMMIT 1", "COMMIT 2", "COMMIT 3",
      "NONCE 1", "NONCE 2", "NONCE 3", "REVEAL 1", "REVEAL 2", "REVEAL 3", "REVEAL 4",
      "ROTATION", "ISOLATION", "IMMUTABLE", "SOLO", "PARITY 1", "PARITY 3", "GRANTS"
    ]) {
      expect(harness, `${check} should be in the harness`).toMatch(new RegExp(`${check}\\b`));
    }
    expect(harness).toContain("ALL DRAW CYCLE AND SEAL CHECKS PASSED");
  });
});
