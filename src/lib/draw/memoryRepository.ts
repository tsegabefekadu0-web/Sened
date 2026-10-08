import { computeCommitment, computeMemberCommitment, computeMemberDigest, deriveTicket, webDrawHasher } from "./canonical";
import { DrawError } from "./errors";
import { openReveal } from "./engine";
import type { DrawActorContext, DrawRepository } from "./repository";
import {
  DRAW_CANCEL_LIMIT,
  DRAW_CURRENT_PROTOCOL_VERSION,
  type DrawCancellation,
  type DrawCommitment,
  type DrawContributionGate,
  type DrawCycleRecord,
  type DrawGateFlag,
  type DrawHasher,
  type DrawLifecycleState,
  type DrawListEntry,
  type DrawMemberNonce,
  type DrawCommitGate,
  type DrawOpenGate,
  type DrawPayout,
  type DrawReveal,
  type DrawRound,
  type DrawSessionSeal,
  type DrawSessionView
} from "./types";
import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

/**
 * An in-memory stand-in for the draw tables and RPCs, for tests.
 *
 * It mirrors the rules `20261005100000_draw_cycles_and_member_seals.sql`
 * enforces in SQL (who may seal, that a nonce is refused before the commit, that
 * the commit uses the stored seals, that the reveal uses the stored nonces), so
 * the service and the screen can be tested end to end. It is a double, not the
 * authority: the SQL harness (`scripts/verify-migrations.sql`) is what proves the
 * database enforces them, and `test/draw.rpc-contract.test.ts` pins the two
 * together.
 */

export interface InMemoryGroup {
  readonly groupId: string;
  readonly members: readonly {
    readonly userId: string;
    readonly role: "owner" | "treasurer" | "member";
    readonly active?: boolean;
  }[];
}

export interface InMemoryDrawRepositoryOptions {
  readonly clock?: () => Date;
  /** Who is in which group, and in what role. Needed by the cycle and member methods. */
  readonly groups?: readonly InMemoryGroup[];
  /** Used to verify seals, commitments and tickets. Defaults to WebCrypto. */
  readonly hasher?: DrawHasher;
  /**
   * Accept a commitment for a draw that has no server-created session, with the
   * sealed set supplied by the caller. This is the pre-session behaviour, which
   * production no longer offers (`commit_draw_v1` is revoked from clients); it
   * exists only so older engine-level tests keep running. Default false.
   */
  readonly allowSessionlessCommit?: boolean;
  readonly idFactory?: () => string;
  /**
   * Stands in for the ledger-derived grid the database consults when a draw is opened under a
   * `warn` or `block` gate: the flagged (active member, round) pairs strictly before `beforeRound`.
   * The default finds none. The double has no ledger; `scripts/verify-migrations.sql` proves the
   * real derivation.
   */
  readonly contributionFlags?: (cycleId: string, beforeRound: number) => readonly DrawGateFlag[];
}

/** One recorded override, as the database's append-only table holds it. */
export interface InMemoryGateOverride {
  readonly cycleId: string;
  readonly round: number;
  readonly drawId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly flagged: readonly DrawGateFlag[];
  /** Where it was given: when the draw was opened, or when it was committed. */
  readonly stage: "open" | "commit";
}

/** One recorded policy change. */
export interface InMemoryGateEvent {
  readonly cycleId: string;
  readonly from: DrawContributionGate;
  readonly to: DrawContributionGate;
  readonly actorId: string;
  readonly reason: string;
}

interface CycleRow {
  readonly cycleId: string;
  readonly groupId: string;
  readonly name: string;
  readonly contributionAmount: string;
  readonly potAmount: string;
  readonly totalRounds: number;
  readonly reserveRatioBps: number;
  readonly startedAt: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  /** The policy chosen at creation; the effective one is the latest event. */
  readonly initialGate: DrawContributionGate;
  readonly sealWindowHours: number;
  readonly nonceWindowHours: number;
}

