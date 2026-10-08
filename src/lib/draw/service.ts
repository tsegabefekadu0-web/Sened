import { randomUUID } from "node:crypto";

import { isLedgerError, LedgerService, type LedgerEntry } from "@/lib/ledger";
import { toVerificationTranscript } from "./canonical";
import { nodeDrawHasher } from "./nodeHasher";
import { createCommitment, openReveal, verifyRound, type CommitRequest } from "./engine";
import { DrawError } from "./errors";
import {
  assertNotPriorWinner,
  excludePriorWinners,
  rotationExhausted
} from "./rotation";
import { mapDrawError, type DrawActorContext, type DrawRepository } from "./repository";
import type {
  DrawCancellation,
  DrawContributionGate,
  DrawCycleRecord,
  DrawHasher,
  DrawListEntry,
  DrawMember,
  DrawMemberNonce,
  DrawCommitGate,
  DrawOpenGate,
  DrawRiskAssessment,
  DrawRound,
  DrawSessionView,
  DrawVerificationResult
} from "./types";

export interface DrawServiceOptions {
  readonly hasher?: DrawHasher;
  readonly clock?: () => Date;
  readonly drawIdFactory?: () => string;
}

export interface DrawCommitResult {
  readonly round: DrawRound;
  readonly replayed: boolean;
  /** What the gate found at commit; absent on a replay (nothing new was committed). */
  readonly gate?: DrawCommitGate | null;
}

export interface DrawRevealResult {
  readonly round: DrawRound;
  readonly risk: DrawRiskAssessment;
  readonly verification: DrawVerificationResult;
}

export interface DrawVerifyResult {
  readonly round: DrawRound;
  readonly verification: DrawVerificationResult;
  /** Everything a member needs to recompute the draw without trusting us. */
  readonly transcript: ReturnType<typeof toVerificationTranscript>;
}

export interface DrawPayoutRequest {
  readonly drawId: string;
  /** Cash/asset account the pot leaves. */
  readonly cashAccountId: string;
  /** Expense account that absorbs the discharged obligation. */
  readonly payoutAccountId: string;
}

export interface DrawPayoutResult {
  readonly round: DrawRound;
  readonly ledgerEntry: LedgerEntry;
  readonly replayed: boolean;
}

export interface DrawCycleSummary {
  readonly cycleId: string;
  readonly totalRounds: number;
  readonly committed: number;
  readonly revealed: number;
  readonly paid: number;
  readonly winners: readonly { readonly round: number; readonly memberId: string; readonly amount: string }[];
  readonly unclaimedWinnerIds: readonly string[];
  readonly rotationExhausted: boolean;
  readonly remainingEligible: number;
}

/**
 * Deterministic idempotency key for a draw payout.
 *
 * Derived from the commitment rather than from a timestamp or a counter so a
 * treasurer who double-taps "pay" — or retries after a dropped connection —
 * replays onto the same ledger entry instead of paying the winner twice. The
 * ledger keys idempotency on `(groupId, idempotencyKey)` and fingerprints the
 * whole request, so a *different* amount under the same key is rejected with
 * `IDEMPOTENCY_CONFLICT` rather than silently double-paid.
 */
export function payoutIdempotencyKey(commitment: string): string {
  return `draw-payout.${commitment}`;
}

/**
 * What a caller supplies to open a draw. `committedBy` and `committedAt` are
 * deliberately absent: the actor is the verified user and the commit time is the
 * database's own clock, so a client cannot claim a draw was committed by someone
 * else or backdate it. The seed and the commitment nonce are REQUIRED and come from
 * the treasurer's device: a seed generated here would never be returned, and a draw
 * whose seed nobody holds can never be revealed.
 */
export type CommitDrawInput = Omit<
  CommitRequest,
  "drawId" | "commitmentNonce" | "seed" | "committedBy" | "committedAt" | "protocolVersion"
> & {
  readonly drawId?: string;
  readonly commitmentNonce: string;
  readonly seed: string;
  /** Only meaningful under a `block` gate with something flagged at commit: the recorded reason (10..1000). */
  readonly overrideReason?: string;
};

