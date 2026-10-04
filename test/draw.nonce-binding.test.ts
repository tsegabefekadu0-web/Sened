import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  canonicalSerializeNonceSet,
  canonicalSerializeTranscript,
  computeCommitment,
  computeNonceDigest,
  computeTranscriptDigest,
  selectWinnerIndex,
  toVerificationTranscript,
  webDrawHasher
} from "@/lib/draw/canonical";
import { verifyInBrowser, type WireVerify } from "@/lib/draw/clientDraw";
import {
  createCommitment,
  openReveal,
  sealMemberContribution,
  verifyRound,
  verifyTranscript
} from "@/lib/draw/engine";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import { InMemoryDrawRepository, SupabaseDrawRepository } from "@/lib/draw/repository";
import type {
  DrawMember,
  DrawMemberCommitment,
  DrawMemberNonce,
  DrawProtocolVersion,
  DrawRound
} from "@/lib/draw/types";

/**
 * Protocol v3 — the winner depends on the revealed member nonces.
 *
 * THE HOLE (v2). The winner was `selectWinnerIndex(transcriptDigest)` with
 * `transcriptDigest = H(drawId, commitment, rosterDigest, memberDigest, seed)`.
 * `memberDigest` is a digest of the members' sealed HASHES. Every input was known
 * to the treasurer before they committed, so they could grind `seed` /
 * `commitmentNonce` offline until the winner was whoever they wanted, then
 * commit. The member nonces — the only values the treasurer does not have at
 * commit time — never influenced the outcome. `draw.fairness.test.ts` only ever
 * tested grinding AFTER the commit, which v2 did already prevent.
 *
 * THE FIX (v3). `nonceDigest = H(drawId, sorted (memberId, nonce) pairs)`, taken
 * only from nonces that verified against their seals, is part of the transcript
 * preimage. The winner is therefore a function of values that did not exist, from
 * the treasurer's point of view, when they chose the seed.
 *
 * This file proves (a) v2 really was grindable, so the test is not vacuous,
 * (b) v3 is not, (c) the new derivation is pinned by golden vectors, (d) v2
 * history still verifies byte-for-byte, and (e) tampering is detected.
 */

const hasher = nodeDrawHasher;
const groupId = "22222222-2222-4222-8222-222222222222";
const cycleId = "77777777-7777-4777-8777-777777777777";
const treasurer = "11111111-1111-4111-8111-111111111111";
const drawId = "55555555-5555-4555-8555-555555555555";
const REVEALED_AT = "2026-09-26T09:30:00.000Z";

function member(index: number): DrawMember {
  return {
    memberId: `${String(index).padStart(4, "0")}4444-4444-8444-8444-444444444444`,
    displayName: `Member ${index}`,
    status: "active",
    contributionAmount: "5000.00"
  };
}

const roster: DrawMember[] = [member(1), member(2), member(3), member(4), member(5)];
const SEED = "golden-treasurer-seed-0123456789";
const COMMITMENT_NONCE = "golden-commitment-nonce-0123456789";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seal(id: string, memberId: string, nonce: string): Promise<DrawMemberCommitment> {
  return sealMemberContribution({ drawId: id, memberId, nonce }, hasher);
}

function request(
  overrides: Partial<Parameters<typeof createCommitment>[0]> & {
    readonly memberCommitments: readonly DrawMemberCommitment[];
  }
): Parameters<typeof createCommitment>[0] {
  return {
    groupId,
    cycleId,
    round: 1,
    totalRounds: 5,
    drawId,
    commitmentNonce: COMMITMENT_NONCE,
    seed: SEED,
    potAmount: "25000.00",
    reserveRatioBps: 1000,
    members: roster,
    priorWinnerIds: [],
    committedBy: treasurer,
    committedAt: "2026-09-26T09:00:00.000Z",
    idempotencyKey: "nonce-binding-1",
    ...overrides
  };
}

function asRound(
  commitment: Awaited<ReturnType<typeof createCommitment>>,
  reveal: DrawRound["reveal"] = null
): DrawRound {
  return {
    ...commitment,
    state: reveal === null ? "committed" : "revealed",
    reveal,
    payout: null
  };
}

async function reveal(
  commitment: Awaited<ReturnType<typeof createCommitment>>,
  seed: string,
  nonces: readonly DrawMemberNonce[]
) {
  return openReveal(
    commitment,
    { seed, memberNonces: nonces, revealedBy: treasurer, revealedAt: REVEALED_AT },
    hasher
  );
}

