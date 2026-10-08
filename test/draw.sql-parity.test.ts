import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeCommitment,
  computeMemberCommitment,
  computeMemberDigest,
  computeNonceDigest,
  computeTranscriptDigest,
  deriveTicket,
  selectWinnerIndex
} from "@/lib/draw/canonical";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { reserveByRatioMinor } from "@/lib/draw/risk";

/**
 * The database verifies a seed against the commitment and a nonce against its seal, AND DERIVES THE
 * WINNER (20261014100000_draw_integrity.sql), so the plain length-prefixed hashes and the rejection
 * sampler are reimplemented in plpgsql. If either side changed its canonical encoding by a byte,
 * honest reveals would be refused in production, or worse, the two sides would pick different winners.
 *
 * Both sides are pinned to the same literals: this test computes them with the real TypeScript engine
 * and asserts their VALUES; `scripts/verify-migrations.sql` asserts the very same strings against the
 * SQL functions in a real Postgres (PARITY 1-9) and this test checks the harness still carries them.
 * A drift fails one of the two.
 */

const drawId = "dddddddd-0000-4000-8000-0000000000d1";
const groupId = "aaaaaaaa-0000-4000-8000-000000000001";
const cycleId = "aaaaaaaa-0000-4000-8000-0000000000c1";
const memberA = "44444444-4444-4444-8444-444444444444";
const memberB = "22222222-2222-4222-8222-222222222222";
const nonceA = "nonce-one-0123456789-abcdef";
const nonceB = "nonce-two-0123456789-abcdef";
const seed = "seed-value-0123456789-xyz";

const VECTORS = {
  sealA: "8cfcb97d951fb4cea06db44c7fe86b4f273689a95eaf65732d83aa5288a5b3cb",
  sealB: "c9e33496edfcb517ab3e593fcef93050c92adfb99a09650e1e5a4582dbd5e7af",
  memberDigest: "339c57dc558400ed5953ada9573a443af7a518f00bf770c49f4b8edc7091cf69",
  commitment: "ce2934b0af978095526e317c3d13b37072517f55c1e827324ac4efb7c6a9f7bb",
  ticket: "acefb395ef8dcf1dee8a4830e74686ffd5318cddac32a121fca7e30ca837d518",
  nonceDigest: "c92f4106697684fc08046f4287e3540375c212eb540c42169ccc29d300833103",
  transcript: "5f5d648074655f62841bfb4681f6262071df3337dcc49dc110344d0b9a2108c1",
  selectionAttempt0: "1ee94a7542ec48ff966542df6c5483b8bc302fdd7acc3468634adc801a08a56a"
} as const;

const rosterDigest = "ab".repeat(32);

describe("TypeScript engine == SQL hashes (golden vectors)", () => {
  it("member seal", async () => {
    expect(await computeMemberCommitment({ drawId, memberId: memberA, nonce: nonceA }, nodeDrawHasher)).toBe(VECTORS.sealA);
    expect(await computeMemberCommitment({ drawId, memberId: memberB, nonce: nonceB }, nodeDrawHasher)).toBe(VECTORS.sealB);
  });

  it("member set digest, independent of the order the seals arrive in", async () => {
    const ordered = [
      { memberId: memberA, sealed: VECTORS.sealA },
      { memberId: memberB, sealed: VECTORS.sealB }
    ];
    expect(await computeMemberDigest({ drawId, contributions: ordered }, nodeDrawHasher)).toBe(VECTORS.memberDigest);
    expect(await computeMemberDigest({ drawId, contributions: [...ordered].reverse() }, nodeDrawHasher)).toBe(VECTORS.memberDigest);
  });

  it("commitment v3", async () => {
    expect(
      await computeCommitment(
        {
          groupId,
          cycleId,
          round: 2,
          drawId,
          rosterDigest,
          commitmentNonce: "commit-nonce-0123456789",
          memberDigest: VECTORS.memberDigest,
          seed
        },
        "v3",
        nodeDrawHasher
      )
    ).toBe(VECTORS.commitment);
  });

  it("ticket", async () => {
    expect(await deriveTicket({ groupId, cycleId, memberId: memberA }, nodeDrawHasher)).toBe(VECTORS.ticket);
  });
});