export class DrawService {
  private readonly hasher: DrawHasher;
  private readonly clock: () => Date;
  private readonly drawIdFactory: () => string;

  constructor(
    private readonly repository: DrawRepository,
    private readonly ledger: LedgerService,
    options: DrawServiceOptions = {}
  ) {
    this.hasher = options.hasher ?? nodeDrawHasher;
    this.clock = options.clock ?? (() => new Date());
    this.drawIdFactory = options.drawIdFactory ?? randomUUID;
  }

  async commit(request: CommitDrawInput, context: DrawActorContext): Promise<DrawCommitResult> {
    try {
      const { overrideReason, ...engineRequest } = request;
      const commitment = await createCommitment(
        {
          ...engineRequest,
          drawId: request.drawId ?? this.drawIdFactory(),
          committedBy: context.userId,
          // Informational only: the database stamps the real commit time (clock_timestamp()).
          committedAt: this.clock().toISOString()
        },
        this.hasher
      );
      const stored = await this.repository.saveCommitment(
        commitment,
        context,
        overrideReason === undefined ? {} : { overrideReason }
      );
      return {
        round: stored.round,
        replayed: stored.replayed,
        gate: stored.gate
      };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /**
   * M4.1 step 2. The seed comes from the caller; the member nonces do NOT.
   *
   * `requestReveal` asks the database to check the seed against the published
   * commitment and then publish the seed and the nonces members released, in one
   * step. Those are what the winner is derived from, and what the database then
   * insists the reveal row carries. A caller that holds the seed learns nothing
   * about the nonces until they have been made public to the whole group.
   *
   * A draw committed before server-created draws existed has no stored nonces
   * (`requestReveal` returns null); only then are caller-supplied `memberNonces`
   * used, which the route never passes.
   */
  async reveal(
    input: {
      readonly drawId: string;
      /**
       * The treasurer's seed. Omit it when the reveal was already opened: the seed was published
       * then, so any owner or treasurer can finish the draw, and a stalled one cannot be abandoned.
       */
      readonly seed?: string;
      readonly memberNonces?: readonly DrawMemberNonce[];
    },
    context: DrawActorContext
  ): Promise<DrawRevealResult> {
    try {
      const round = await this.requireRound(input.drawId, context);
      let seed = input.seed;
      if (seed === undefined) {
        const session = await this.repository.getSession(input.drawId, context);
        seed = session.revealOpening?.seed;
        if (seed === undefined) {
          throw new DrawError(
            "INVALID_REQUEST",
            "The seed is required: the reveal has not been opened, so no seed has been published"
          );
        }
      }
      if (round.state !== "committed") {
        throw new DrawError("ALREADY_REVEALED", "This draw has already been revealed");
      }
      if (round.reveal !== null) {
        throw new DrawError("ALREADY_REVEALED", "This draw has already been revealed");
      }

      const opened = await this.repository.requestReveal(
        { drawId: input.drawId, seed },
        context
      );
      const memberNonces = opened?.memberNonces ?? input.memberNonces;
      if (memberNonces === undefined) {
        throw new DrawError(
          "MEMBER_COMMITMENT_MISSING",
          "There are no member nonces to open this draw with"
        );
      }

      const cycle = await this.repository.listCycle(round.cycleId, context);
      const priorWinnerIds = cycle
        .filter((entry) => entry.round < round.round && entry.reveal !== null)
        .map((entry) => entry.reveal?.winnerMemberId ?? "");

      const { reveal, risk } = await openReveal(
        round,
        {
          seed,
          memberNonces,
          revealedBy: context.userId,
          revealedAt: this.clock().toISOString()
        },
        this.hasher
      );

      // Defence in depth. The roster already excluded prior winners, so this can
      // only fire if the stored commitment was tampered with outside the app.
      assertNotPriorWinner(reveal.winnerMemberId, priorWinnerIds);

      const saved = await this.repository.saveReveal(reveal, context);
      const verification = await this.verifyRoundInternal(saved, context);
      return { round: saved, risk, verification };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async verify(drawId: string, context: DrawActorContext): Promise<DrawVerifyResult> {
    try {
      const round = await this.requireRound(drawId, context);
      const verification = await this.verifyRoundInternal(round, context);
      return { round, verification, transcript: toVerificationTranscript(round) };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  private async verifyRoundInternal(
    round: DrawRound,
    context: DrawActorContext
  ): Promise<DrawVerificationResult> {
    const superseded = await this.repository.countSupersededCommitments(round.drawId, context);
    return verifyRound(round, { supersededCommitmentCount: superseded }, this.hasher);
  }

  /**
   * Posts the draw payout to the ledger and links it back to the draw.
   *
   * Three gates stand in front of the money, and all three fail closed:
   *   1. the draw must be revealed,
   *   2. independent verification must reproduce the same winner, and
   *   3. the winner must not already have been drawn this cycle.
   *
   * The postings go through `LedgerService.append` — never a direct write to
   * `ledger_entries` — so the hash chain and Σ debits = Σ credits hold exactly
   * as they do for every other entry in the product.
   */
  async postPayout(
    request: DrawPayoutRequest,
    context: DrawActorContext
  ): Promise<DrawPayoutResult> {
    try {
      const round = await this.requireRound(request.drawId, context);
      if (round.reveal === null) {
        throw new DrawError(
          "NOT_COMMITTED",
          "A draw must be revealed before a payout can be posted"
        );
      }
      if (round.payout !== null) {
        throw new DrawError(
          "IDEMPOTENCY_CONFLICT",
          "A payout has already been posted for this draw"
        );
      }

      const verification = await this.verifyRoundInternal(round, context);
      if (!verification.verified) {
        throw new DrawError(
          "COMMITMENT_MISMATCH",
          `The draw does not verify (${verification.codes.join(", ")}). Refusing to post a payout.`
        );
      }
      if (verification.winnerMemberId !== round.reveal.winnerMemberId) {
        throw new DrawError(
          "INTEGRITY_FAILURE",
          "The verified winner does not match the recorded winner. Refusing to post a payout."
        );
      }

      const cycle = await this.repository.listCycle(round.cycleId, context);
      const priorWinnerIds = cycle
        .filter((entry) => entry.round < round.round && entry.payout !== null)
        .map((entry) => entry.payout?.winnerMemberId ?? "");
      assertNotPriorWinner(round.reveal.winnerMemberId, priorWinnerIds);

      const amount = round.reveal.payoutAmount;
      const result = await this.ledger.append(
        {
          groupId: round.groupId,
          idempotencyKey: payoutIdempotencyKey(round.commitment),
          // Derived from the reveal, never from the clock: a retry after a partial failure must
          // produce the same request, or the ledger answers IDEMPOTENCY_CONFLICT.
          occurredAt: round.reveal.revealedAt,
          entryType: "disbursement",
          postings: [
            { accountId: request.payoutAccountId, direction: "debit", amount },
            { accountId: request.cashAccountId, direction: "credit", amount }
          ]
        },
        { actorId: context.userId }
      );

      const saved = await this.repository.savePayout(
        {
          drawId: round.drawId,
          ledgerEntryId: result.entry.id,
          winnerMemberId: round.reveal.winnerMemberId,
          amount,
          reserveAmount: round.reveal.reserveAmount,
          postedAt: result.entry.recordedAt,
          postedBy: context.userId
        },
        context
      );

      return { round: saved, ledgerEntry: result.entry, replayed: result.replayed };
    } catch (error) {
      if (isLedgerError(error)) {
        // Preserve the ledger's own guarantees rather than flattening them into
        // a generic storage failure. A duplicate payout must read as a conflict.
        throw new DrawError(
          error.code === "IDEMPOTENCY_CONFLICT"
            ? "IDEMPOTENCY_CONFLICT"
            : error.code === "NOT_FOUND"
              ? "NOT_FOUND"
              : error.code === "FORBIDDEN"
                ? "FORBIDDEN"
                : error.code === "UNAVAILABLE"
                  ? "UNAVAILABLE"
                  : "INTEGRITY_FAILURE",
          `Ledger refused the draw payout: ${error.message}`,
          error
        );
      }
      throw mapDrawError(error);
    }
  }

  // -- cycles and draws ------------------------------------------------------------

  /** Owner or treasurer (decided by the database). */
  async createCycle(
    input: {
      readonly groupId: string;
      readonly name: string;
      readonly contributionAmount: string;
      readonly totalRounds: number;
      readonly reserveRatioBps: number;
      readonly startedAt?: string;
      readonly idempotencyKey: string;
      readonly contributionGate?: DrawContributionGate;
      readonly sealWindowHours?: number;
      readonly nonceWindowHours?: number;
    },
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly replayed: boolean }> {
    try {
      return await this.repository.createCycle(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /** Owner or treasurer (decided by the database): change the cycle's contribution gate, with a reason. */
  async setContributionGate(
    input: { readonly cycleId: string; readonly gate: DrawContributionGate; readonly reason: string },
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly replayed: boolean }> {
    try {
      return await this.repository.setContributionGate(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async listCycles(groupId: string, context: DrawActorContext): Promise<readonly DrawCycleRecord[]> {
    try {
      return await this.repository.listCycles(groupId, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async getCycleDetail(
    cycleId: string,
    context: DrawActorContext
  ): Promise<{
    readonly cycle: DrawCycleRecord;
    readonly draws: readonly DrawListEntry[];
    readonly cancellations: readonly DrawCancellation[];
  }> {
    try {
      const detail = await this.repository.getCycleDetail(cycleId, context);
      const cancellations = await this.repository.listCancellations(cycleId, context);
      return { ...detail, cancellations };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /**
   * Owner or treasurer cancels a draw whose members did not respond. Allowed only after the
   * seal deadline (still sealing) or the nonce-release deadline (committed, a nonce missing, the
   * reveal NOT opened); a third cancel in one round needs a group owner. The database decides;
   * this only carries the reason. Append-only and visible to every member.
   */
  async cancelDraw(
    input: { readonly drawId: string; readonly reason: string },
    context: DrawActorContext
  ): Promise<{ readonly cancellation: DrawCancellation; readonly replayed: boolean }> {
    try {
      return await this.repository.cancelDraw(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /** Owner or treasurer. The draw id is created by the server. */
  async openDraw(
    input: {
      readonly cycleId: string;
      readonly round?: number;
      readonly idempotencyKey: string;
      readonly overrideReason?: string;
      readonly excludeMissed?: boolean;
    },
    context: DrawActorContext
  ): Promise<{ readonly session: DrawSessionView; readonly replayed: boolean; readonly gate: DrawOpenGate | null }> {
    try {
      return await this.repository.openDraw(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async getSession(drawId: string, context: DrawActorContext): Promise<DrawSessionView> {
    try {
      return await this.repository.getSession(drawId, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /** A member seals for themselves. The acting member is `context.userId`, never an argument. */
  async submitSeal(
    input: { readonly drawId: string; readonly sealed: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly sealed: string; readonly replaced: boolean }> {
    try {
      return await this.repository.submitSeal(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /** A member releases their own nonce, after the commitment. The nonce is not echoed. */
  async submitNonce(
    input: { readonly drawId: string; readonly nonce: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly replayed: boolean }> {
    try {
      return await this.repository.submitNonce(input, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /**
   * M4.1 step 1, from a server-created draw.
   *
   * Nothing the engine commits to is typed by the caller. The roster is the draw's
   * eligible members (active, not yet drawn this cycle) at the cycle's
   * contribution; the pot, the reserve and the rounds are the cycle's; the sealed
   * set is what the members stored. The caller supplies only the treasurer's own
   * entropy (seed, commitment nonce) and an idempotency key. The database checks
   * the result against the same sources again, so this is not the only line of
   * defence.
   */
  async commitFromSession(
    input: {
      readonly drawId: string;
      /** From the treasurer's device. Required: a seed nobody holds can never be revealed. */
      readonly seed: string;
      readonly commitmentNonce: string;
      readonly idempotencyKey: string;
      readonly overrideReason?: string;
    },
    context: DrawActorContext
  ): Promise<DrawCommitResult> {
    try {
      const session = await this.repository.getSession(input.drawId, context);

      if (session.state === "cancelled") {
        throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
      }

      // A retry of a commit that already went through replays it.
      const existing = await this.repository.findByIdempotencyKey(
        session.groupId,
        input.idempotencyKey,
        context
      );
      if (existing !== null && existing.drawId === session.drawId) {
        return { round: existing, replayed: true };
      }

      // QUORUM: every eligible member must have sealed (the database enforces the same).
      const sealedIds = new Set(session.seals.map((seal) => seal.memberId));
      const unsealed = session.eligible.filter((memberId) => !sealedIds.has(memberId));
      if (unsealed.length > 0) {
        throw new DrawError(
          "MEMBER_COMMITMENT_MISSING",
          `${unsealed.length} of ${session.eligible.length} eligible members have not sealed`
        );
      }

      const contribution = session.cycle.contributionAmount;
      if (contribution === null) {
        throw new DrawError(
          "INVALID_REQUEST",
          "This cycle has no per-member contribution on record, so a draw cannot be committed for it. Create a new cycle."
        );
      }
      const eligible = new Set(session.eligible);
      const members: DrawMember[] = session.eligible.map((memberId) => ({
        memberId,
        // Display names are presentation and are not part of the roster digest.
        // An email is never published here: members have not agreed to show it.
        displayName: `Member ${memberId.slice(0, 8)}`,
        status: "active",
        contributionAmount: contribution
      }));

      return await this.commit(
        {
          groupId: session.groupId,
          cycleId: session.cycleId,
          round: session.round,
          totalRounds: session.cycle.totalRounds,
          drawId: session.drawId,
          seed: input.seed,
          commitmentNonce: input.commitmentNonce,
          memberCommitments: session.seals
            .filter((seal) => eligible.has(seal.memberId))
            .map((seal) => ({ memberId: seal.memberId, sealed: seal.sealed })),
          potAmount: session.cycle.potAmount,
          reserveRatioBps: session.cycle.reserveRatioBps,
          members,
          priorWinnerIds: [],
          minMemberCommitments: session.eligible.length,
          idempotencyKey: input.idempotencyKey,
          overrideReason: input.overrideReason
        },
        context
      );
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async getRound(drawId: string, context: DrawActorContext): Promise<DrawRound> {
    try {
      return await this.requireRound(drawId, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async listCycle(cycleId: string, context: DrawActorContext): Promise<readonly DrawRound[]> {
    try {
      return await this.repository.listCycle(cycleId, context);
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  /**
   * Whole-cycle view. This is where rotation becomes visible: every winner of
   * the cycle is listed, and any member who has already won is excluded from
   * the remaining eligible pool.
   */
  async cycleSummary(
    request: { readonly cycleId: string; readonly members: readonly DrawMember[] },
    context: DrawActorContext
  ): Promise<DrawCycleSummary> {
    try {
      const rounds = await this.repository.listCycle(request.cycleId, context);
      const winners = rounds
        .filter((round) => round.reveal !== null)
        .map((round) => ({
          round: round.round,
          memberId: round.reveal?.winnerMemberId ?? "",
          amount: round.reveal?.payoutAmount ?? "0.00"
        }))
        .sort((left, right) => left.round - right.round);

      const winnerIds = winners.map((winner) => winner.memberId);
      const remaining = excludePriorWinners(request.members, winnerIds);
      const totalRounds = rounds.reduce((max, round) => Math.max(max, round.totalRounds), 0);

      return {
        cycleId: request.cycleId,
        totalRounds,
        committed: rounds.length,
        revealed: rounds.filter((round) => round.reveal !== null).length,
        paid: rounds.filter((round) => round.payout !== null).length,
        winners,
        unclaimedWinnerIds: winnerIds,
        rotationExhausted: rotationExhausted(request.members, winnerIds),
        remainingEligible: remaining.length
      };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  private async requireRound(drawId: string, context: DrawActorContext): Promise<DrawRound> {
    const round = await this.repository.getRound(drawId, context);
    if (round === null) {
      throw new DrawError("NOT_FOUND", "No draw exists for that identifier");
    }
    return round;
  }
}
