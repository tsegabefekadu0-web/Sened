import type { SupabaseClient } from "@supabase/supabase-js";

import { DrawError, isDrawError } from "./errors";
import { DRAW_CURRENT_PROTOCOL_VERSION, isDrawProtocolVersion, type DrawErrorCode } from "./types";
import type {
  DrawCommitment,
  DrawPayout,
  DrawReveal,
  DrawRound
} from "./types";

export interface DrawActorContext {
  readonly userId: string;
}

export interface DrawRepository {
  saveCommitment(
    commitment: DrawCommitment,
    context: DrawActorContext
  ): Promise<{ readonly round: DrawRound; readonly replayed: boolean }>;
  saveReveal(reveal: DrawReveal, context: DrawActorContext): Promise<DrawRound>;
  savePayout(payout: DrawPayout, context: DrawActorContext): Promise<DrawRound>;
  getRound(drawId: string, context: DrawActorContext): Promise<DrawRound | null>;
  /**
   * Look a round up by its idempotency key.
   *
   * This exists because the seed is generated server-side and is never
   * returned before the reveal. A treasurer whose commit request times out and
   * retries would otherwise mint a *second* seed, produce a different
   * commitment under the same key, and be told the request conflicts with
   * itself. Short-circuiting on the key first is what makes a retry a replay.
   */
  findByIdempotencyKey(
    groupId: string,
    idempotencyKey: string,
    context: DrawActorContext
  ): Promise<DrawRound | null>;
  listCycle(cycleId: string, context: DrawActorContext): Promise<readonly DrawRound[]>;
  /**
   * How many commitments for this round were created and then abandoned. One is
   * the live commitment; anything above that is the signature of a treasurer
   * searching seeds for a preferred winner.
   */
  countSupersededCommitments(drawId: string, context: DrawActorContext): Promise<number>;
}

