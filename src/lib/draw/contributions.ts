import { isDrawContributionGate, type DrawContributionGate, type DrawGateFlag } from "./types";

/**
 * Per-round contribution status for EVERY member and EVERY round of a cycle
 * (`get_draw_cycle_contributions_v1`, `docs/architecture/draw.md` §18).
 *
 * Nothing here is stored as a status. The database derives, on every read, for each
 * (member, round):
 *
 *   met      a qualifying contribution is assigned to the round;
 *   flagged  NOT met, and the round is DUE (its draw has been opened);
 *   not_due  NOT met, and its draw has not been opened yet.
 *
 * There is deliberately no `partial`: an amount under the cycle's contribution does not
 * qualify, and one qualifying entry pays one round (§18.1 says why). The qualifying rules,
 * the assignment (explicit cycle+round, else by order into the earliest unmet due round) and
 * the split at a winner's win are the ones in §17.3 / §18.1.
 *
 * `flagged` is a flag, not a verdict: the ledger cannot show the contribution. It clears the
 * moment an attributed entry exists. ADVISORY apart from the contribution gate (§18.2), which
 * is a policy the group chose for the cycle: nothing here moves money.
 */

export type ContributionStatus = "met" | "flagged" | "not_due";
export type ContributionSource = "bank_verification" | "treasurer";

export interface ContributionCell {
  readonly round: number;
  readonly status: ContributionStatus;
  /** The entry that meets the round, when one does. */
  readonly entryId: string | null;
  /** How the ledger knows who paid that entry. */
  readonly source: ContributionSource | null;
}

export interface ContributionMember {
  readonly memberId: string;
  /** An active member now. A winner who left is still listed (they still owe the cycle) but is not gated. */
  readonly active: boolean;
  /** The round they won, or `null` if they have not won. */
  readonly winRound: number | null;
  /** One cell per round, round 1 first. */
  readonly cells: readonly ContributionCell[];
}

export interface ContributionRound {
  readonly round: number;
  /** When the round's draw was first opened (the round became due), or `null`. */
  readonly dueAt: string | null;
  readonly revealedAt: string | null;
}

export interface GateEvent {
  readonly at: string;
  readonly actorId: string;
  readonly from: DrawContributionGate;
  readonly to: DrawContributionGate;
  readonly reason: string;
}

export interface GateOverride {
  readonly at: string;
  readonly actorId: string;
  /** The round whose draw the override opened. */
  readonly round: number;
  readonly drawId: string;
  readonly reason: string;
  /** Exactly which flagged (member, round) pairs were overridden. */
  readonly flagged: readonly DrawGateFlag[];
  /** Where it was given: when the draw was opened, or when it was committed (§18.5). Older servers say nothing: `open`. */
  readonly stage: "open" | "commit";
}

