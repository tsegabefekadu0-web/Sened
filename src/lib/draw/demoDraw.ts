import { webDrawHasher } from "./canonical";
import { createCommitment, openReveal, sealMemberContribution, verifyRound } from "./engine";
import type { DrawMember, DrawRound } from "./types";

const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const CYCLE_ID = "77777777-7777-4777-8777-777777777777";

function entropy(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface DemoDrawResult {
  readonly winnerMemberId: string;
  /** True when the draw, recomputed on this device from the published values, checks out. */
  readonly verified: boolean;
}

/**
 * The signed-out demonstration: a whole commit, reveal and verify run on this
 * device with the real draw engine and the browser hasher. Nothing is sent to a
 * server. One member seals first, the treasurer commits, then the seed opens.
 */
export async function runDemoDraw(
  members: readonly DrawMember[],
  round = 1,
  totalRounds = Math.max(members.length, 1)
): Promise<DemoDrawResult> {
  const contributor = members[0];
  if (contributor === undefined) throw new Error("No eligible member can contribute");
  const drawId = globalThis.crypto.randomUUID();
  const seed = entropy();
  const memberNonce = entropy();
  const contribution = await sealMemberContribution({ drawId, memberId: contributor.memberId, nonce: memberNonce }, webDrawHasher);
  const commitment = await createCommitment(
    {
      groupId: GROUP_ID,
      cycleId: CYCLE_ID,
      round,
      totalRounds,
      drawId,
      commitmentNonce: entropy(),
      seed,
      memberCommitments: [contribution],
      potAmount: "25000.00",
      reserveRatioBps: 1000,
      members: [...members],
      priorWinnerIds: [],
      committedBy: "local-treasurer",
      committedAt: new Date().toISOString(),
      idempotencyKey: `local-commit-${drawId}`
    },
    webDrawHasher
  );
  const opened = await openReveal(
    commitment,
    {
      seed,
      memberNonces: [{ memberId: contributor.memberId, nonce: memberNonce }],
      revealedBy: "local-treasurer",
      revealedAt: new Date().toISOString()
    },
    webDrawHasher
  );
  const asRound: DrawRound = { ...commitment, state: "revealed", reveal: opened.reveal, payout: null };
  const checked = await verifyRound(asRound, {}, webDrawHasher);
  return { winnerMemberId: opened.reveal.winnerMemberId, verified: checked.verified };
}