describe("TypeScript engine == SQL winner derivation (golden vectors)", () => {
  const nonces = [
    { memberId: memberA, nonce: nonceA },
    { memberId: memberB, nonce: nonceB }
  ];

  it("nonce set digest, independent of the order the nonces arrive in", async () => {
    expect(await computeNonceDigest({ drawId, nonces }, nodeDrawHasher)).toBe(VECTORS.nonceDigest);
    expect(await computeNonceDigest({ drawId, nonces: [...nonces].reverse() }, nodeDrawHasher)).toBe(VECTORS.nonceDigest);
  });

  it("transcript digest v3", async () => {
    expect(
      await computeTranscriptDigest(
        { drawId, commitment: VECTORS.commitment, rosterDigest, memberDigest: VECTORS.memberDigest, seed, nonceDigest: VECTORS.nonceDigest },
        "v3",
        nodeDrawHasher
      )
    ).toBe(VECTORS.transcript);
  });

  it("selection: the first attempt digest and the index for several roster sizes", async () => {
    const sizes = new Map([
      [1, 0],
      [3, 0],
      [7, 0],
      [200, 82]
    ]);
    for (const [eligibleCount, index] of sizes) {
      const picked = await selectWinnerIndex({ transcriptDigest: VECTORS.transcript, eligibleCount }, nodeDrawHasher);
      expect(picked, `n=${eligibleCount}`).toEqual({ index, digest: VECTORS.selectionAttempt0, attempts: 1 });
    }
  });

  it("rejection sampling: a digest above the largest multiple of n is rejected and the next attempt is used", async () => {
    // 2^256 mod 3 = 1, so the bound is 2^256 - 1 and the all-ones digest is rejected for n = 3;
    // the second attempt is accepted: 0x...02 mod 3 = 2. (The SQL harness asserts the same with
    // sened_draw_accept_digest: PARITY 8.)
    const digests = ["f".repeat(64), "2".padStart(64, "0")];
    let call = 0;
    const picked = await selectWinnerIndex({ transcriptDigest: VECTORS.transcript, eligibleCount: 3 }, async () => digests[call++]!);
    expect(picked).toEqual({ index: 2, digest: digests[1], attempts: 2 });
    // For n = 4 the same digest is NOT rejected (2^256 is a multiple of 4): 0xff..ff mod 4 = 3.
    const four = await selectWinnerIndex({ transcriptDigest: VECTORS.transcript, eligibleCount: 4 }, async () => "f".repeat(64));
    expect(four).toEqual({ index: 3, digest: "f".repeat(64), attempts: 1 });
  });

  it("the reserve is the ratio of the pot set by the cycle, rounded half up to the cent (PARITY 9)", () => {
    const cases: [bigint, number, bigint][] = [
      [300_000n, 1000, 30_000n], // 3000.00 at 10% -> 300.00
      [5n, 5000, 3n], // 0.05 at 50% = 0.025 -> 0.03
      [10n, 2500, 3n], // 0.10 at 25% = 0.025 -> 0.03
      [101n, 5000, 51n], // 1.01 at 50% = 0.505 -> 0.51
      [100n, 3333, 33n], // 1.00 at 33.33% = 0.3333 -> 0.33
      [10_005n, 333, 333n], // 100.05 at 3.33% = 3.331665 -> 3.33
      [1_200_000n, 3333, 399_960n], // 12000.00 at 33.33% -> 3999.60
      [500_000n, 0, 0n]
    ];
    for (const [pot, bps, reserve] of cases) {
      expect(reserveByRatioMinor(pot, bps), `${pot} @ ${bps}`).toBe(reserve);
    }
  });
});

describe("the SQL harness asserts the same literals against the SQL functions", () => {
  const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");
  const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261014100000_draw_integrity.sql"), "utf8");

  it("every golden value is in the harness", () => {
    for (const [name, value] of Object.entries(VECTORS)) {
      expect(harness, `${name} must be asserted in the harness`).toContain(value);
    }
    for (const literal of ["0.03", "0.51", "3999.60", "3.33"]) {
      expect(harness).toContain(literal);
    }
  });

  it("through the SQL functions", () => {
    for (const fn of [
      "sened_draw_member_seal_hash",
      "sened_draw_member_set_digest",
      "sened_draw_commit_hash_v3",
      "sened_draw_ticket",
      "sened_draw_nonce_set_digest",
      "sened_draw_transcript_hash_v3",
      "sened_draw_selection_hash",
      "sened_draw_select_index",
      "sened_draw_accept_digest",
      "sened_draw_reserve_amount"
    ]) {
      expect(harness).toContain(`public.${fn}(`);
    }
  });

  it("the migration derives the winner in the reveal trigger, for every insert path", () => {
    const trigger = migration.slice(migration.indexOf("create or replace function public.sened_draw_validate_reveal"));
    expect(trigger).toContain("sened_draw_derive_v3(committed_row, new.seed, new.member_nonces)");
    expect(trigger).toContain("draw_transcript_mismatch");
    expect(trigger).toContain("draw_selection_mismatch");
    expect(trigger).toContain("sened_draw_reserve_amount(committed_row.pot_amount, committed_row.reserve_ratio_bps)");
  });
});