export interface CycleContributions {
  readonly cycleId: string;
  readonly groupId: string;
  readonly totalRounds: number;
  /** ETB, two decimals. `null` for a cycle created before cycles carried a contribution. */
  readonly contributionAmount: string | null;
  readonly startedAt: string;
  /** The effective gate: the latest change, else the policy chosen at creation. */
  readonly contributionGate: DrawContributionGate;
  readonly nextRound: number | null;
  /** Flagged cells of ACTIVE members. */
  readonly flaggedCount: number;
  readonly rounds: readonly ContributionRound[];
  readonly members: readonly ContributionMember[];
  readonly gateEvents: readonly GateEvent[];
  readonly overrides: readonly GateOverride[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^\d{1,18}\.\d{2}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isRound(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000;
}

function parseCell(value: unknown, expectedRound: number): ContributionCell | null {
  const row = record(value);
  if (row === null) return null;
  const entryId = row.entryId ?? null;
  const source = row.source ?? null;
  if (
    row.round !== expectedRound ||
    (row.status !== "met" && row.status !== "flagged" && row.status !== "not_due") ||
    (entryId !== null && !isUuid(entryId)) ||
    (source !== null && source !== "bank_verification" && source !== "treasurer") ||
    // A met cell names its entry and how the payer is known; the others name neither.
    (row.status === "met") !== (entryId !== null && source !== null) ||
    (row.status !== "met" && (entryId !== null || source !== null))
  ) {
    return null;
  }
  return {
    round: expectedRound,
    status: row.status,
    entryId: entryId === null ? null : (entryId as string).toLowerCase(),
    source: source as ContributionSource | null
  };
}

function parseMember(value: unknown, totalRounds: number): ContributionMember | null {
  const row = record(value);
  if (row === null) return null;
  const winRound = row.winRound ?? null;
  if (
    !isUuid(row.memberId) ||
    typeof row.active !== "boolean" ||
    (winRound !== null && (!isRound(winRound) || winRound > totalRounds)) ||
    !Array.isArray(row.cells) ||
    row.cells.length !== totalRounds
  ) {
    return null;
  }
  const cells: ContributionCell[] = [];
  for (let index = 0; index < totalRounds; index += 1) {
    const cell = parseCell(row.cells[index], index + 1);
    if (cell === null) return null;
    cells.push(cell);
  }
  return { memberId: row.memberId.toLowerCase(), active: row.active, winRound: winRound as number | null, cells };
}

function parseFlags(value: unknown): DrawGateFlag[] | null {
  if (!Array.isArray(value)) return null;
  const flags: DrawGateFlag[] = [];
  for (const raw of value) {
    const row = record(raw);
    if (row === null || !isUuid(row.memberId) || !isRound(row.round)) return null;
    flags.push({ memberId: row.memberId.toLowerCase(), round: row.round });
  }
  return flags;
}

/** The derived grid as the database returns it; anything malformed is `null`, never a guess. */
export function parseCycleContributions(value: unknown): CycleContributions | null {
  const row = record(value);
  if (row === null) return null;
  const contribution = row.contributionAmount ?? null;
  const next = row.nextRound ?? null;
  if (
    !isUuid(row.cycleId) ||
    !isUuid(row.groupId) ||
    !isRound(row.totalRounds) ||
    (contribution !== null && (typeof contribution !== "string" || !MONEY.test(contribution))) ||
    !isTime(row.startedAt) ||
    !isDrawContributionGate(row.contributionGate) ||
    (next !== null && !isRound(next)) ||
    typeof row.flaggedCount !== "number" ||
    !Number.isSafeInteger(row.flaggedCount) ||
    row.flaggedCount < 0 ||
    !Array.isArray(row.rounds) ||
    row.rounds.length !== row.totalRounds ||
    !Array.isArray(row.members) ||
    !Array.isArray(row.gateEvents) ||
    !Array.isArray(row.overrides)
  ) {
    return null;
  }
  const totalRounds = row.totalRounds;
  const rounds: ContributionRound[] = [];
  for (let index = 0; index < totalRounds; index += 1) {
    const raw = record(row.rounds[index]);
    if (raw === null || raw.round !== index + 1) return null;
    const dueAt = raw.dueAt ?? null;
    const revealedAt = raw.revealedAt ?? null;
    if ((dueAt !== null && !isTime(dueAt)) || (revealedAt !== null && !isTime(revealedAt))) return null;
    rounds.push({ round: index + 1, dueAt: dueAt as string | null, revealedAt: revealedAt as string | null });
  }
  const members: ContributionMember[] = [];
  for (const raw of row.members) {
    const parsed = parseMember(raw, totalRounds);
    if (parsed === null) return null;
    members.push(parsed);
  }
  const gateEvents: GateEvent[] = [];
  for (const raw of row.gateEvents) {
    const event = record(raw);
    if (
      event === null ||
      !isTime(event.at) ||
      !isUuid(event.actorId) ||
      !isDrawContributionGate(event.from) ||
      !isDrawContributionGate(event.to) ||
      typeof event.reason !== "string"
    ) {
      return null;
    }
    gateEvents.push({ at: event.at, actorId: event.actorId.toLowerCase(), from: event.from, to: event.to, reason: event.reason });
  }
  const overrides: GateOverride[] = [];
  for (const raw of row.overrides) {
    const override = record(raw);
    const flagged = override === null ? null : parseFlags(override.flagged);
    if (
      override === null ||
      flagged === null ||
      !isTime(override.at) ||
      !isUuid(override.actorId) ||
      !isRound(override.round) ||
      !isUuid(override.drawId) ||
      typeof override.reason !== "string" ||
      (override.stage !== undefined && override.stage !== "open" && override.stage !== "commit")
    ) {
      return null;
    }
    overrides.push({
      at: override.at,
      actorId: override.actorId.toLowerCase(),
      round: override.round,
      drawId: override.drawId.toLowerCase(),
      reason: override.reason,
      flagged,
      stage: override.stage === "commit" ? "commit" : "open"
    });
  }
  return {
    cycleId: row.cycleId.toLowerCase(),
    groupId: row.groupId.toLowerCase(),
    totalRounds,
    contributionAmount: contribution as string | null,
    startedAt: row.startedAt,
    contributionGate: row.contributionGate,
    nextRound: next as number | null,
    flaggedCount: row.flaggedCount,
    rounds,
    members,
    gateEvents,
    overrides
  };
}

// -- derived figures ------------------------------------------------------------

/**
 * The flagged (member, round) pairs strictly before `beforeRound` for ACTIVE members: what the
 * gate looks at when that round is about to be opened. The same set the database computes.
 */
export function flaggedBefore(view: CycleContributions, beforeRound: number): readonly DrawGateFlag[] {
  const flags: DrawGateFlag[] = [];
  for (const member of view.members) {
    if (!member.active) continue;
    for (const cell of member.cells) {
      if (cell.status === "flagged" && cell.round < beforeRound) {
        flags.push({ memberId: member.memberId, round: cell.round });
      }
    }
  }
  return flags.sort((left, right) => left.round - right.round || (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0));
}

export interface ContributionGatePreview {
  readonly policy: DrawContributionGate;
  /** The round that opening a draw would start; `null` when the cycle is complete. */
  readonly round: number | null;
  readonly flagged: readonly DrawGateFlag[];
  /** `block` with something flagged: opening needs an override reason. */
  readonly needsOverride: boolean;
  /** `warn` with something flagged: opening needs a confirmation. */
  readonly needsConfirm: boolean;
}

/** What opening the next draw would meet, for the screen to show before it asks the server. */
export function previewGate(view: CycleContributions): ContributionGatePreview {
  const round = view.nextRound;
  const flagged = round === null || view.contributionGate === "off" ? [] : flaggedBefore(view, round);
  return {
    policy: view.contributionGate,
    round,
    flagged,
    needsOverride: view.contributionGate === "block" && flagged.length > 0,
    needsConfirm: view.contributionGate === "warn" && flagged.length > 0
  };
}

export interface CommitGatePreview {
  readonly policy: DrawContributionGate;
  /** The flagged (member, round) pairs before the draw's round, as the database will see them at commit. */
  readonly flagged: readonly DrawGateFlag[];
  /** The pairs the override given when this draw was opened named (empty when it was opened without one). */
  readonly acknowledged: readonly DrawGateFlag[];
  /** `block`, something flagged that the open override did not name: committing needs a reason. */
  readonly needsOverride: boolean;
  /** `block`, something flagged, and every pair is one the open override named: no new reason needed. */
  readonly carriedOver: boolean;
  /** `warn` with something flagged: committing needs a confirmation. */
  readonly needsConfirm: boolean;
}

/**
 * What committing the draw `drawId` (round `round`) would meet, for the screen to show before it asks
 * the server. The same rule as the database: an override given at open still stands for the pairs it
 * named, but not for a pair it did not (a set that merely shrank is covered; a set that gained a pair
 * is not, even at the same size).
 */
export function previewCommitGate(view: CycleContributions, drawId: string, round: number): CommitGatePreview {
  const flagged = view.contributionGate === "off" ? [] : flaggedBefore(view, round);
  const open = view.overrides.find((override) => override.drawId === drawId.toLowerCase() && override.stage === "open");
  const acknowledged = open === undefined ? [] : open.flagged;
  const known = new Set(acknowledged.map((flag) => `${flag.memberId.toLowerCase()}:${flag.round}`));
  const covered = flagged.every((flag) => known.has(`${flag.memberId.toLowerCase()}:${flag.round}`));
  const block = view.contributionGate === "block" && flagged.length > 0;
  return {
    policy: view.contributionGate,
    flagged,
    acknowledged,
    needsOverride: block && !covered,
    carriedOver: block && covered,
    needsConfirm: view.contributionGate === "warn" && flagged.length > 0
  };
}

export interface MemberTally {
  readonly met: number;
  readonly flagged: number;
  readonly notDue: number;
}

export function tallyMember(member: ContributionMember): MemberTally {
  let met = 0;
  let flagged = 0;
  let notDue = 0;
  for (const cell of member.cells) {
    if (cell.status === "met") met += 1;
    else if (cell.status === "flagged") flagged += 1;
    else notDue += 1;
  }
  return { met, flagged, notDue };
}
