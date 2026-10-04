import type { SupabaseClient } from "@supabase/supabase-js";

import { DrawError, isDrawError } from "./errors";
import { isDrawLifecycleState, isDrawProtocolVersion, type DrawErrorCode } from "./types";
import type {
  DrawCommitment,
  DrawCycleRecord,
  DrawListEntry,
  DrawMemberNonce,
  DrawPayout,
  DrawReveal,
  DrawRound,
  DrawSessionSeal,
  DrawSessionView
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

  // -- cycles, draws, and the member side of the ceremony ------------------------
  // Authorisation for every method below is decided by the database from the
  // caller's own JWT (`auth.uid()`); the arguments never name the acting member.

  /** Owner or treasurer. The pot is the contribution times the active members, computed by the database. */
  createCycle(
    input: {
      readonly groupId: string;
      readonly name: string;
      readonly contributionAmount: string;
      readonly totalRounds: number;
      readonly reserveRatioBps: number;
      readonly startedAt?: string;
      readonly idempotencyKey: string;
    },
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly replayed: boolean }>;
  /** Any member of the group. */
  listCycles(groupId: string, context: DrawActorContext): Promise<readonly DrawCycleRecord[]>;
  /** Any member of the cycle's group: the cycle and every draw in it. */
  getCycleDetail(
    cycleId: string,
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly draws: readonly DrawListEntry[] }>;
  /** Owner or treasurer. The server creates the draw id; the draw starts in `sealing`. */
  openDraw(
    input: { readonly cycleId: string; readonly round?: number; readonly idempotencyKey: string },
    context: DrawActorContext
  ): Promise<{ readonly session: DrawSessionView; readonly replayed: boolean }>;
  /** Any member of the group: seal hashes, and per member only whether a nonce was released. */
  getSession(drawId: string, context: DrawActorContext): Promise<DrawSessionView>;
  /** The signed-in member seals for themselves, while the draw is sealing. */
  submitSeal(
    input: { readonly drawId: string; readonly sealed: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly sealed: string; readonly replaced: boolean }>;
  /** The signed-in member releases their own nonce, only after the commitment. Never echoes it. */
  submitNonce(
    input: { readonly drawId: string; readonly nonce: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly replayed: boolean }>;
  /**
   * Owner or treasurer asks for the reveal with the seed. The database checks the
   * seed against the commitment, then publishes the seed and the stored nonces to
   * the group in one step, and returns the nonces. The only method that does.
   * Returns null for a draw committed before sessions existed (no stored nonces).
   */
  requestReveal(
    input: { readonly drawId: string; readonly seed: string },
    context: DrawActorContext
  ): Promise<{ readonly memberNonces: readonly DrawMemberNonce[]; readonly replayed: boolean } | null>;
}

export { InMemoryDrawRepository } from "./memoryRepository";
export type { InMemoryDrawRepositoryOptions, InMemoryGroup } from "./memoryRepository";

function mapSupabaseError(error: { readonly code?: string; readonly message?: string } | null): DrawError {
  const message = error?.message ?? "draw_storage_failure";
  const tableMissing = error?.code === "PGRST202" || error?.code === "42P01";
  const unavailable = error?.code === "57014" || tableMissing;

  if (message === "draw_group_not_found" || message === "draw_not_found") return new DrawError("NOT_FOUND", message);
  if (message === "draw_invalid_request") return new DrawError("INVALID_REQUEST", message);
  if (message === "draw_already_committed") return new DrawError("ALREADY_COMMITTED", message);
  if (message === "draw_not_eligible") return new DrawError("NOT_ELIGIBLE", message);
  if (message === "draw_nonce_too_early") return new DrawError("NONCE_TOO_EARLY", message);
  if (message === "draw_cycle_complete" || message === "draw_cycle_closed") return new DrawError("CYCLE_COMPLETE", message);
  if (message === "draw_cycle_rounds_exceed_members" || message === "draw_roster_mismatch") {
    return new DrawError("INVALID_REQUEST", message);
  }
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

const malformed = (what: string): DrawError =>
  new DrawError("INTEGRITY_FAILURE", `Draw storage returned a malformed ${what}`);

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw malformed(what);
  return value;
}

function int(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw malformed(what);
  return value;
}

/** Explicit field copy: nothing else the database returns is passed through. */
function parseCycle(value: unknown): DrawCycleRecord {
  if (typeof value !== "object" || value === null) throw malformed("cycle");
  const row = value as Record<string, unknown>;
  return {
    cycleId: str(row.cycleId, "cycle"),
    groupId: str(row.groupId, "cycle"),
    name: str(row.name, "cycle"),
    contributionAmount: typeof row.contributionAmount === "string" ? row.contributionAmount : null,
    potAmount: str(row.potAmount, "cycle"),
    totalRounds: int(row.totalRounds, "cycle"),
    reserveRatioBps: int(row.reserveRatioBps, "cycle"),
    startedAt: str(row.startedAt, "cycle"),
    closedAt: typeof row.closedAt === "string" ? row.closedAt : null,
    createdAt: str(row.createdAt, "cycle"),
    roundsRevealed: int(row.roundsRevealed, "cycle"),
    roundsPaid: int(row.roundsPaid, "cycle"),
    nextRound: typeof row.nextRound === "number" ? row.nextRound : null
  };
}

function parseListEntry(value: unknown): DrawListEntry {
  if (typeof value !== "object" || value === null) throw malformed("draw");
  const row = value as Record<string, unknown>;
  if (!isDrawLifecycleState(row.state)) throw malformed("draw");
  return {
    drawId: str(row.drawId, "draw"),
    round: int(row.round, "draw"),
    state: row.state,
    openedAt: str(row.openedAt, "draw"),
    committedAt: typeof row.committedAt === "string" ? row.committedAt : null,
    revealedAt: typeof row.revealedAt === "string" ? row.revealedAt : null,
    winnerMemberId: typeof row.winnerMemberId === "string" ? row.winnerMemberId : null,
    sealCount: int(row.sealCount, "draw"),
    nonceCount: int(row.nonceCount, "draw"),
    revealRequested: row.revealRequested === true,
    superseded: row.superseded === true,
    legacy: row.legacy === true
  };
}

function parseSession(value: unknown): DrawSessionView {
  if (typeof value !== "object" || value === null) throw malformed("draw session");
  const row = value as Record<string, unknown>;
  if (!isDrawLifecycleState(row.state) || !Array.isArray(row.eligible) || !Array.isArray(row.seals) || !Array.isArray(row.nonces)) {
    throw malformed("draw session");
  }
  const seals: DrawSessionSeal[] = (row.seals as Record<string, unknown>[]).map((seal) => ({
    memberId: str(seal.memberId, "seal"),
    sealed: str(seal.sealed, "seal"),
    ...(typeof seal.sealedAt === "string" ? { sealedAt: seal.sealedAt } : {})
  }));
  return {
    drawId: str(row.drawId, "draw session"),
    groupId: str(row.groupId, "draw session"),
    cycleId: str(row.cycleId, "draw session"),
    round: int(row.round, "draw session"),
    state: row.state,
    openedBy: str(row.openedBy, "draw session"),
    openedAt: str(row.openedAt, "draw session"),
    committedAt: typeof row.committedAt === "string" ? row.committedAt : null,
    cycle: parseCycle(row.cycle),
    eligible: (row.eligible as unknown[]).map((id) => str(id, "draw session")),
    seals,
    // Two fields only: whether a member released, never what they released.
    nonces: (row.nonces as Record<string, unknown>[]).map((entry) => ({
      memberId: str(entry.memberId, "draw session"),
      released: entry.released === true
    })),
    revealRequested: row.revealRequested === true
  };
}

export class SupabaseDrawRepository implements DrawRepository {
  constructor(private readonly client: SupabaseClient) {}

  async saveCommitment(
    commitment: DrawCommitment,
    context: DrawActorContext
  ): Promise<{ readonly round: DrawRound; readonly replayed: boolean }> {
    // `commit_draw_from_seals_v1` takes ONLY what the treasurer computes: the
    // commitment and the digests it binds. The group, cycle, round, pot, reserve,
    // total rounds and the sealed set are read by the database from the draw's
    // session, the cycle and the stored seals, and the roster is verified against
    // the group's members. There is no argument through which a caller could
    // supply a different sealed set, which is the point. (The previous
    // `commit_draw_v1` took one from the caller and is revoked from clients.)
    const { data, error } = await this.client.rpc("commit_draw_from_seals_v1", {
      p_draw_id: commitment.drawId,
      p_commitment: commitment.commitment,
      p_commitment_nonce: commitment.commitmentNonce,
      p_roster_digest: commitment.rosterDigest,
      p_member_digest: commitment.memberDigest,
      p_participants: commitment.participants.map((participant) => ({ ...participant })),
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

  async createCycle(
    input: {
      readonly groupId: string;
      readonly name: string;
      readonly contributionAmount: string;
      readonly totalRounds: number;
      readonly reserveRatioBps: number;
      readonly startedAt?: string;
      readonly idempotencyKey: string;
    },
    _context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly replayed: boolean }> {
    const { data, error } = await this.client.rpc("create_draw_cycle_v1", {
      p_group_id: input.groupId,
      p_name: input.name,
      p_contribution_amount: input.contributionAmount,
      p_total_rounds: input.totalRounds,
      p_reserve_ratio_bps: input.reserveRatioBps,
      p_started_at: input.startedAt ?? null,
      p_idempotency_key: input.idempotencyKey
    });
    if (error) throw mapSupabaseError(error);
    const payload = data as { readonly cycle?: unknown; readonly replayed?: unknown } | null;
    if (typeof payload?.replayed !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed cycle result");
    }
    return { cycle: parseCycle(payload.cycle), replayed: payload.replayed };
  }

  async listCycles(groupId: string, _context: DrawActorContext): Promise<readonly DrawCycleRecord[]> {
    const { data, error } = await this.client.rpc("list_draw_cycles_v1", { p_group_id: groupId });
    if (error) throw mapSupabaseError(error);
    if (!Array.isArray(data)) throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed cycle list");
    return data.map(parseCycle);
  }

  async getCycleDetail(
    cycleId: string,
    _context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly draws: readonly DrawListEntry[] }> {
    const { data, error } = await this.client.rpc("get_draw_cycle_v1", { p_cycle_id: cycleId });
    if (error) throw mapSupabaseError(error);
    const payload = data as { readonly cycle?: unknown; readonly draws?: unknown } | null;
    if (!payload || !Array.isArray(payload.draws)) {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed cycle");
    }
    return { cycle: parseCycle(payload.cycle), draws: payload.draws.map(parseListEntry) };
  }

  async openDraw(
    input: { readonly cycleId: string; readonly round?: number; readonly idempotencyKey: string },
    _context: DrawActorContext
  ): Promise<{ readonly session: DrawSessionView; readonly replayed: boolean }> {
    const { data, error } = await this.client.rpc("open_draw_v1", {
      p_cycle_id: input.cycleId,
      p_round: input.round ?? null,
      p_idempotency_key: input.idempotencyKey
    });
    if (error) throw mapSupabaseError(error);
    const payload = data as { readonly session?: unknown; readonly replayed?: unknown } | null;
    if (typeof payload?.replayed !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed draw");
    }
    return { session: parseSession(payload.session), replayed: payload.replayed };
  }

  async getSession(drawId: string, _context: DrawActorContext): Promise<DrawSessionView> {
    const { data, error } = await this.client.rpc("get_draw_session_v1", { p_draw_id: drawId });
    if (error) throw mapSupabaseError(error);
    return parseSession(data);
  }

  async submitSeal(
    input: { readonly drawId: string; readonly sealed: string },
    _context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly sealed: string; readonly replaced: boolean }> {
    // No member argument exists: the database seals for `auth.uid()`.
    const { data, error } = await this.client.rpc("submit_draw_seal_v1", {
      p_draw_id: input.drawId,
      p_sealed: input.sealed
    });
    if (error) throw mapSupabaseError(error);
    const row = data as Record<string, unknown> | null;
    if (!row || typeof row.memberId !== "string" || typeof row.sealed !== "string" || typeof row.replaced !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed seal result");
    }
    return { memberId: row.memberId, sealed: row.sealed, replaced: row.replaced };
  }

  async submitNonce(
    input: { readonly drawId: string; readonly nonce: string },
    _context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly replayed: boolean }> {
    const { data, error } = await this.client.rpc("submit_draw_nonce_v1", {
      p_draw_id: input.drawId,
      p_nonce: input.nonce
    });
    if (error) throw mapSupabaseError(error);
    const row = data as Record<string, unknown> | null;
    if (!row || typeof row.memberId !== "string" || typeof row.replayed !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed nonce result");
    }
    // Deliberately copies two fields: the stored nonce is never passed back out.
    return { memberId: row.memberId, replayed: row.replayed };
  }

  async requestReveal(
    input: { readonly drawId: string; readonly seed: string },
    _context: DrawActorContext
  ): Promise<{ readonly memberNonces: readonly DrawMemberNonce[]; readonly replayed: boolean } | null> {
    const { data, error } = await this.client.rpc("open_draw_reveal_v1", {
      p_draw_id: input.drawId,
      p_seed: input.seed
    });
    if (error) throw mapSupabaseError(error);
    const row = data as { readonly memberNonces?: unknown; readonly replayed?: unknown } | null;
    if (!row || !Array.isArray(row.memberNonces) || typeof row.replayed !== "boolean") {
      throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed reveal request");
    }
    const memberNonces = (row.memberNonces as Record<string, unknown>[]).map((entry) => {
      if (typeof entry.memberId !== "string" || typeof entry.nonce !== "string") {
        throw new DrawError("INTEGRITY_FAILURE", "Draw storage returned a malformed nonce");
      }
      return { memberId: entry.memberId, nonce: entry.nonce };
    });
    return { memberNonces, replayed: row.replayed };
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
    case "NOT_ELIGIBLE":
      return 403;
    case "REPEAT_WINNER":
    case "CYCLE_COMPLETE":
    // A nonce before the commit: the request is fine, the draw is not there yet.
    case "NONCE_TOO_EARLY":
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
