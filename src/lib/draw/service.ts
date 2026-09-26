import { randomUUID } from "node:crypto";

import { isLedgerError, LedgerService, type LedgerEntry } from "@/lib/ledger";
import { nodeDrawHasher, toVerificationTranscript } from "./canonical";
import { createCommitment, openReveal, verifyRound, type CommitRequest } from "./engine";
import { DrawError } from "./errors";
import {
  assertNotPriorWinner,
  excludePriorWinners,
  rotationExhausted
} from "./rotation";
import { mapDrawError, type DrawActorContext, type DrawRepository } from "./repository";
import type {
  DrawHasher,
  DrawMember,
  DrawRiskAssessment,
  DrawRound,
  DrawVerificationResult
} from "./types";

export interface DrawServiceOptions {
  readonly hasher?: DrawHasher;
  readonly clock?: () => Date;
  readonly drawIdFactory?: () => string;
  /**
   * Supplies the commitment nonce and the seed. Both must come from a
   * cryptographically secure source. The default uses `node:crypto`; a caller
   * that cannot provide real entropy must not pass a predictable factory, which
   * is why the entropy floor is enforced in `createCommitment` rather than here.
   */
  readonly entropyFactory?: () => string;
}

function defaultEntropy(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
}

export interface DrawCommitResult {
  readonly round: DrawRound;
  readonly replayed: boolean;
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
  readonly occurredAt?: string;
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
 * deliberately absent: both are derived from the verified actor and the
 * service clock, so a client cannot claim a draw was committed by someone else
 * or backdate it.
 */
export type CommitDrawInput = Omit<
  CommitRequest,
  "drawId" | "commitmentNonce" | "seed" | "committedBy" | "committedAt"
> & {
  readonly drawId?: string;
  readonly commitmentNonce?: string;
  readonly seed?: string;
  readonly committedAt?: string;
};

export class DrawService {
  private readonly hasher: DrawHasher;
  private readonly clock: () => Date;
  private readonly drawIdFactory: () => string;
  private readonly entropyFactory: () => string;

  constructor(
    private readonly repository: DrawRepository,
    private readonly ledger: LedgerService,
    options: DrawServiceOptions = {}
  ) {
    this.hasher = options.hasher ?? nodeDrawHasher;
    this.clock = options.clock ?? (() => new Date());
    this.drawIdFactory = options.drawIdFactory ?? randomUUID;
    this.entropyFactory = options.entropyFactory ?? defaultEntropy;
  }

  async commit(request: CommitDrawInput, context: DrawActorContext): Promise<DrawCommitResult> {
    try {
      /**
       * A plain retry must replay the original commitment, not mint a second
       * seed and then collide with itself under the same idempotency key.
       *
       * Only the retry shape short-circuits. When the caller supplies an
       * explicit `drawId` or `seed` it is deliberately saying "this is a
       * specific draw", and a differing payload under a reused key is a genuine
       * conflict that the repository's fingerprint comparison must catch —
       * exactly like `LedgerService.append`.
       */
      const isPlainRetry = request.drawId === undefined && request.seed === undefined;
      if (isPlainRetry) {
        const existing = await this.repository.findByIdempotencyKey(
          request.groupId,
          request.idempotencyKey,
          context
        );
        if (existing !== null) {
          return { round: existing, replayed: true };
        }
      }

      const commitment = await createCommitment(
        {
          ...request,
          drawId: request.drawId ?? this.drawIdFactory(),
          commitmentNonce: request.commitmentNonce ?? this.entropyFactory(),
          seed: request.seed ?? this.entropyFactory(),
          committedBy: context.userId,
          committedAt: request.committedAt ?? this.clock().toISOString()
        },
        this.hasher
      );
      const stored = await this.repository.saveCommitment(commitment, context);
      return {
        round: stored.round,
        replayed: stored.replayed
      };
    } catch (error) {
      throw mapDrawError(error);
    }
  }

  async reveal(
    input: { readonly drawId: string; readonly seed: string },
    context: DrawActorContext
  ): Promise<DrawRevealResult> {
    try {
      const round = await this.requireRound(input.drawId, context);
      if (round.state !== "committed") {
        throw new DrawError("ALREADY_REVEALED", "This draw has already been revealed");
      }
      if (round.reveal !== null) {
        throw new DrawError("ALREADY_REVEALED", "This draw has already been revealed");
      }

      const cycle = await this.repository.listCycle(round.cycleId, context);
      const priorWinnerIds = cycle
        .filter((entry) => entry.round < round.round && entry.reveal !== null)
        .map((entry) => entry.reveal?.winnerMemberId ?? "");

      const { reveal, risk } = await openReveal(
        round,
        {
          seed: input.seed,
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
          occurredAt: request.occurredAt ?? this.clock().toISOString(),
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
