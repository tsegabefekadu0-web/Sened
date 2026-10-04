import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeCommitment,
  computeMemberCommitment,
  computeMemberDigest,
  deriveTicket
} from "@/lib/draw/canonical";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";

/**
 * The database verifies a seed against the commitment and a nonce against its
 * seal, so four PLAIN length-prefixed hashes are reimplemented in plpgsql
 * (`sened_draw_commit_hash_v3`, `sened_draw_member_seal_hash`,
 * `sened_draw_member_set_digest`, `sened_draw_ticket`). If either side changed its
 * canonical encoding by a byte, honest reveals would be refused in production.
 *
 * Both sides are pinned to the same literals: this test computes them with the
 * real TypeScript engine, and `scripts/verify-migrations.sql` asserts the very same
 * strings against the SQL functions in a real Postgres. A drift fails one of the
 * two. (The winner derivation is deliberately NOT reimplemented in SQL.)
 */

const drawId = "dddddddd-0000-4000-8000-0000000000d1";
const groupId = "aaaaaaaa-0000-4000-8000-000000000001";
const cycleId = "aaaaaaaa-0000-4000-8000-0000000000c1";
const memberA = "44444444-4444-4444-8444-444444444444";
const memberB = "22222222-2222-4222-8222-222222222222";
const nonceA = "nonce-one-0123456789-abcdef";
const nonceB = "nonce-two-0123456789-abcdef";

const VECTORS = {
  sealA: "8cfcb97d951fb4cea06db44c7fe86b4f273689a95eaf65732d83aa5288a5b3cb",
  sealB: "c9e33496edfcb517ab3e593fcef93050c92adfb99a09650e1e5a4582dbd5e7af",
  memberDigest: "339c57dc558400ed5953ada9573a443af7a518f00bf770c49f4b8edc7091cf69",
  commitment: "ce2934b0af978095526e317c3d13b37072517f55c1e827324ac4efb7c6a9f7bb",
  ticket: "acefb395ef8dcf1dee8a4830e74686ffd5318cddac32a121fca7e30ca837d518"
} as const;

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
          rosterDigest: "ab".repeat(32),
          commitmentNonce: "commit-nonce-0123456789",
          memberDigest: VECTORS.memberDigest,
          seed: "seed-value-0123456789-xyz"
        },
        "v3",
        nodeDrawHasher
      )
    ).toBe(VECTORS.commitment);
  });

  it("ticket", async () => {
    expect(await deriveTicket({ groupId, cycleId, memberId: memberA }, nodeDrawHasher)).toBe(VECTORS.ticket);
  });

  it("the SQL harness asserts the same literals against the SQL functions", () => {
    const harness = readFileSync(join(process.cwd(), "scripts/verify-migrations.sql"), "utf8");
    for (const [name, value] of Object.entries(VECTORS)) {
      expect(harness, `${name} must be asserted in the harness`).toContain(value);
    }
    for (const fn of [
      "sened_draw_member_seal_hash",
      "sened_draw_member_set_digest",
      "sened_draw_commit_hash_v3",
      "sened_draw_ticket"
    ]) {
      expect(harness).toContain(`public.${fn}(`);
    }
  });
});