/** Index in ticket order -> memberId, so tests can name the member a draw picked. */
const GOLDEN_NONCES: DrawMemberNonce[] = [
  { memberId: roster[0]!.memberId, nonce: "golden-nonce-member-one-0001" },
  { memberId: roster[1]!.memberId, nonce: "golden-nonce-member-two-0002" }
];

async function goldenCommitment(protocolVersion: DrawProtocolVersion) {
  const sealed = await Promise.all(GOLDEN_NONCES.map((entry) => seal(drawId, entry.memberId, entry.nonce)));
  return createCommitment(request({ memberCommitments: sealed, protocolVersion }), hasher);
}

// ---------------------------------------------------------------------------
// (a) + (b): grinding
// ---------------------------------------------------------------------------

/**
 * What the treasurer can compute BEFORE committing: everything except the member
 * nonces. They hold the seed and commitment nonce, they see the roster and the
 * members' sealed hashes. This predicts the v2 winner exactly.
 */
async function predictFromCommitTimeView(
  view: {
    readonly drawId: string;
    readonly rosterDigest: string;
    readonly memberDigest: string;
    readonly memberCommitments: readonly DrawMemberCommitment[];
  },
  seed: string,
  protocolVersion: DrawProtocolVersion
): Promise<number> {
  // They cannot compute the commitment under v3 without a nonce digest either, so
  // this uses the strongest thing a v3 attacker has: a stand-in nonce digest (here
  // the digest of the empty set). Under v2 the stand-in is ignored and the
  // prediction is exact.
  const standIn = await computeNonceDigest({ drawId: view.drawId, nonces: [] }, hasher);
  const commitment = await computeCommitment(
    {
      groupId,
      cycleId,
      round: 1,
      drawId: view.drawId,
      rosterDigest: view.rosterDigest,
      commitmentNonce: COMMITMENT_NONCE,
      memberDigest: view.memberDigest,
      seed
    },
    protocolVersion,
    hasher
  );
  const transcriptDigest = await computeTranscriptDigest(
    {
      drawId: view.drawId,
      commitment,
      rosterDigest: view.rosterDigest,
      memberDigest: view.memberDigest,
      seed,
      nonceDigest: standIn
    },
    protocolVersion,
    hasher
  );
  return (await selectWinnerIndex({ transcriptDigest, eligibleCount: roster.length }, hasher)).index;
}

interface GrindOutcome {
  readonly hits: number;
  readonly trials: number;
  readonly guessesPerTrial: number;
}

/**
 * The attack, run to completion against the real engine.
 *
 * Each trial is a fresh draw: members seal their own (here: deterministic, but
 * unknown-to-the-attacker) nonces; the attacker sees the sealed hashes and the
 * roster; then searches seeds for one whose PREDICTED winner is `target`, commits
 * with it, and the members reveal. A hit is the real, engine-computed winner
 * being the target.
 */
async function grind(
  protocolVersion: DrawProtocolVersion,
  options: { readonly trials: number; readonly knownNonceMembers?: number }
): Promise<GrindOutcome> {
  let hits = 0;
  let totalGuesses = 0;
  for (let trial = 0; trial < options.trials; trial += 1) {
    const id = `00000000-0000-4000-8000-${String(trial).padStart(12, "0")}`;
    const nonces: DrawMemberNonce[] = [
      { memberId: roster[0]!.memberId, nonce: `trial-${trial}-nonce-for-member-one-XXXX` },
      { memberId: roster[1]!.memberId, nonce: `trial-${trial}-nonce-for-member-two-YYYY` }
    ];
    const sealed = await Promise.all(nonces.map((entry) => seal(id, entry.memberId, entry.nonce)));

    // The commit-time view. The seed is irrelevant to these fields, so a probe
    // commitment with any seed yields the rosterDigest / memberDigest the attacker
    // would see.
    const probe = await createCommitment(
      request({ drawId: id, memberCommitments: sealed, protocolVersion }),
      hasher
    );
    const view = {
      drawId: id,
      rosterDigest: probe.rosterDigest,
      memberDigest: probe.memberDigest,
      memberCommitments: sealed
    };

    // Rotating the target over the roster keeps the result from depending on one
    // member's position in ticket order.
    const target = orderedMemberIds(probe)[trial % roster.length]!;
    const targetIndex = orderedMemberIds(probe).indexOf(target);

    let chosenSeed = `fallback-seed-${trial}-0123456789`;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const candidate = `grind-${trial}-${String(attempt).padStart(4, "0")}-abcdefgh`;
      totalGuesses += 1;
      if ((await predictFromCommitTimeView(view, candidate, protocolVersion)) === targetIndex) {
        chosenSeed = candidate;
        break;
      }
    }

    const committed = await createCommitment(
      request({ drawId: id, memberCommitments: sealed, seed: chosenSeed, protocolVersion }),
      hasher
    );
    const opened = await reveal(committed, chosenSeed, nonces);
    if (opened.reveal.winnerMemberId === target) hits += 1;
  }
  return { hits, trials: options.trials, guessesPerTrial: totalGuesses / options.trials };
}