export interface InMemoryDrawRepositoryOptions {
  readonly clock?: () => Date;
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DrawError("INVALID_REQUEST", `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export class InMemoryDrawRepository implements DrawRepository {
  private readonly commitments = new Map<string, DrawCommitment>();
  private readonly commitmentKeys = new Map<string, string>();
  private readonly commitmentsPerRound = new Map<string, number>();
  private readonly reveals = new Map<string, DrawReveal>();
  private readonly payouts = new Map<string, DrawPayout>();
  private readonly clock: () => Date;

  constructor(options: InMemoryDrawRepositoryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  private project(commitment: DrawCommitment): DrawRound {
    const reveal = this.reveals.get(commitment.drawId) ?? null;
    const payout = this.payouts.get(commitment.drawId) ?? null;
    return {
      ...commitment,
      state: payout !== null ? "paid" : reveal !== null ? "revealed" : "committed",
      reveal,
      payout
    };
  }

  async saveCommitment(
    commitment: DrawCommitment,
    context: DrawActorContext
  ): Promise<{ readonly round: DrawRound; readonly replayed: boolean }> {
    requireUuid(context.userId, "userId");
    requireUuid(commitment.drawId, "drawId");
    requireUuid(commitment.groupId, "groupId");
    // Mirrors the database: a new commitment must be the current protocol. v2
    // let the treasurer grind the winner, so it is readable but never writable.
    if (commitment.protocolVersion !== DRAW_CURRENT_PROTOCOL_VERSION) {
      throw new DrawError(
        "INVALID_REQUEST",
        `New draws must use protocol ${DRAW_CURRENT_PROTOCOL_VERSION}; ${commitment.protocolVersion} is read-only history.`
      );
    }

    const key = `${commitment.groupId}:${commitment.idempotencyKey}`;
    const existingDrawId = this.commitmentKeys.get(key);
    if (existingDrawId !== undefined) {
      const existing = this.commitments.get(existingDrawId);
      if (existing !== undefined) {
        if (existing.commitment !== commitment.commitment) {
          throw new DrawError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different commitment"
          );
        }
        return { round: this.project(existing), replayed: true };
      }
    }

    if (this.commitments.has(commitment.drawId)) {
      const existing = this.commitments.get(commitment.drawId);
      if (existing !== undefined && existing.commitment !== commitment.commitment) {
        throw new DrawError(
          "ALREADY_COMMITTED",
          "This draw already has a different commitment recorded"
        );
      }
    }

    this.commitments.set(commitment.drawId, commitment);
    this.commitmentKeys.set(key, commitment.drawId);
    const roundKey = `${commitment.cycleId}:${commitment.round}`;
    this.commitmentsPerRound.set(roundKey, (this.commitmentsPerRound.get(roundKey) ?? 0) + 1);
    void this.clock();
    return { round: this.project(commitment), replayed: false };
  }

  async saveReveal(reveal: DrawReveal, context: DrawActorContext): Promise<DrawRound> {
    requireUuid(context.userId, "userId");
    const commitment = this.commitments.get(reveal.drawId);
    if (commitment === undefined) {
      throw new DrawError("NOT_COMMITTED", "There is no commitment to reveal for this draw");
    }
    if (reveal.commitment !== commitment.commitment) {
      throw new DrawError(
        "COMMITMENT_MISMATCH",
        "The reveal does not carry the commitment that was recorded"
      );
    }
    const existing = this.reveals.get(reveal.drawId);
    if (existing !== undefined && existing.transcriptDigest !== reveal.transcriptDigest) {
      throw new DrawError(
        "ALREADY_REVEALED",
        "This draw has already been revealed with a different transcript"
      );
    }
    this.reveals.set(reveal.drawId, reveal);
    return this.project(commitment);
  }

  async savePayout(payout: DrawPayout, context: DrawActorContext): Promise<DrawRound> {
    requireUuid(context.userId, "userId");
    const commitment = this.commitments.get(payout.drawId);
    if (commitment === undefined) {
      throw new DrawError("NOT_COMMITTED", "There is no commitment for this draw");
    }
    if (!this.reveals.has(payout.drawId)) {
      throw new DrawError(
        "NOT_COMMITTED",
        "A draw must be revealed before a payout can be posted"
      );
    }
    this.payouts.set(payout.drawId, payout);
    return this.project(commitment);
  }

  async getRound(drawId: string, context: DrawActorContext): Promise<DrawRound | null> {
    requireUuid(context.userId, "userId");
    const commitment = this.commitments.get(drawId.toLowerCase());
    return commitment === undefined ? null : this.project(commitment);
  }

  async findByIdempotencyKey(
    groupId: string,
    idempotencyKey: string,
    context: DrawActorContext
  ): Promise<DrawRound | null> {
    requireUuid(context.userId, "userId");
    const drawId = this.commitmentKeys.get(`${groupId.toLowerCase()}:${idempotencyKey}`);
    if (drawId === undefined) {
      return null;
    }
    const commitment = this.commitments.get(drawId);
    return commitment === undefined ? null : this.project(commitment);
  }

  async listCycle(cycleId: string, context: DrawActorContext): Promise<readonly DrawRound[]> {
    requireUuid(context.userId, "userId");
    return Array.from(this.commitments.values())
      .filter((commitment) => commitment.cycleId === cycleId.toLowerCase())
      .map((commitment) => this.project(commitment))
      .sort((left, right) => left.round - right.round);
  }

  async countSupersededCommitments(
    drawId: string,
    context: DrawActorContext
  ): Promise<number> {
    requireUuid(context.userId, "userId");
    const commitment = this.commitments.get(drawId.toLowerCase());
    if (commitment === undefined) {
      return 0;
    }
    const created = this.commitmentsPerRound.get(`${commitment.cycleId}:${commitment.round}`) ?? 0;
    return Math.max(0, created - 1);
  }
}

function mapSupabaseError(error: { readonly code?: string; readonly message?: string } | null): DrawError {
  const message = error?.message ?? "draw_storage_failure";
  const tableMissing = error?.code === "PGRST202" || error?.code === "42P01";
  const unavailable = error?.code === "57014" || tableMissing;

  if (message === "draw_group_not_found") return new DrawError("NOT_FOUND", message);
  if (message === "draw_forbidden") return new DrawError("FORBIDDEN", message);
  if (message === "draw_idempotency_conflict") return new DrawError("IDEMPOTENCY_CONFLICT", message);
  if (message === "draw_repeat_winner") return new DrawError("REPEAT_WINNER", message);
  if (message === "draw_no_eligible_participants") {
    return new DrawError("NO_ELIGIBLE_PARTICIPANTS", message);
  }
  if (message === "draw_commitment_mismatch") return new DrawError("COMMITMENT_MISMATCH", message);
  if (message === "draw_protocol_version_unsupported") return new DrawError("INVALID_REQUEST", message);
  if (message === "draw_member_commitment_missing") return new DrawError("MEMBER_COMMITMENT_MISSING", message);
  if (message === "draw_member_commitment_mismatch") return new DrawError("MEMBER_COMMITMENT_MISMATCH", message);
  if (message === "draw_already_revealed") return new DrawError("ALREADY_REVEALED", message);
  if (message === "draw_not_committed") return new DrawError("NOT_COMMITTED", message);
  // Enforced by the database, not the application: the winner must be the
  // member standing at selected_index in the committed ticket order, and the
  // two digests are never taken on trust from the caller.
  if (message === "draw_winner_binding_mismatch") return new DrawError("INTEGRITY_FAILURE", message);
  if (message === "draw_winning_ticket_mismatch") return new DrawError("INTEGRITY_FAILURE", message);
  if (message === "draw_payout_amount_mismatch") return new DrawError("INTEGRITY_FAILURE", message);
  if (message === "draw_payout_split_mismatch") return new DrawError("INTEGRITY_FAILURE", message);
  if (message === "draw_selection_out_of_range") return new DrawError("INVALID_REQUEST", message);
  // Rotation is only sound if rounds are revealed in ascending order, because
  // every prior-winner check looks backwards.
  if (message === "draw_round_out_of_order") return new DrawError("ROUND_OUT_OF_ORDER", message);
  if (message === "draw_not_revealed") return new DrawError("NOT_COMMITTED", message);
  if (unavailable) return new DrawError("UNAVAILABLE", "draw_tables_unavailable");
  return new DrawError("STORAGE_FAILURE", message);
}

function parseRound(value: unknown): DrawRound {
  if (typeof value !== "object" || value === null) {
    throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed row");
  }
  const row = value as Record<string, unknown>;
  const commitment = row.commitment;
  if (typeof commitment !== "object" || commitment === null) {
    throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned no commitment");
  }
  const parsed = commitment as Record<string, unknown>;
  const reveal = (row.reveal ?? null) as DrawReveal | null;
  const payout = (row.payout ?? null) as DrawPayout | null;

  return {
    drawId: String(parsed.drawId),
    groupId: String(parsed.groupId),
    cycleId: String(parsed.cycleId),
    round: Number(parsed.round),
    commitment: String(parsed.commitment),
    // Rows from before the protocol column existed are v2 by definition.
    protocolVersion: isDrawProtocolVersion(parsed.protocolVersion) ? parsed.protocolVersion : "v2",
    commitmentNonce: String(parsed.commitmentNonce),
    memberDigest: String(parsed.memberDigest ?? ""),
    memberCommitments: (parsed.memberCommitments ?? []) as DrawRound["memberCommitments"],
    rosterDigest: String(parsed.rosterDigest),
    participants: (parsed.participants ?? []) as DrawRound["participants"],
    potAmount: String(parsed.potAmount),
    totalRounds: Number(parsed.totalRounds),
    reserveRatioBps: Number(parsed.reserveRatioBps),
    committedBy: String(parsed.committedBy),
    committedAt: String(parsed.committedAt),
    idempotencyKey: String(parsed.idempotencyKey),
    state: payout !== null ? "paid" : reveal !== null ? "revealed" : "committed",
    reveal,
    payout
  };
}

export class SupabaseDrawRepository implements DrawRepository {
  constructor(private readonly client: SupabaseClient) {}

  async saveCommitment(
    commitment: DrawCommitment,
    context: DrawActorContext
  ): Promise<{ readonly round: DrawRound; readonly replayed: boolean }> {
    const { data, error } = await this.client.rpc("commit_draw_v1", {
      p_group_id: commitment.groupId,
      p_cycle_id: commitment.cycleId,
      p_round: commitment.round,
      p_draw_id: commitment.drawId,
      p_commitment: commitment.commitment,
      p_commitment_nonce: commitment.commitmentNonce,
      p_roster_digest: commitment.rosterDigest,
      // The member contributions are what make the draw fair rather than merely
      // honest, so they go to the database with the commitment. The RPC refuses
      // an empty set: reaching this function without them would produce exactly
      // the row the fairness property depends on not existing.
      p_member_digest: commitment.memberDigest,
      p_member_commitments: commitment.memberCommitments.map((contribution) => ({
        ...contribution
      })),
      p_participants: commitment.participants.map((participant) => ({ ...participant })),
      p_pot_amount: commitment.potAmount,
      p_total_rounds: commitment.totalRounds,
      p_reserve_ratio_bps: commitment.reserveRatioBps,
      p_idempotency_key: commitment.idempotencyKey,
      p_occurred_at: commitment.committedAt,
      // Pinned in the database so the derivation cannot be relabelled later.
      p_protocol_version: commitment.protocolVersion
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    const payload = data as { readonly round?: unknown; readonly replayed?: unknown } | null;
    if (typeof payload?.replayed !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed commit result");
    }
    return { round: parseRound(payload.round), replayed: payload.replayed };
  }

  async saveReveal(reveal: DrawReveal, context: DrawActorContext): Promise<DrawRound> {
    const { data, error } = await this.client.rpc("reveal_draw_v1", {
      p_draw_id: reveal.drawId,
      p_seed: reveal.seed,
      p_commitment: reveal.commitment,
      // Every member nonce travels with the seed. A member verifying the draw
      // needs them to check each nonce against the hash that was sealed, and the
      // RPC refuses a reveal that opens fewer than were sealed.
      p_member_digest: reveal.memberDigest,
      p_member_nonces: reveal.memberNonces.map((entry) => ({ ...entry })),
      p_transcript_digest: reveal.transcriptDigest,
      p_selection_digest: reveal.selectionDigest,
      p_selected_index: reveal.selectedIndex,
      p_winner_member_id: reveal.winnerMemberId,
      p_winning_ticket: reveal.winningTicket,
      p_payout_amount: reveal.payoutAmount,
      p_reserve_amount: reveal.reserveAmount,
      p_occurred_at: reveal.revealedAt
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseRound(data);
  }

  async savePayout(payout: DrawPayout, context: DrawActorContext): Promise<DrawRound> {
    const { data, error } = await this.client.rpc("record_draw_payout_v1", {
      p_draw_id: payout.drawId,
      p_ledger_entry_id: payout.ledgerEntryId,
      p_winner_member_id: payout.winnerMemberId,
      p_amount: payout.amount,
      p_reserve_amount: payout.reserveAmount,
      p_occurred_at: payout.postedAt
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseRound(data);
  }

  async getRound(drawId: string, context: DrawActorContext): Promise<DrawRound | null> {
    const { data, error } = await this.client.rpc("get_draw_v1", { p_draw_id: drawId });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data === null || data === undefined ? null : parseRound(data);
  }

  async findByIdempotencyKey(
    groupId: string,
    idempotencyKey: string,
    context: DrawActorContext
  ): Promise<DrawRound | null> {
    const { data, error } = await this.client.rpc("get_draw_by_idempotency_key_v1", {
      p_group_id: groupId,
      p_idempotency_key: idempotencyKey
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data === null || data === undefined ? null : parseRound(data);
  }

  async listCycle(cycleId: string, context: DrawActorContext): Promise<readonly DrawRound[]> {
    const { data, error } = await this.client.rpc("list_draw_cycle_v1", { p_cycle_id: cycleId });
    if (error) {
      throw mapSupabaseError(error);
    }
    if (!Array.isArray(data)) {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed cycle");
    }
    return data.map(parseRound);
  }

  async countSupersededCommitments(
    drawId: string,
    context: DrawActorContext
  ): Promise<number> {
    const { data, error } = await this.client.rpc("count_draw_commitments_v1", {
      p_draw_id: drawId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return typeof data === "number" ? data : 0;
  }
}

export function mapDrawError(error: unknown): DrawError {
  if (isDrawError(error)) {
    return error;
  }
  return new DrawError("STORAGE_FAILURE", "The draw could not be stored", error);
}

export function drawErrorStatus(code: DrawErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
    case "NOT_COMMITTED":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "REPEAT_WINNER":
    case "ALREADY_COMMITTED":
    case "ALREADY_REVEALED":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "INVALID_REQUEST":
    case "INVALID_AMOUNT":
    case "COMMITMENT_MISMATCH":
    case "NO_ELIGIBLE_PARTICIPANTS":
    case "UNIFORMITY_EXHAUSTED":
    // A member nonce that does not open, or a quorum that was never sealed.
    // 422 rather than 409: the request was well-formed and the ceremony cannot
    // be completed as described.
    case "MEMBER_COMMITMENT_MISSING":
    case "MEMBER_COMMITMENT_MISMATCH":
    // The caller tried to reveal out of turn. Distinct from a repeat winner so
    // the client can tell "wait your turn" from "that member already drew".
    case "ROUND_OUT_OF_ORDER":
      return 422;
    case "UNAVAILABLE":
      return 503;
    case "STORAGE_FAILURE":
    case "INTEGRITY_FAILURE":
      return 502;
  }
}