interface SessionRow {
  readonly drawId: string;
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly idempotencyKey: string;
  /** Opening order. The clock can repeat in tests; this cannot. */
  readonly order: number;
  /** Fixed at open from the cycle; nobody can shorten it. */
  readonly sealDeadline: string;
  /** Recorded non-responders of this round's earlier cancels that the opener excluded. */
  readonly excluded: readonly string[];
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DrawError("INVALID_REQUEST", `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortById<T extends { readonly memberId: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0));
}

export class InMemoryDrawRepository implements DrawRepository {
  private readonly commitments = new Map<string, DrawCommitment>();
  private readonly commitmentKeys = new Map<string, string>();
  private readonly commitmentsPerRound = new Map<string, number>();
  private readonly reveals = new Map<string, DrawReveal>();
  private readonly payouts = new Map<string, DrawPayout>();
  private readonly cycles = new Map<string, CycleRow>();
  private readonly cycleKeys = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly sessionKeys = new Map<string, string>();
  private sessionCounter = 0;
  private readonly seals = new Map<string, Map<string, DrawSessionSeal>>();
  /** Never exposed by any method except `requestReveal`. */
  private readonly nonces = new Map<string, Map<string, string>>();
  private readonly openings = new Map<
    string,
    { readonly seed: string; readonly memberNonces: readonly DrawMemberNonce[]; readonly openedBy: string; readonly openedAt: string }
  >();
  private readonly nonceDeadlines = new Map<string, string>();
  private readonly cancellationLog: DrawCancellation[] = [];
  private readonly groups: Map<string, InMemoryGroup["members"]>;
  private readonly clock: () => Date;
  private readonly hasher: DrawHasher;
  private readonly allowSessionlessCommit: boolean;
  private readonly idFactory: () => string;
  private readonly contributionFlags: (cycleId: string, beforeRound: number) => readonly DrawGateFlag[];
  private readonly gateEventLog: InMemoryGateEvent[] = [];
  private readonly gateOverrideLog: InMemoryGateOverride[] = [];

  constructor(options: InMemoryDrawRepositoryOptions = {}) {
    this.contributionFlags = options.contributionFlags ?? (() => []);
    this.clock = options.clock ?? (() => new Date());
    this.hasher = options.hasher ?? webDrawHasher;
    this.allowSessionlessCommit = options.allowSessionlessCommit ?? false;
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.groups = new Map((options.groups ?? []).map((group) => [group.groupId, group.members]));
  }

  /** The recorded policy changes, oldest first. Append-only. */
  gateEvents(): readonly InMemoryGateEvent[] {
    return [...this.gateEventLog];
  }

  /** The recorded overrides, oldest first. Append-only. */
  gateOverrides(): readonly InMemoryGateOverride[] {
    return [...this.gateOverrideLog];
  }

  private effectiveGate(row: CycleRow): DrawContributionGate {
    let gate = row.initialGate;
    for (const event of this.gateEventLog) {
      if (event.cycleId === row.cycleId) gate = event.to;
    }
    return gate;
  }

  /** Add or replace a group's membership (tests that join a member mid-cycle). */
  setGroup(group: InMemoryGroup): void {
    this.groups.set(group.groupId, group.members);
  }

  // -- membership -------------------------------------------------------------------

  private activeMembers(groupId: string): string[] {
    return (this.groups.get(groupId) ?? []).filter((member) => member.active !== false).map((member) => member.userId);
  }

  private isMember(groupId: string, userId: string): boolean {
    return this.activeMembers(groupId).includes(userId);
  }

  private isManager(groupId: string, userId: string): boolean {
    return (this.groups.get(groupId) ?? []).some(
      (member) => member.userId === userId && member.active !== false && (member.role === "owner" || member.role === "treasurer")
    );
  }

  private forbid(): never {
    throw new DrawError("FORBIDDEN", "draw_forbidden");
  }

  // -- derived state ----------------------------------------------------------------

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

  private cancellationOf(drawId: string): DrawCancellation | undefined {
    return this.cancellationLog.find((entry) => entry.drawId === drawId);
  }

  private isOwner(groupId: string, userId: string): boolean {
    return (this.groups.get(groupId) ?? []).some(
      (member) => member.userId === userId && member.active !== false && member.role === "owner"
    );
  }

  /** The members who may seal a session and exactly its roster: the round's eligible members minus the excluded. */
  private sessionEligible(session: SessionRow): string[] {
    return this.eligible(session.groupId, session.cycleId, session.round).filter((id) => !session.excluded.includes(id));
  }

  private lifecycle(drawId: string): DrawLifecycleState {
    if (this.cancellationOf(drawId) !== undefined) return "cancelled";
    if (this.payouts.has(drawId)) return "paid";
    if (this.reveals.has(drawId)) return "revealed";
    if (this.commitments.has(drawId)) return "committed";
    return "sealing";
  }

  private revealedRounds(cycleId: string): number {
    let highest = 0;
    for (const commitment of this.commitments.values()) {
      if (commitment.cycleId === cycleId && this.reveals.has(commitment.drawId)) {
        highest = Math.max(highest, commitment.round);
      }
    }
    return highest;
  }

  private cycleRecord(row: CycleRow): DrawCycleRecord {
    const revealed = new Set<number>();
    const paid = new Set<number>();
    for (const commitment of this.commitments.values()) {
      if (commitment.cycleId !== row.cycleId) continue;
      if (this.reveals.has(commitment.drawId)) revealed.add(commitment.round);
      if (this.payouts.has(commitment.drawId)) paid.add(commitment.round);
    }
    return {
      cycleId: row.cycleId,
      groupId: row.groupId,
      name: row.name,
      contributionAmount: row.contributionAmount,
      potAmount: row.potAmount,
      totalRounds: row.totalRounds,
      reserveRatioBps: row.reserveRatioBps,
      startedAt: row.startedAt,
      closedAt: null,
      createdAt: row.createdAt,
      roundsRevealed: revealed.size,
      roundsPaid: paid.size,
      nextRound: revealed.size < row.totalRounds ? revealed.size + 1 : null,
      contributionGate: this.effectiveGate(row)
    };
  }

  /** Active members who have not already won this cycle: who may seal, and the exact roster. */
  private eligible(groupId: string, cycleId: string, round: number): string[] {
    const winners = new Set<string>();
    for (const commitment of this.commitments.values()) {
      const reveal = this.reveals.get(commitment.drawId);
      if (commitment.cycleId === cycleId && commitment.round < round && reveal !== undefined) {
        winners.add(reveal.winnerMemberId);
      }
    }
    return this.activeMembers(groupId).filter((userId) => !winners.has(userId));
  }

  private requireSession(drawId: string): SessionRow {
    const session = this.sessions.get(drawId.toLowerCase());
    if (session === undefined) throw new DrawError("NOT_FOUND", "draw_not_found");
    return session;
  }

  // -- cycles -----------------------------------------------------------------------

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
    if (!this.isManager(input.groupId, context.userId)) this.forbid();
    const gate = input.contributionGate ?? "off";
    const sealWindowHours = input.sealWindowHours ?? 48;
    const nonceWindowHours = input.nonceWindowHours ?? 48;
    for (const hours of [sealWindowHours, nonceWindowHours]) {
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
      }
    }
    if (gate !== "off" && gate !== "warn" && gate !== "block") {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    const name = input.name.trim();
    let contributionMinor: bigint;
    try {
      contributionMinor = toEtbMinorUnits(input.contributionAmount, true);
    } catch {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    if (
      name.length < 1 ||
      name.length > 120 ||
      !Number.isInteger(input.totalRounds) ||
      input.totalRounds < 1 ||
      input.totalRounds > 1000 ||
      !Number.isInteger(input.reserveRatioBps) ||
      input.reserveRatioBps < 0 ||
      input.reserveRatioBps > 3333 ||
      !KEY_PATTERN.test(input.idempotencyKey)
    ) {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    const members = this.activeMembers(input.groupId).length;
    if (input.totalRounds > members) {
      throw new DrawError("INVALID_REQUEST", "draw_cycle_rounds_exceed_members");
    }

    const keyed = `${input.groupId}:${input.idempotencyKey}`;
    const existingId = this.cycleKeys.get(keyed);
    if (existingId !== undefined) {
      const existing = this.cycles.get(existingId) as CycleRow;
      if (
        existing.name !== name ||
        existing.contributionAmount !== formatEtbMinorUnits(contributionMinor) ||
        existing.totalRounds !== input.totalRounds ||
        existing.reserveRatioBps !== input.reserveRatioBps ||
        existing.initialGate !== gate ||
        existing.sealWindowHours !== sealWindowHours ||
        existing.nonceWindowHours !== nonceWindowHours
      ) {
        throw new DrawError("IDEMPOTENCY_CONFLICT", "draw_idempotency_conflict");
      }
      return { cycle: this.cycleRecord(existing), replayed: true };
    }

    const now = this.clock().toISOString();
    const row: CycleRow = {
      cycleId: this.idFactory(),
      groupId: input.groupId,
      name,
      contributionAmount: formatEtbMinorUnits(contributionMinor),
      potAmount: formatEtbMinorUnits(contributionMinor * BigInt(members)),
      totalRounds: input.totalRounds,
      reserveRatioBps: input.reserveRatioBps,
      startedAt: input.startedAt ?? now,
      createdAt: now,
      idempotencyKey: input.idempotencyKey,
      initialGate: gate,
      sealWindowHours,
      nonceWindowHours
    };
    this.cycles.set(row.cycleId, row);
    this.cycleKeys.set(keyed, row.cycleId);
    return { cycle: this.cycleRecord(row), replayed: false };
  }

  async setContributionGate(
    input: { readonly cycleId: string; readonly gate: DrawContributionGate; readonly reason: string },
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly replayed: boolean }> {
    const row = this.cycles.get(input.cycleId.toLowerCase());
    if (row === undefined || !this.isManager(row.groupId, context.userId)) this.forbid();
    const cycle = row as CycleRow;
    const reason = input.reason.trim();
    if ((input.gate !== "off" && input.gate !== "warn" && input.gate !== "block") || reason.length < 10 || reason.length > 1000) {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    const current = this.effectiveGate(cycle);
    if (current === input.gate) return { cycle: this.cycleRecord(cycle), replayed: true };
    this.gateEventLog.push({ cycleId: cycle.cycleId, from: current, to: input.gate, actorId: context.userId, reason });
    return { cycle: this.cycleRecord(cycle), replayed: false };
  }

  async listCycles(groupId: string, context: DrawActorContext): Promise<readonly DrawCycleRecord[]> {
    if (!this.isMember(groupId, context.userId)) this.forbid();
    return Array.from(this.cycles.values())
      .filter((row) => row.groupId === groupId)
      .sort((left, right) => (left.startedAt < right.startedAt ? 1 : left.startedAt > right.startedAt ? -1 : 0))
      .map((row) => this.cycleRecord(row));
  }

  async getCycleDetail(
    cycleId: string,
    context: DrawActorContext
  ): Promise<{ readonly cycle: DrawCycleRecord; readonly draws: readonly DrawListEntry[] }> {
    const row = this.cycles.get(cycleId.toLowerCase());
    if (row === undefined || !this.isMember(row.groupId, context.userId)) this.forbid();
    const cycle = row as CycleRow;
    const draws: DrawListEntry[] = [];
    for (const session of this.sessions.values()) {
      if (session.cycleId !== cycle.cycleId) continue;
      const commitment = this.commitments.get(session.drawId);
      const reveal = this.reveals.get(session.drawId);
      const later = Array.from(this.sessions.values()).some(
        (other) => other.cycleId === session.cycleId && other.round === session.round && other.order > session.order
      );
      draws.push({
        drawId: session.drawId,
        round: session.round,
        state: this.lifecycle(session.drawId),
        openedAt: session.openedAt,
        committedAt: commitment?.committedAt ?? null,
        revealedAt: reveal?.revealedAt ?? null,
        winnerMemberId: reveal?.winnerMemberId ?? null,
        sealCount: commitment ? commitment.memberCommitments.length : (this.seals.get(session.drawId)?.size ?? 0),
        nonceCount: this.nonces.get(session.drawId)?.size ?? 0,
        revealRequested: this.openings.has(session.drawId),
        superseded: later,
        legacy: false
      });
    }
    for (const commitment of this.commitments.values()) {
      if (commitment.cycleId !== cycle.cycleId || this.sessions.has(commitment.drawId)) continue;
      const reveal = this.reveals.get(commitment.drawId);
      draws.push({
        drawId: commitment.drawId,
        round: commitment.round,
        state: this.lifecycle(commitment.drawId),
        openedAt: commitment.committedAt,
        committedAt: commitment.committedAt,
        revealedAt: reveal?.revealedAt ?? null,
        winnerMemberId: reveal?.winnerMemberId ?? null,
        sealCount: commitment.memberCommitments.length,
        nonceCount: 0,
        revealRequested: false,
        superseded: false,
        legacy: true
      });
    }
    const orderOf = (drawId: string): number => this.sessions.get(drawId)?.order ?? 0;
    draws.sort((left, right) => left.round - right.round || orderOf(left.drawId) - orderOf(right.drawId));
    return { cycle: this.cycleRecord(cycle), draws };
  }

  // -- sessions ---------------------------------------------------------------------

  private view(session: SessionRow): DrawSessionView {
    const cycle = this.cycles.get(session.cycleId) as CycleRow;
    const commitment = this.commitments.get(session.drawId);
    const stored = this.seals.get(session.drawId);
    return {
      drawId: session.drawId,
      groupId: session.groupId,
      cycleId: session.cycleId,
      round: session.round,
      state: this.lifecycle(session.drawId),
      openedBy: session.openedBy,
      openedAt: session.openedAt,
      committedAt: commitment?.committedAt ?? null,
      cycle: this.cycleRecord(cycle),
      eligible: commitment
        ? commitment.participants.map((participant) => participant.memberId).sort()
        : this.sessionEligible(session).sort(),
      seals: commitment
        ? commitment.memberCommitments.map((seal) => ({ memberId: seal.memberId, sealed: seal.sealed }))
        : sortById(Array.from(stored?.values() ?? [])),
      nonces: commitment
        ? sortById(
            commitment.memberCommitments.map((seal) => ({
              memberId: seal.memberId,
              released: this.nonces.get(session.drawId)?.has(seal.memberId) ?? false
            }))
          )
        : [],
      revealRequested: this.openings.has(session.drawId),
      sealDeadline: session.sealDeadline,
      nonceDeadline: this.nonceDeadlines.get(session.drawId) ?? null,
      excluded: sortStrings(session.excluded),
      cancelsThisRound: this.cancellationLog.filter((entry) => entry.cycleId === session.cycleId && entry.round === session.round).length,
      cancellation: this.cancellationOf(session.drawId) ?? null,
      revealOpening: ((opening) =>
        opening === undefined ? null : { seed: opening.seed, openedBy: opening.openedBy, openedAt: opening.openedAt })(
        this.openings.get(session.drawId)
      )
    };
  }

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
    const cycle = this.cycles.get(input.cycleId.toLowerCase());
    if (cycle === undefined || !this.isManager(cycle.groupId, context.userId)) this.forbid();
    const row = cycle as CycleRow;
    if (!KEY_PATTERN.test(input.idempotencyKey)) throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    const override = input.overrideReason === undefined ? null : input.overrideReason.trim();
    if (override !== null && (override.length < 10 || override.length > 1000)) {
      throw new DrawError("INVALID_REQUEST", "draw_override_reason_invalid");
    }

    const keyed = `${row.groupId}:${input.idempotencyKey}`;
    const existingId = this.sessionKeys.get(keyed);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId) as SessionRow;
      if (existing.cycleId !== row.cycleId || (input.round !== undefined && existing.round !== input.round)) {
        throw new DrawError("IDEMPOTENCY_CONFLICT", "draw_idempotency_conflict");
      }
      return { session: this.view(existing), replayed: true, gate: null };
    }

    const revealed = this.revealedRounds(row.cycleId);
    const next = revealed + 1;
    if (next > row.totalRounds) throw new DrawError("CYCLE_COMPLETE", "draw_cycle_complete");
    if (input.round !== undefined && input.round !== next) {
      if (input.round >= 1 && input.round <= revealed) throw new DrawError("ALREADY_REVEALED", "draw_already_revealed");
      throw new DrawError("ROUND_OUT_OF_ORDER", "draw_round_out_of_order");
    }

    // NO RE-ROLL: a committed draw that is neither revealed nor cancelled is THE draw of this round.
    for (const commitment of this.commitments.values()) {
      if (
        commitment.cycleId === row.cycleId &&
        commitment.round === next &&
        this.cancellationOf(commitment.drawId) === undefined &&
        !this.reveals.has(commitment.drawId)
      ) {
        throw new DrawError("ROUND_HAS_LIVE_DRAW", "draw_round_has_live_draw");
      }
    }

    const live = Array.from(this.sessions.values())
      .filter(
        (session) =>
          session.cycleId === row.cycleId &&
          session.round === next &&
          !this.commitments.has(session.drawId) &&
          this.cancellationOf(session.drawId) === undefined
      )
      .sort((left, right) => right.order - left.order)[0];
    if (live !== undefined) return { session: this.view(live), replayed: true, gate: null };

    // THE CANCEL LIMIT: past it only a group owner may open another session for the round.
    const cancelsHere = this.cancellationLog.filter((entry) => entry.cycleId === row.cycleId && entry.round === next);
    if (cancelsHere.length >= DRAW_CANCEL_LIMIT && !this.isOwner(row.groupId, context.userId)) {
      throw new DrawError("CANCEL_LIMIT_REACHED", "draw_cancel_limit_reached");
    }
    // EXCLUDING NON-RESPONDERS: only members recorded as missed in an earlier cancel of THIS round.
    let excluded: string[] = [];
    if (input.excludeMissed === true) {
      excluded = [...new Set(cancelsHere.flatMap((entry) => [...entry.missedMembers]))];
      if (excluded.length === 0) throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
      if (this.eligible(row.groupId, row.cycleId, next).filter((id) => !excluded.includes(id)).length < 1) {
        throw new DrawError("NO_ELIGIBLE_PARTICIPANTS", "draw_no_eligible_participants");
      }
    }

    // The gate looks at contributions only when a NEW draw would be opened.
    const policy = this.effectiveGate(row);
    const flagged = policy === "off" ? [] : this.contributionFlags(row.cycleId, next);
    const overridden = policy === "block" && flagged.length > 0;
    if (overridden && override === null) {
      throw new DrawError("CONTRIBUTION_GATE_BLOCKED", "draw_contribution_gate_blocked", undefined, flagged);
    }

    const session: SessionRow = {
      drawId: this.idFactory(),
      groupId: row.groupId,
      cycleId: row.cycleId,
      round: next,
      openedBy: context.userId,
      openedAt: this.clock().toISOString(),
      idempotencyKey: input.idempotencyKey,
      order: (this.sessionCounter += 1),
      sealDeadline: new Date(this.clock().getTime() + row.sealWindowHours * 3_600_000).toISOString(),
      excluded
    };
    this.sessions.set(session.drawId, session);
    this.sessionKeys.set(keyed, session.drawId);
    if (overridden && override !== null) {
      this.gateOverrideLog.push({
        cycleId: row.cycleId,
        round: next,
        drawId: session.drawId,
        actorId: context.userId,
        reason: override,
        flagged,
        stage: "open"
      });
    }
    return { session: this.view(session), replayed: false, gate: { policy, flagged, overridden } satisfies DrawOpenGate };
  }

  async getSession(drawId: string, context: DrawActorContext): Promise<DrawSessionView> {
    const session = this.requireSession(drawId);
    if (!this.isMember(session.groupId, context.userId)) this.forbid();
    return this.view(session);
  }

  async submitSeal(
    input: { readonly drawId: string; readonly sealed: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly sealed: string; readonly replaced: boolean }> {
    const session = this.requireSession(input.drawId);
    if (!this.isMember(session.groupId, context.userId)) this.forbid();
    if (!/^[0-9a-f]{64}$/.test(input.sealed)) throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    if (this.cancellationOf(session.drawId) !== undefined) throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
    if (this.commitments.has(session.drawId)) throw new DrawError("ALREADY_COMMITTED", "draw_already_committed");
    if (this.clock().getTime() >= new Date(session.sealDeadline).getTime()) {
      throw new DrawError("SEAL_DEADLINE_PASSED", "draw_seal_deadline_passed");
    }
    if (!this.sessionEligible(session).includes(context.userId)) {
      throw new DrawError("NOT_ELIGIBLE", "draw_not_eligible");
    }
    const stored = this.seals.get(session.drawId) ?? new Map<string, DrawSessionSeal>();
    const previous = stored.get(context.userId);
    stored.set(context.userId, { memberId: context.userId, sealed: input.sealed, sealedAt: this.clock().toISOString() });
    this.seals.set(session.drawId, stored);
    return { memberId: context.userId, sealed: input.sealed, replaced: previous !== undefined && previous.sealed !== input.sealed };
  }

  async submitNonce(
    input: { readonly drawId: string; readonly nonce: string },
    context: DrawActorContext
  ): Promise<{ readonly memberId: string; readonly replayed: boolean }> {
    const session = this.requireSession(input.drawId);
    if (!this.isMember(session.groupId, context.userId)) this.forbid();
    if (this.cancellationOf(session.drawId) !== undefined) throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
    const commitment = this.commitments.get(session.drawId);
    if (commitment === undefined) throw new DrawError("NONCE_TOO_EARLY", "draw_nonce_too_early");
    if (this.openings.has(session.drawId) || this.reveals.has(session.drawId)) {
      throw new DrawError("ALREADY_REVEALED", "draw_already_revealed");
    }
    if (input.nonce.length < 16 || input.nonce.length > 256 || !/^[!-~]+$/.test(input.nonce)) {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    // Only the caller's OWN committed seal is consulted; identity is never an input.
    const mine = commitment.memberCommitments.find((seal) => seal.memberId === context.userId);
    if (mine === undefined) throw new DrawError("MEMBER_COMMITMENT_MISSING", "draw_member_commitment_missing");
    const hash = await computeMemberCommitment(
      { drawId: session.drawId, memberId: context.userId, nonce: input.nonce },
      this.hasher
    );
    if (hash !== mine.sealed) throw new DrawError("MEMBER_COMMITMENT_MISMATCH", "draw_member_commitment_mismatch");
    const stored = this.nonces.get(session.drawId) ?? new Map<string, string>();
    const replayed = stored.has(context.userId);
    if (!replayed) stored.set(context.userId, input.nonce);
    this.nonces.set(session.drawId, stored);
    return { memberId: context.userId, replayed };
  }

  /**
   * The ONLY method that returns stored nonces. Mirrors `open_draw_reveal_v1`:
   * manager only, committed, a seed that reproduces the commitment, every sealed
   * member's nonce present. Returns null for a draw with no session (the legacy
   * double), whose nonces the caller supplies.
   */
  async requestReveal(
    input: { readonly drawId: string; readonly seed: string },
    context: DrawActorContext
  ): Promise<{ readonly memberNonces: readonly DrawMemberNonce[]; readonly replayed: boolean } | null> {
    const session = this.sessions.get(input.drawId.toLowerCase());
    if (session === undefined) return null;
    if (!this.isManager(session.groupId, context.userId)) this.forbid();
    const commitment = this.commitments.get(session.drawId);
    if (commitment === undefined) throw new DrawError("NOT_COMMITTED", "draw_not_committed");
    if (this.cancellationOf(session.drawId) !== undefined) throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
    if (this.reveals.has(session.drawId)) throw new DrawError("ALREADY_REVEALED", "draw_already_revealed");
    if (input.seed.length < 16 || input.seed.length > 256 || !/^[!-~]+$/.test(input.seed)) {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    const opening = this.openings.get(session.drawId);
    if (opening !== undefined) {
      if (opening.seed !== input.seed) throw new DrawError("IDEMPOTENCY_CONFLICT", "draw_idempotency_conflict");
      return { memberNonces: opening.memberNonces, replayed: true };
    }
    const recomputed = await computeCommitment(
      {
        groupId: commitment.groupId,
        cycleId: commitment.cycleId,
        round: commitment.round,
        drawId: commitment.drawId,
        rosterDigest: commitment.rosterDigest,
        commitmentNonce: commitment.commitmentNonce,
        memberDigest: commitment.memberDigest,
        seed: input.seed
      },
      commitment.protocolVersion,
      this.hasher
    );
    if (recomputed !== commitment.commitment) throw new DrawError("COMMITMENT_MISMATCH", "draw_commitment_mismatch");
    const stored = this.nonces.get(session.drawId) ?? new Map<string, string>();
    const memberNonces = sortById(
      commitment.memberCommitments.flatMap((seal) => {
        const nonce = stored.get(seal.memberId);
        return nonce === undefined ? [] : [{ memberId: seal.memberId, nonce }];
      })
    );
    if (memberNonces.length !== commitment.memberCommitments.length) {
      throw new DrawError("MEMBER_COMMITMENT_MISSING", "draw_member_commitment_missing");
    }
    this.openings.set(session.drawId, {
      seed: input.seed,
      memberNonces,
      openedBy: context.userId,
      openedAt: this.clock().toISOString()
    });
    return { memberNonces, replayed: false };
  }

  // -- commit / reveal / payout -----------------------------------------------------

  private async assertCommitFromSession(
    commitment: DrawCommitment,
    context: DrawActorContext,
    overrideReason: string | undefined
  ): Promise<DrawCommitGate> {
    const session = this.requireSession(commitment.drawId);
    if (!this.isManager(session.groupId, context.userId)) this.forbid();
    // A supplied reason must be a real one, whether or not it ends up needed (after the role, as in the database).
    const reason = overrideReason === undefined ? null : overrideReason.trim();
    if (reason !== null && (reason.length < 10 || reason.length > 1000)) {
      throw new DrawError("INVALID_REQUEST", "draw_override_reason_invalid");
    }
    const cycle = this.cycles.get(session.cycleId) as CycleRow;
    if (this.cancellationOf(session.drawId) !== undefined) throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
    for (const other of this.commitments.values()) {
      if (
        other.cycleId === session.cycleId &&
        other.round === session.round &&
        other.drawId !== session.drawId &&
        this.cancellationOf(other.drawId) === undefined
      ) {
        throw new DrawError("ROUND_HAS_LIVE_DRAW", "draw_round_has_live_draw");
      }
    }
    if (
      commitment.groupId !== session.groupId ||
      commitment.cycleId !== session.cycleId ||
      commitment.round !== session.round
    ) {
      throw new DrawError("INVALID_REQUEST", "draw_invalid_request");
    }
    if (commitment.protocolVersion !== DRAW_CURRENT_PROTOCOL_VERSION) {
      throw new DrawError("INVALID_REQUEST", "draw_protocol_version_unsupported");
    }
    if (this.revealedRounds(session.cycleId) < session.round - 1) {
      throw new DrawError("ROUND_OUT_OF_ORDER", "draw_round_out_of_order");
    }
    // The terms are the cycle's, not the caller's.
    if (
      commitment.potAmount !== cycle.potAmount ||
      commitment.totalRounds !== cycle.totalRounds ||
      commitment.reserveRatioBps !== cycle.reserveRatioBps
    ) {
      throw new DrawError("INVALID_REQUEST", "draw_cycle_mismatch");
    }

    const eligible = this.sessionEligible(session);
    if (eligible.length < 1) throw new DrawError("NO_ELIGIBLE_PARTICIPANTS", "draw_no_eligible_participants");
    const listed = commitment.participants.map((participant) => participant.memberId);
    if (listed.length !== eligible.length || new Set(listed).size !== eligible.length || listed.some((id) => !eligible.includes(id))) {
      throw new DrawError("INVALID_REQUEST", "draw_roster_mismatch");
    }
    for (const participant of commitment.participants) {
      const ticket = await deriveTicket(
        { groupId: session.groupId, cycleId: session.cycleId, memberId: participant.memberId },
        this.hasher
      );
      if (ticket !== participant.ticket || participant.contributionAmount !== cycle.contributionAmount) {
        throw new DrawError("INVALID_REQUEST", "draw_roster_mismatch");
      }
    }

    // The sealed set is whatever is stored, restricted to members still eligible.
    const stored = sortById(
      Array.from(this.seals.get(session.drawId)?.values() ?? []).filter((seal) => eligible.includes(seal.memberId))
    ).map((seal) => ({ memberId: seal.memberId, sealed: seal.sealed }));
    // QUORUM: EVERY eligible member must have sealed.
    if (stored.length !== eligible.length) {
      throw new DrawError("MEMBER_COMMITMENT_MISSING", "draw_member_commitment_missing");
    }
    const digest = await computeMemberDigest({ drawId: session.drawId, contributions: stored }, this.hasher);
    if (digest !== commitment.memberDigest) {
      throw new DrawError("MEMBER_COMMITMENT_MISMATCH", "draw_member_commitment_mismatch");
    }

    // The contribution gate again, with the policy and the flags as they are NOW (not as they were at open).
    const policy = this.effectiveGate(cycle);
    const flagged = policy === "off" ? [] : this.contributionFlags(session.cycleId, session.round);
    let overridden = false;
    let carriedOver = false;
    if (policy === "block" && flagged.length > 0) {
      const open = this.gateOverrideLog.find((entry) => entry.drawId === session.drawId && entry.stage === "open");
      const known = new Set((open?.flagged ?? []).map((flag) => `${flag.memberId}:${flag.round}`));
      if (flagged.every((flag) => known.has(`${flag.memberId}:${flag.round}`))) {
        carriedOver = true;
      } else if (reason === null) {
        throw new DrawError("CONTRIBUTION_GATE_BLOCKED", "draw_contribution_gate_blocked", undefined, flagged);
      } else {
        overridden = true;
      }
    }
    return { policy, flagged, overridden, carriedOver };
  }

  async saveCommitment(
    commitment: DrawCommitment,
    context: DrawActorContext,
    options: { readonly overrideReason?: string } = {}
  ): Promise<{ readonly round: DrawRound; readonly replayed: boolean; readonly gate: DrawCommitGate | null }> {
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
        return { round: this.project(existing), replayed: true, gate: null };
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

    let gate: DrawCommitGate | null = null;
    if (this.sessions.has(commitment.drawId)) {
      gate = await this.assertCommitFromSession(commitment, context, options.overrideReason);
    } else if (!this.allowSessionlessCommit) {
      throw new DrawError("NOT_FOUND", "draw_not_found");
    }

    this.commitments.set(commitment.drawId, commitment);
    this.commitmentKeys.set(key, commitment.drawId);
    this.nonceDeadlines.set(
      commitment.drawId,
      new Date(this.clock().getTime() + (this.cycles.get(commitment.cycleId)?.nonceWindowHours ?? 48) * 3_600_000).toISOString()
    );
    const roundKey = `${commitment.cycleId}:${commitment.round}`;
    this.commitmentsPerRound.set(roundKey, (this.commitmentsPerRound.get(roundKey) ?? 0) + 1);
    void this.clock();
    if (gate !== null && gate.overridden) {
      const session = this.requireSession(commitment.drawId);
      this.gateOverrideLog.push({
        cycleId: session.cycleId,
        round: session.round,
        drawId: session.drawId,
        actorId: context.userId,
        reason: (options.overrideReason ?? "").trim(),
        flagged: gate.flagged,
        stage: "commit"
      });
    }
    return { round: this.project(commitment), replayed: false, gate };
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
    if (this.cancellationOf(reveal.drawId) !== undefined) throw new DrawError("DRAW_CANCELLED", "draw_cancelled");
    for (const [otherId, other] of this.commitments) {
      if (otherId !== reveal.drawId && other.cycleId === commitment.cycleId && other.round === commitment.round && this.reveals.has(otherId)) {
        throw new DrawError("ALREADY_REVEALED", "draw_round_already_revealed");
      }
    }
    if (commitment.protocolVersion === "v3") {
      // The database derives the winner and the split; so does the double. What the caller typed must EQUAL it.
      const expected = await openReveal(
        commitment,
        { seed: reveal.seed, memberNonces: reveal.memberNonces, revealedBy: reveal.revealedBy, revealedAt: reveal.revealedAt },
        this.hasher
      );
      const derived = expected.reveal;
      if (
        derived.transcriptDigest !== reveal.transcriptDigest ||
        derived.selectionDigest !== reveal.selectionDigest ||
        derived.selectedIndex !== reveal.selectedIndex ||
        derived.winnerMemberId !== reveal.winnerMemberId ||
        derived.winningTicket !== reveal.winningTicket ||
        derived.payoutAmount !== reveal.payoutAmount ||
        derived.reserveAmount !== reveal.reserveAmount
      ) {
        throw new DrawError("INTEGRITY_FAILURE", "draw_selection_mismatch");
      }
    }
    if (this.sessions.has(reveal.drawId)) {
      // A session-backed reveal can be nothing but what was published when it was requested.
      const opening = this.openings.get(reveal.drawId);
      if (opening === undefined) {
        throw new DrawError("MEMBER_COMMITMENT_MISSING", "draw_member_commitment_missing");
      }
      if (opening.seed !== reveal.seed) throw new DrawError("COMMITMENT_MISMATCH", "draw_commitment_mismatch");
      const same =
        reveal.memberNonces.length === opening.memberNonces.length &&
        reveal.memberNonces.every((entry) =>
          opening.memberNonces.some((stored) => stored.memberId === entry.memberId && stored.nonce === entry.nonce)
        );
      if (!same) throw new DrawError("MEMBER_COMMITMENT_MISMATCH", "draw_member_commitment_mismatch");
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

  async listCancellations(cycleId: string, context: DrawActorContext): Promise<readonly DrawCancellation[]> {
    const row = this.cycles.get(cycleId.toLowerCase());
    if (row === undefined || !this.isMember(row.groupId, context.userId)) this.forbid();
    return this.cancellationLog
      .filter((entry) => entry.cycleId === cycleId.toLowerCase())
      .sort((left, right) => left.round - right.round || (left.cancelledAt < right.cancelledAt ? -1 : left.cancelledAt > right.cancelledAt ? 1 : 0));
  }

  /** Mirrors cancel_draw_v1: deadlines, the opened-reveal rule, the limit, the audit row. */
  async cancelDraw(
    input: { readonly drawId: string; readonly reason: string },
    context: DrawActorContext
  ): Promise<{ readonly cancellation: DrawCancellation; readonly replayed: boolean }> {
    const session = this.requireSession(input.drawId);
    if (!this.isManager(session.groupId, context.userId)) this.forbid();
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 1000) throw new DrawError("INVALID_REQUEST", "draw_cancel_reason_invalid");
    const existing = this.cancellationOf(session.drawId);
    if (existing !== undefined) return { cancellation: existing, replayed: true };
    if (this.reveals.has(session.drawId)) throw new DrawError("ALREADY_REVEALED", "draw_already_revealed");

    const now = this.clock().getTime();
    const commitment = this.commitments.get(session.drawId);
    let stage: "sealing" | "committed";
    let deadline: string;
    let missed: string[];
    if (commitment === undefined) {
      stage = "sealing";
      deadline = session.sealDeadline;
      if (now < new Date(deadline).getTime()) throw new DrawError("CANCEL_TOO_EARLY", "draw_cancel_too_early");
      const sealed = this.seals.get(session.drawId) ?? new Map<string, DrawSessionSeal>();
      missed = this.sessionEligible(session).filter((id) => !sealed.has(id));
    } else {
      stage = "committed";
      deadline = this.nonceDeadlines.get(session.drawId) ?? commitment.committedAt;
      if (this.openings.has(session.drawId)) throw new DrawError("CANCEL_REVEAL_OPENED", "draw_reveal_opened");
      if (now < new Date(deadline).getTime()) throw new DrawError("CANCEL_TOO_EARLY", "draw_cancel_too_early");
      const released = this.nonces.get(session.drawId) ?? new Map<string, string>();
      missed = commitment.memberCommitments.map((seal) => seal.memberId).filter((id) => !released.has(id));
    }
    if (missed.length === 0) throw new DrawError("CANCEL_NOTHING_MISSED", "draw_cancel_nothing_missed");

    const prior = this.cancellationLog.filter((entry) => entry.cycleId === session.cycleId && entry.round === session.round).length;
    if (prior >= DRAW_CANCEL_LIMIT && !this.isOwner(session.groupId, context.userId)) {
      throw new DrawError("CANCEL_LIMIT_REACHED", "draw_cancel_limit_reached");
    }
    const cancellation: DrawCancellation = {
      cancellationId: this.idFactory(),
      drawId: session.drawId,
      cycleId: session.cycleId,
      round: session.round,
      stage,
      reason,
      missedMembers: sortStrings(missed),
      deadlineAt: deadline,
      ownerDecision: prior >= DRAW_CANCEL_LIMIT,
      cancelledBy: context.userId,
      cancelledAt: this.clock().toISOString()
    };
    this.cancellationLog.push(cancellation);
    return { cancellation, replayed: false };
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