function orderedMemberIds(commitment: { readonly participants: readonly { readonly memberId: string; readonly ticket: string }[] }): string[] {
  return [...commitment.participants]
    .sort((left, right) => (left.ticket < right.ticket ? -1 : left.ticket > right.ticket ? 1 : 0))
    .map((participant) => participant.memberId);
}

describe("the grinding attack, and why v3 defeats it", () => {
  const TRIALS = 300;
  const CHANCE = 1 / roster.length;

  it("(control) v2 WAS grindable: the treasurer hits the chosen member every single time", async () => {
    const outcome = await grind("v2", { trials: TRIALS });

    // Without this, the v3 result below proves nothing: it would pass even if the
    // attack simply did not work against this harness.
    expect(outcome.hits).toBe(TRIALS);
    // And it is cheap: about |roster| seeds per target.
    expect(outcome.guessesPerTrial).toBeLessThan(15);
  });

  it("v3: the same attack is no better than chance once the nonces are applied", async () => {
    const outcome = await grind("v3", { trials: TRIALS });

    // Binomial(300, 0.2): mean 60, sd ~6.9. This is deterministic (all inputs are
    // derived from the trial index), so the bound is a fixed property of the code,
    // not a flaky statistical test; the window is simply wide enough to say "chance".
    expect(outcome.hits).toBeGreaterThan(TRIALS * CHANCE * 0.5);
    expect(outcome.hits).toBeLessThan(TRIALS * CHANCE * 1.6);
    // Far from the v2 result.
    expect(outcome.hits).toBeLessThan(TRIALS * 0.4);
  });

  it("with every commit-time input fixed, varying only the nonce digest moves the winner", async () => {
    // The literal statement of the property: hold the whole commit-time preimage
    // (drawId, commitment, rosterDigest, memberDigest, seed) constant and change
    // only the thing the treasurer does not have.
    const commitment = await goldenCommitment("v3");
    const winners = new Map<number, number>();
    const SAMPLES = 200;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const nonceDigest = await computeNonceDigest(
        {
          drawId,
          nonces: [
            { memberId: roster[0]!.memberId, nonce: `sample-${sample}-one-0123456789` },
            { memberId: roster[1]!.memberId, nonce: `sample-${sample}-two-0123456789` }
          ]
        },
        hasher
      );
      const transcriptDigest = await computeTranscriptDigest(
        {
          drawId,
          commitment: commitment.commitment,
          rosterDigest: commitment.rosterDigest,
          memberDigest: commitment.memberDigest,
          seed: SEED,
          nonceDigest
        },
        "v3",
        hasher
      );
      const { index } = await selectWinnerIndex({ transcriptDigest, eligibleCount: roster.length }, hasher);
      winners.set(index, (winners.get(index) ?? 0) + 1);
    }

    // Every roster position is reachable and none dominates: roughly uniform.
    expect(winners.size).toBe(roster.length);
    for (const count of winners.values()) {
      expect(count).toBeGreaterThan(SAMPLES * CHANCE * 0.4);
      expect(count).toBeLessThan(SAMPLES * CHANCE * 1.7);
    }
  });

  it("end to end: for a fixed seed and roster, different member nonces give different winners", async () => {
    const winners = new Set<string>();
    for (let sample = 0; sample < 40; sample += 1) {
      const id = `10000000-0000-4000-8000-${String(sample).padStart(12, "0")}`;
      const nonces = [{ memberId: roster[0]!.memberId, nonce: `end-to-end-${sample}-nonce-0123456789` }];
      const sealed = [await seal(id, nonces[0]!.memberId, nonces[0]!.nonce)];
      const committed = await createCommitment(request({ drawId: id, memberCommitments: sealed }), hasher);
      winners.add((await reveal(committed, SEED, nonces)).reveal.winnerMemberId);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it("every member's nonce matters, not just the first: changing only the second moves the winner", async () => {
    const winners = new Set<string>();
    for (let sample = 0; sample < 40; sample += 1) {
      const nonces: DrawMemberNonce[] = [
        { memberId: roster[0]!.memberId, nonce: "the-first-members-fixed-nonce-01" },
        { memberId: roster[1]!.memberId, nonce: `only-the-second-varies-${sample}-0123456789` }
      ];
      const sealed = await Promise.all(nonces.map((entry) => seal(drawId, entry.memberId, entry.nonce)));
      const committed = await createCommitment(request({ memberCommitments: sealed }), hasher);
      winners.add((await reveal(committed, SEED, nonces)).reveal.winnerMemberId);
    }
    // A treasurer colluding with member one still cannot steer the outcome while
    // member two's nonce is unknown to them.
    expect(winners.size).toBeGreaterThan(1);
  });

  it("an attacker who knows every nonce but one still hits only at chance", async () => {
    // Colluding with all but one member. The knowledge is real (they use the true
    // nonce of member one in their prediction) but the unknown one still decides.
    let hits = 0;
    const TRIALS_PARTIAL = 200;
    for (let trial = 0; trial < TRIALS_PARTIAL; trial += 1) {
      const id = `20000000-0000-4000-8000-${String(trial).padStart(12, "0")}`;
      const known: DrawMemberNonce = { memberId: roster[0]!.memberId, nonce: `colluding-known-${trial}-0123456789` };
      const hidden: DrawMemberNonce = { memberId: roster[1]!.memberId, nonce: `honest-hidden-${trial}-0123456789` };
      const sealed = await Promise.all([known, hidden].map((entry) => seal(id, entry.memberId, entry.nonce)));
      const probe = await createCommitment(request({ drawId: id, memberCommitments: sealed }), hasher);
      const ordered = orderedMemberIds(probe);
      const targetIndex = trial % roster.length;

      let chosen = `partial-fallback-${trial}-0123456789`;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const candidate = `partial-${trial}-${String(attempt).padStart(4, "0")}-abcdefgh`;
        const guessed = await computeNonceDigest({ drawId: id, nonces: [known, { ...hidden, nonce: "a-guess-at-the-hidden-nonce-00" }] }, hasher);
        const commitment = await computeCommitment(
          {
            groupId,
            cycleId,
            round: 1,
            drawId: id,
            rosterDigest: probe.rosterDigest,
            commitmentNonce: COMMITMENT_NONCE,
            memberDigest: probe.memberDigest,
            seed: candidate
          },
          "v3",
          hasher
        );
        const digest = await computeTranscriptDigest(
          { drawId: id, commitment, rosterDigest: probe.rosterDigest, memberDigest: probe.memberDigest, seed: candidate, nonceDigest: guessed },
          "v3",
          hasher
        );
        if ((await selectWinnerIndex({ transcriptDigest: digest, eligibleCount: roster.length }, hasher)).index === targetIndex) {
          chosen = candidate;
          break;
        }
      }
      const committed = await createCommitment(request({ drawId: id, memberCommitments: sealed, seed: chosen }), hasher);
      const opened = await reveal(committed, chosen, [known, hidden]);
      if (opened.reveal.winnerMemberId === ordered[targetIndex]) hits += 1;
    }
    expect(hits).toBeLessThan(TRIALS_PARTIAL * CHANCE * 1.7);
  });
});

// ---------------------------------------------------------------------------
// (c) golden vectors
// ---------------------------------------------------------------------------

describe("golden vectors", () => {
  it("v3 serialization is pinned byte for byte", () => {
    const text = canonicalSerializeNonceSet({ drawId: "d", nonces: [
      { memberId: "m2", nonce: "n2" },
      { memberId: "m1", nonce: "n1" }
    ] });
    // Sorted by memberId, length-prefixed, versioned.
    expect(text).toBe(
      [
        "23:sened-draw-nonce-set-v1",
        "6:drawId",
        "1:d",
        "16:nonce.0.memberId",
        "2:m1",
        "13:nonce.0.nonce",
        "2:n1",
        "16:nonce.1.memberId",
        "2:m2",
        "13:nonce.1.nonce",
        "2:n2"
      ].join("\n")
    );

    const transcript = canonicalSerializeTranscript(
      { drawId: "d", commitment: "c", rosterDigest: "r", memberDigest: "m", nonceDigest: "0".repeat(64), seed: "s" },
      "v3"
    );
    expect(transcript).toBe(
      [
        "24:sened-draw-transcript-v3",
        "6:drawId", "1:d",
        "10:commitment", "1:c",
        "12:rosterDigest", "1:r",
        "12:memberDigest", "1:m",
        "11:nonceDigest", `64:${"0".repeat(64)}`,
        "4:seed", "1:s"
      ].join("\n")
    );
  });

  it("v3 transcript refuses to serialize without a nonce digest", () => {
    expect(() =>
      canonicalSerializeTranscript(
        { drawId: "d", commitment: "c", rosterDigest: "r", memberDigest: "m", seed: "s" },
        "v3"
      )
    ).toThrowError(/nonces/);
  });

  it("a nonce set refuses a repeated member rather than collapsing it", () => {
    expect(() =>
      canonicalSerializeNonceSet({
        drawId: "d",
        nonces: [
          { memberId: "m1", nonce: "n1" },
          { memberId: "m1", nonce: "n1" }
        ]
      })
    ).toThrowError(/more than once/);
  });

  it("the nonce digest does not depend on submission order, and is bound to the draw", async () => {
    const [a, b] = GOLDEN_NONCES as [DrawMemberNonce, DrawMemberNonce];
    expect(await computeNonceDigest({ drawId, nonces: [a, b] }, hasher)).toBe(
      await computeNonceDigest({ drawId, nonces: [b, a] }, hasher)
    );
    expect(await computeNonceDigest({ drawId, nonces: [a, b] }, hasher)).not.toBe(
      await computeNonceDigest({ drawId: "66666666-6666-4666-8666-666666666666", nonces: [a, b] }, hasher)
    );
  });

  it("v3: the engine reproduces the pinned vectors, and an independent hand computation agrees", async () => {
    const commitment = await goldenCommitment("v3");
    const opened = await reveal(commitment, SEED, GOLDEN_NONCES);

    // Independent recomputation of the new quantity with plain SHA-256 over the
    // documented serialization, no engine code involved.
    const nonceSet = [
      "23:sened-draw-nonce-set-v1",
      "6:drawId",
      `${drawId.length}:${drawId}`,
      ...GOLDEN_NONCES.flatMap((entry, index) => [
        `${`nonce.${index}.memberId`.length}:nonce.${index}.memberId`,
        `${entry.memberId.length}:${entry.memberId}`,
        `${`nonce.${index}.nonce`.length}:nonce.${index}.nonce`,
        `${entry.nonce.length}:${entry.nonce}`
      ])
    ].join("\n");
    const nonceDigest = sha256(nonceSet);
    const transcript = [
      "24:sened-draw-transcript-v3",
      "6:drawId", `${drawId.length}:${drawId}`,
      "10:commitment", `64:${commitment.commitment}`,
      "12:rosterDigest", `64:${commitment.rosterDigest}`,
      "12:memberDigest", `64:${commitment.memberDigest}`,
      "11:nonceDigest", `64:${nonceDigest}`,
      "4:seed", `${SEED.length}:${SEED}`
    ].join("\n");
    expect(opened.reveal.transcriptDigest).toBe(sha256(transcript));

    // The commitment is bound to the version too: same fields as v2, new tag.
    const field = (name: string, value: string) => `${name.length}:${name}\n${value.length}:${value}`;
    const commit = [
      "20:sened-draw-commit-v3",
      field("groupId", groupId),
      field("cycleId", cycleId),
      field("round", "1"),
      field("drawId", drawId),
      field("rosterDigest", commitment.rosterDigest),
      field("commitmentNonce", COMMITMENT_NONCE),
      field("memberDigest", commitment.memberDigest),
      field("seed", SEED)
    ].join("\n");
    expect(commitment.commitment).toBe(sha256(commit));

    // Pinned values. A change here is a protocol change and must bump the version.
    expect(commitment.commitment).toBe("127be580e64c90008ec8c6ef4a8fcee5d8b6c49032b2d53b9da4926dfac4b6a1");
    expect(commitment.memberDigest).toBe("459537ac7885a7d6acdf5ce1ef79b36d971834575719e44683c5a6d3a9ddbd66");
    expect(nonceDigest).toBe("4901350d1505d5edc1e24f4ad6d194b31ddfe6e552714ba88644840b0fe2d9b5");
    expect(opened.reveal.transcriptDigest).toBe("31740c61975d72d78dbe7cec0a883103eae6b292fbafc62a8df475c1aa16074e");
    expect(opened.reveal.selectionDigest).toBe("e20e49ecc66e661bbb8778a82f4fb6015ba1e399bfb7ca90e12ee9a6969f4651");
    expect(opened.reveal.selectedIndex).toBe(2);
    expect(opened.reveal.winnerMemberId).toBe("00044444-4444-8444-8444-444444444444");
  });

  it("v3 and v2 derive different commitments and transcripts from identical inputs", async () => {
    const v2 = await goldenCommitment("v2");
    const v3 = await goldenCommitment("v3");

    expect(v2.commitment).not.toBe(v3.commitment);
    expect(v2.memberDigest).toBe(v3.memberDigest);
    expect(v2.rosterDigest).toBe(v3.rosterDigest);
  });
});

// ---------------------------------------------------------------------------
// (d) v2 history stays verifiable
// ---------------------------------------------------------------------------

describe("v2 draws remain verifiable under their original rules", () => {
  // Captured by running the PRE-CHANGE engine (git HEAD, before protocol v3) on
  // exactly the golden inputs. If these ever need to change, historical draws have
  // been broken.
  const LEGACY = {
    commitment: "054ed1a5f3f58509f2ba1f79e0ff107a83a87e64fb0a2db75bf39b88f3a02175",
    memberDigest: "459537ac7885a7d6acdf5ce1ef79b36d971834575719e44683c5a6d3a9ddbd66",
    rosterDigest: "4c75efb55ac3af04b276dfc1ae3794b399d76de39e351fb7970ee54154a3bc20",
    transcriptDigest: "d6e48aff67dd5e12aec9c7c8c169a29dd8dcc9135b44f6fd48204ad97d24e291",
    selectionDigest: "daaf618402ff9978b5fedfe05d5c0bd97aedca618f06ff30f170f0e2d704d64b",
    selectedIndex: 4,
    winner: "00034444-4444-8444-8444-444444444444"
  };

  it("reproduces the digests the pre-v3 code produced, byte for byte", async () => {
    const commitment = await goldenCommitment("v2");
    const opened = await reveal(commitment, SEED, GOLDEN_NONCES);

    expect(commitment.commitment).toBe(LEGACY.commitment);
    expect(commitment.memberDigest).toBe(LEGACY.memberDigest);
    expect(commitment.rosterDigest).toBe(LEGACY.rosterDigest);
    expect(opened.reveal.transcriptDigest).toBe(LEGACY.transcriptDigest);
    expect(opened.reveal.selectionDigest).toBe(LEGACY.selectionDigest);
    expect(opened.reveal.selectedIndex).toBe(LEGACY.selectedIndex);
    expect(opened.reveal.winnerMemberId).toBe(LEGACY.winner);
  });

  it("verifyRound accepts a stored v2 round", async () => {
    const commitment = await goldenCommitment("v2");
    const { reveal: published } = await reveal(commitment, SEED, GOLDEN_NONCES);

    const result = await verifyRound(asRound(commitment, published), {}, hasher);

    expect(result.verified).toBe(true);
    expect(result.codes).toEqual(["ok"]);
    expect(result.nonceDigest).toBeNull();
    expect(result.transcriptDigest).toBe(LEGACY.transcriptDigest);
  });

  it("a transcript with no version field is read as v2 (rows from before versioning)", async () => {
    const commitment = await goldenCommitment("v2");
    const { reveal: published } = await reveal(commitment, SEED, GOLDEN_NONCES);
    const { protocolVersion: _omitted, memberNonces: _nonces, ...legacyShape } = toVerificationTranscript(
      asRound(commitment, published)
    );

    const result = await verifyTranscript(legacyShape, hasher);

    expect(result.verified).toBe(true);
    expect(result.transcriptDigest).toBe(LEGACY.transcriptDigest);
  });

  it("a stored row without protocolVersion parses as v2", async () => {
    const commitment = await goldenCommitment("v2");
    const { protocolVersion: _dropped, ...rowWithoutVersion } = commitment;
    const client = {
      rpc: async () => ({
        data: {
          replayed: false,
          round: { state: "committed", commitment: rowWithoutVersion, reveal: null, payout: null }
        },
        error: null
      })
    };

    const stored = await new SupabaseDrawRepository(client as never).saveCommitment(
      { ...commitment, protocolVersion: "v3" },
      { userId: treasurer }
    );

    expect(stored.round.protocolVersion).toBe("v2");
  });

  it("v2 stays read-only: the repository will not record a new v2 commitment", async () => {
    const commitment = await goldenCommitment("v2");

    await expect(
      new InMemoryDrawRepository().saveCommitment(commitment, { userId: treasurer })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// (e) downgrade, tampering, withholding
// ---------------------------------------------------------------------------

describe("v3 verification fails closed", () => {
  async function published() {
    const commitment = await goldenCommitment("v3");
    const { reveal: revealed } = await reveal(commitment, SEED, GOLDEN_NONCES);
    const round = asRound(commitment, revealed);
    return { commitment, revealed, round, transcript: toVerificationTranscript(round) };
  }

  it("verifies an honest v3 round and reports the nonce digest", async () => {
    const { round, revealed } = await published();

    const result = await verifyRound(round, {}, hasher);

    expect(result.verified).toBe(true);
    expect(result.codes).toEqual(["ok"]);
    expect(result.winnerMemberId).toBe(revealed.winnerMemberId);
    expect(result.nonceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.transcriptDigest).toBe(revealed.transcriptDigest);
  });

  it("cannot be downgraded: the same v3 transcript labelled v2 (or unlabelled) fails the commitment", async () => {
    const { transcript } = await published();

    for (const relabelled of [{ ...transcript, protocolVersion: "v2" as const }, { ...transcript, protocolVersion: undefined }]) {
      const result = await verifyTranscript(relabelled, hasher);
      expect(result.verified).toBe(false);
      expect(result.codes).toContain("commitment_mismatch");
      expect(result.winnerMemberId).toBeNull();
    }
  });

  it("cannot be upgraded either: a v2 transcript labelled v3 fails", async () => {
    const commitment = await goldenCommitment("v2");
    const { reveal: revealed } = await reveal(commitment, SEED, GOLDEN_NONCES);
    const transcript = toVerificationTranscript(asRound(commitment, revealed));

    const result = await verifyTranscript({ ...transcript, protocolVersion: "v3" }, hasher);

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("commitment_mismatch");
  });

  it("is incomplete, not verified, when the nonces are not published", async () => {
    const { transcript } = await published();

    for (const memberNonces of [undefined, []]) {
      const result = await verifyTranscript({ ...transcript, memberNonces }, hasher);
      expect(result.verified).toBe(false);
      expect(result.codes).toEqual(["incomplete_transcript"]);
      expect(result.winnerMemberId).toBeNull();
    }
  });

  it("detects a tampered nonce and names no winner and no transcript digest", async () => {
    const { transcript } = await published();
    const tampered = {
      ...transcript,
      memberNonces: [
        { ...transcript.memberNonces![0]!, nonce: "a-nonce-the-treasurer-would-prefer" },
        transcript.memberNonces![1]!
      ]
    };

    const result = await verifyTranscript(tampered, hasher);

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("member_commitment_mismatch");
    expect(result.winnerMemberId).toBeNull();
    // An unverified nonce must never contribute to a digest a member might trust.
    expect(result.nonceDigest).toBeNull();
    expect(result.transcriptDigest).toBeNull();
  });

  it("detects a dropped nonce, and a repeated nonce standing in for the dropped one", async () => {
    const { transcript } = await published();
    const [first, second] = transcript.memberNonces! as [DrawMemberNonce, DrawMemberNonce];

    const dropped = await verifyTranscript({ ...transcript, memberNonces: [first] }, hasher);
    expect(dropped.verified).toBe(false);
    expect(dropped.codes).toContain("member_commitment_mismatch");

    // Same count as sealed, so a length check alone would pass this. The unopened
    // nonce is exactly the unknown the treasurer cannot grind over.
    const repeated = await verifyTranscript({ ...transcript, memberNonces: [first, first] }, hasher);
    expect(repeated.verified).toBe(false);
    expect(repeated.codes).toContain("member_commitment_mismatch");
    expect(second).toBeDefined();
  });

  it("the reveal itself refuses a repeated nonce hiding an unopened one", async () => {
    const commitment = await goldenCommitment("v3");

    await expect(
      reveal(commitment, SEED, [GOLDEN_NONCES[0]!, GOLDEN_NONCES[0]!])
    ).rejects.toMatchObject({ code: "MEMBER_COMMITMENT_MISSING" });
  });

  it("withholding aborts the draw rather than choosing it: one member refusing to reveal refuses the reveal", async () => {
    const commitment = await goldenCommitment("v3");

    await expect(reveal(commitment, SEED, [GOLDEN_NONCES[0]!])).rejects.toMatchObject({
      code: "MEMBER_COMMITMENT_MISSING"
    });
  });

  it("an abandoned commitment is still flagged on a v3 draw", async () => {
    const { round } = await published();

    const result = await verifyRound(round, { supersededCommitmentCount: 2 }, hasher);

    expect(result.codes).toContain("suspicious_commitment_history");
    expect(result.warnings.join(" ")).toMatch(/abandoned/i);
  });

  it("detects a recorded transcript digest that was not derived from the nonces", async () => {
    const { round, revealed } = await published();

    // A server (or treasurer) swapping in a digest computed without the nonces.
    const withoutNonces = await computeTranscriptDigest(
      {
        drawId,
        commitment: round.commitment,
        rosterDigest: round.rosterDigest,
        memberDigest: round.memberDigest,
        seed: SEED,
        nonceDigest: await computeNonceDigest({ drawId, nonces: [] }, hasher)
      },
      "v3",
      hasher
    );

    const result = await verifyRound({ ...round, reveal: { ...revealed, transcriptDigest: withoutNonces } }, {}, hasher);

    expect(result.verified).toBe(false);
    expect(result.codes).toContain("selection_mismatch");
  });
});

// ---------------------------------------------------------------------------
// browser recomputation
// ---------------------------------------------------------------------------

describe("the browser recomputes v3 and agrees with the server", () => {
  async function wireFor(tamper: (wire: WireVerify) => WireVerify = (wire) => wire): Promise<WireVerify> {
    const commitment = await goldenCommitment("v3");
    const { reveal: revealed } = await reveal(commitment, SEED, GOLDEN_NONCES);
    const round = asRound(commitment, revealed);
    const verification = await verifyRound(round, {}, hasher);
    const wire: WireVerify = {
      round: {
        drawId: round.drawId,
        groupId: round.groupId,
        cycleId: round.cycleId,
        round: round.round,
        commitment: round.commitment,
        rosterDigest: round.rosterDigest,
        participantCount: round.participants.length,
        potAmount: round.potAmount,
        totalRounds: round.totalRounds,
        reserveRatioBps: round.reserveRatioBps,
        state: "revealed",
        committedAt: round.committedAt,
        revealed: true,
        winnerMemberId: revealed.winnerMemberId,
        payoutAmount: revealed.payoutAmount,
        reserveAmount: revealed.reserveAmount,
        payout: null
      },
      verification: {
        verified: verification.verified,
        codes: verification.codes,
        warnings: verification.warnings,
        winnerMemberId: verification.winnerMemberId,
        transcriptDigest: verification.transcriptDigest,
        nonceDigest: verification.nonceDigest
      },
      transcript: { ...toVerificationTranscript(round), memberNonces: undefined },
      memberNonces: revealed.memberNonces
    };
    return tamper(wire);
  }

  it("WebCrypto and node:crypto produce the same v3 verdict, winner and digests", async () => {
    const wire = await wireFor();

    const check = await verifyInBrowser(wire);

    expect(check.local.verified).toBe(true);
    expect(check.disagreements).toEqual([]);
    expect(check.trusted).toBe(true);
    expect(check.local.winnerMemberId).toBe(wire.round.winnerMemberId);
    expect(check.local.transcriptDigest).toBe(wire.verification.transcriptDigest);
    expect(check.local.nonceDigest).toBe(wire.verification.nonceDigest);

    // And literally the same hash function result, not merely the same verdict.
    const viaWeb = await computeNonceDigest({ drawId, nonces: GOLDEN_NONCES }, webDrawHasher);
    expect(viaWeb).toBe(await computeNonceDigest({ drawId, nonces: GOLDEN_NONCES }, hasher));
  });

  it("detects a server-claimed nonce digest that differs from the recomputed one", async () => {
    const wire = await wireFor((original) => ({
      ...original,
      verification: { ...original.verification, nonceDigest: "7".repeat(64) }
    }));

    const check = await verifyInBrowser(wire);

    expect(check.local.verified).toBe(true);
    expect(check.disagreements).toContain("nonceDigest");
    expect(check.trusted).toBe(false);
  });

  it("detects a tampered nonce in what the server published", async () => {
    const wire = await wireFor((original) => ({
      ...original,
      memberNonces: [{ ...original.memberNonces[0]!, nonce: "a-forged-nonce-0123456789" }, original.memberNonces[1]!]
    }));

    const check = await verifyInBrowser(wire);

    expect(check.local.verified).toBe(false);
    expect(check.local.codes).toContain("member_commitment_mismatch");
    expect(check.local.winnerMemberId).toBeNull();
    expect(check.trusted).toBe(false);
  });

  it("refuses to trust a v3 draw whose nonces the server withheld", async () => {
    const wire = await wireFor((original) => ({ ...original, memberNonces: [] }));

    const check = await verifyInBrowser(wire);

    expect(check.local.verified).toBe(false);
    expect(check.trusted).toBe(false);
  });
});
