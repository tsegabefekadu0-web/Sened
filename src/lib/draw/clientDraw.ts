/**
 * Browser side of the draw: the API client for `/api/draw/*`, the on-device
 * recomputation that makes a draw "verifiable", and the small amount of
 * out-of-band protocol (sealed contributions, openings) the server does not
 * carry.
 *
 * Browser-reachable on purpose: only `webDrawHasher` is used for hashing, and
 * nothing here imports the server service, repository or route handlers.
 */

import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { loadMembers, type MemberRow } from "@/lib/ledger/clientInvites";
import { readMyGroup } from "@/lib/ledger/clientRead";
import { formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";
import type { MessageKey } from "@/lib/i18n";

import { webDrawHasher, type DrawVerificationTranscript } from "./canonical";
import { findBadOpenings, sealMemberContribution, verifyTranscript } from "./engine";
import { assessDrawRisk, planReserve } from "./risk";
import {
  isDrawProtocolVersion,
  type DrawMemberCommitment,
  type DrawMemberNonce,
  type DrawRiskAssessment,
  type DrawRoundState,
  type DrawVerificationResult
} from "./types";

// -- roles --------------------------------------------------------------------

export function canRunTreasurerSteps(role: string | null): boolean {
  return role === "owner" || role === "treasurer";
}

// -- group + roster -----------------------------------------------------------

export interface DrawGroup {
  readonly groupId: string;
  readonly role: string | null;
  readonly members: readonly MemberRow[];
  readonly potCashAccountId: string | null;
  readonly payoutExpenseAccountId: string | null;
  readonly potCashCode: "POT_CASH";
  readonly payoutExpenseCode: "PAYOUT_EXPENSE";
}

export type DrawGroupRead =
  | { readonly status: "ok"; readonly group: DrawGroup }
  | { readonly status: "unauthorized" | "no-group" | "multiple-groups" | "error" };

/**
 * The caller's single group, its roster and its canonical payout accounts.
 * Refuses on none or several groups (see `readMyGroup`): choosing for the
 * caller is how a payout lands on the wrong ledger.
 */
export async function readDrawGroup(deps: AuthedFetchDeps = {}): Promise<DrawGroupRead> {
  const mine = await readMyGroup(deps);
  if (mine.status !== "ok") {
    return { status: mine.status };
  }
  const members = await loadMembers(mine.groupId, deps);
  if (members.status === "unauthorized") return { status: "unauthorized" };
  if (members.status !== "ready") return { status: "error" };
  const byCode = new Map(mine.accounts.map((account) => [account.code, account.id]));
  return {
    status: "ok",
    group: {
      groupId: mine.groupId,
      role: mine.role,
      members: members.members,
      potCashAccountId: byCode.get("POT_CASH") ?? null,
      payoutExpenseAccountId: byCode.get("PAYOUT_EXPENSE") ?? null,
      potCashCode: "POT_CASH",
      payoutExpenseCode: "PAYOUT_EXPENSE"
    }
  };
}

/**
 * The signed-in user's id, read from the access token's `sub` claim. Used only
 * to say whose sealed contribution this device is making; the server never
 * trusts it (every route re-verifies the token itself).
 */
export function userIdFromAccessToken(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

// -- errors -------------------------------------------------------------------

export interface DrawFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  /** The server's own message, shown as detail next to the translated one. */
  readonly message: string | null;
}

export type DrawResult<T> = { readonly ok: true; readonly status: number; readonly data: T } | DrawFailure;

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  unauthorized: "drawLive.error.unauthorized",
  forbidden: "drawLive.error.forbidden",
  not_configured: "drawLive.error.notConfigured",
  auth_unavailable: "drawLive.error.unavailable",
  unavailable: "drawLive.error.unavailable",
  rate_limited: "drawLive.error.rateLimited",
  bad_request: "drawLive.error.invalidRequest",
  invalid_request: "drawLive.error.invalidRequest",
  invalid_amount: "drawLive.error.invalidRequest",
  not_found: "drawLive.error.notFound",
  not_committed: "drawLive.error.notCommitted",
  already_committed: "drawLive.error.alreadyCommitted",
  already_revealed: "drawLive.error.alreadyRevealed",
  idempotency_conflict: "drawLive.error.conflict",
  repeat_winner: "drawLive.error.repeatWinner",
  round_out_of_order: "drawLive.error.roundOutOfOrder",
  no_eligible_participants: "drawLive.error.noEligible",
  commitment_mismatch: "drawLive.error.commitmentMismatch",
  member_commitment_missing: "drawLive.error.memberMissing",
  member_commitment_mismatch: "drawLive.error.memberMismatch",
  uniformity_exhausted: "drawLive.error.integrity",
  integrity_failure: "drawLive.error.integrity",
  storage_failure: "drawLive.error.storage",
  draw_failed: "drawLive.error.storage",
  bad_response: "drawLive.error.badResponse",
  network: "drawLive.error.network"
};

/** The bilingual message for a server error code, falling back on the HTTP status. */
export function drawErrorKey(failure: Pick<DrawFailure, "code" | "status">): MessageKey {
  const direct = ERROR_KEYS[failure.code];
  if (direct) return direct;
  if (failure.status === 401) return "drawLive.error.unauthorized";
  if (failure.status === 403) return "drawLive.error.forbidden";
  if (failure.status === 404) return "drawLive.error.notFound";
  if (failure.status === 429) return "drawLive.error.rateLimited";
  if (failure.status === 503) return "drawLive.error.unavailable";
  return "drawLive.error.generic";
}

async function call(
  path: string,
  init: RequestInit,
  deps: AuthedFetchDeps
): Promise<DrawResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await authedFetch(path, init, deps);
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return { ok: false, status: 401, code: "unauthorized", message: null };
    }
    return { ok: false, status: 0, code: "network", message: null };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof body?.error === "string" ? body.error : "unknown",
      message: typeof body?.message === "string" ? body.message : null
    };
  }
  if (body === null || typeof body !== "object") {
    return { ok: false, status: response.status, code: "bad_response", message: null };
  }
  return { ok: true, status: response.status, data: body };
}

// -- wire shapes --------------------------------------------------------------

export interface WireRound {
  readonly drawId: string;
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly commitment: string;
  readonly rosterDigest: string;
  readonly participantCount: number;
  readonly potAmount: string;
  readonly totalRounds: number;
  readonly reserveRatioBps: number;
  readonly state: DrawRoundState;
  readonly committedAt: string;
  readonly revealed: boolean;
  readonly winnerMemberId: string | null;
  readonly payoutAmount: string | null;
  readonly reserveAmount: string | null;
  readonly payout: {
    readonly ledgerEntryId: string;
    readonly amount: string;
    readonly winnerMemberId: string;
    readonly postedAt: string;
  } | null;
}

export interface WireServerVerification {
  readonly verified: boolean;
  readonly codes: readonly string[];
  readonly warnings: readonly string[];
  readonly winnerMemberId: string | null;
  readonly transcriptDigest: string | null;
  /** Digest of the verified member nonces (v3). Absent from servers that predate v3. */
  readonly nonceDigest?: string | null;
}

export interface WireVerify {
  readonly round: WireRound;
  readonly verification: WireServerVerification;
  readonly transcript: DrawVerificationTranscript;
  readonly memberNonces: readonly DrawMemberNonce[];
}

const isString = (value: unknown): value is string => typeof value === "string";

function isWireRound(value: unknown): value is WireRound {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isString(row.drawId) &&
    isString(row.groupId) &&
    isString(row.cycleId) &&
    typeof row.round === "number" &&
    isString(row.commitment) &&
    isString(row.rosterDigest) &&
    typeof row.participantCount === "number" &&
    isString(row.potAmount) &&
    typeof row.totalRounds === "number" &&
    typeof row.reserveRatioBps === "number" &&
    (row.state === "committed" || row.state === "revealed" || row.state === "paid") &&
    typeof row.revealed === "boolean"
  );
}

function isTranscript(value: unknown): value is DrawVerificationTranscript {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isString(row.drawId) &&
    isString(row.groupId) &&
    isString(row.cycleId) &&
    typeof row.round === "number" &&
    isString(row.commitment) &&
    isString(row.rosterDigest) &&
    isString(row.commitmentNonce) &&
    isString(row.memberDigest) &&
    (row.protocolVersion === undefined || isDrawProtocolVersion(row.protocolVersion)) &&
    Array.isArray(row.memberCommitments) &&
    isString(row.seed) &&
    Array.isArray(row.participants)
  );
}

function badResponse(status: number): DrawFailure {
  return { ok: false, status, code: "bad_response", message: null };
}

// -- API calls ------------------------------------------------------------------

export interface CommitInput {
  readonly groupId: string;
  readonly cycleId: string;
  readonly round: number;
  readonly totalRounds: number;
  readonly drawId: string;
  readonly commitmentNonce: string;
  readonly seed: string;
  readonly memberCommitments: readonly DrawMemberCommitment[];
  readonly potAmount: string;
  readonly reserveRatioBps: number;
  readonly members: readonly {
    readonly memberId: string;
    readonly displayName: string;
    readonly contributionAmount: string;
  }[];
  readonly idempotencyKey: string;
}

/** `POST /api/draw/commits` — owner or treasurer. */
export async function commitDraw(
  input: CommitInput,
  deps: AuthedFetchDeps = {}
): Promise<DrawResult<{ readonly round: WireRound; readonly replayed: boolean }>> {
  const result = await call("/api/draw/commits", { method: "POST", body: JSON.stringify(input) }, deps);
  if (!result.ok) return result;
  if (!isWireRound(result.data.round)) return badResponse(result.status);
  return { ok: true, status: result.status, data: { round: result.data.round, replayed: result.data.replayed === true } };
}

/** `POST /api/draw/reveals` — owner or treasurer. */
export async function revealDraw(
  input: {
    readonly drawId: string;
    readonly seed: string;
    readonly memberNonces: readonly DrawMemberNonce[];
    readonly idempotencyKey: string;
  },
  deps: AuthedFetchDeps = {}
): Promise<
  DrawResult<{ readonly round: WireRound; readonly verification: WireServerVerification; readonly risk: DrawRiskAssessment | null }>
> {
  const result = await call("/api/draw/reveals", { method: "POST", body: JSON.stringify(input) }, deps);
  if (!result.ok) return result;
  if (!isWireRound(result.data.round) || typeof result.data.verification !== "object" || result.data.verification === null) {
    return badResponse(result.status);
  }
  return {
    ok: true,
    status: result.status,
    data: {
      round: result.data.round,
      verification: result.data.verification as WireServerVerification,
      risk: (result.data.risk ?? null) as DrawRiskAssessment | null
    }
  };
}

/** `POST /api/draw/verify` — any member. Returns what the browser recomputes from. */
export async function fetchVerification(drawId: string, deps: AuthedFetchDeps = {}): Promise<DrawResult<WireVerify>> {
  const result = await call("/api/draw/verify", { method: "POST", body: JSON.stringify({ drawId }) }, deps);
  if (!result.ok) return result;
  const { round, verification, transcript, memberNonces } = result.data;
  if (!isWireRound(round) || typeof verification !== "object" || verification === null || !isTranscript(transcript)) {
    return badResponse(result.status);
  }
  return {
    ok: true,
    status: result.status,
    data: {
      round,
      verification: verification as WireServerVerification,
      transcript,
      memberNonces: Array.isArray(memberNonces) ? (memberNonces as DrawMemberNonce[]) : []
    }
  };
}

export interface PayoutReceipt {
  readonly round: WireRound;
  readonly ledgerEntryId: string;
  readonly ledgerSequence: string | null;
  readonly ledgerEntryHash: string | null;
  readonly replayed: boolean;
}

/** `POST /api/draw/payouts` — owner or treasurer. Posts a real ledger disbursement. */
export async function postPayout(
  input: { readonly drawId: string; readonly cashAccountId: string; readonly payoutAccountId: string },
  deps: AuthedFetchDeps = {}
): Promise<DrawResult<PayoutReceipt>> {
  const result = await call("/api/draw/payouts", { method: "POST", body: JSON.stringify(input) }, deps);
  if (!result.ok) return result;
  const { round, ledgerEntryId, ledgerSequence, ledgerEntryHash, replayed } = result.data;
  if (!isWireRound(round) || !isString(ledgerEntryId)) return badResponse(result.status);
  return {
    ok: true,
    status: result.status,
    data: {
      round,
      ledgerEntryId,
      ledgerSequence: ledgerSequence === undefined || ledgerSequence === null ? null : String(ledgerSequence),
      ledgerEntryHash: isString(ledgerEntryHash) ? ledgerEntryHash : null,
      replayed: replayed === true
    }
  };
}

// -- the browser's own verification ----------------------------------------------

export type DisagreementKind =
  | "identity"
  | "verdict"
  | "winner"
  | "digest"
  | "nonceDigest"
  | "recordedWinner"
  | "payout";

export interface BrowserCheck {
  /** Recomputed on this device from the published values. The one to believe. */
  readonly local: DrawVerificationResult;
  readonly revealed: boolean;
  /** Where this device and the server differ. Empty means they agree. */
  readonly disagreements: readonly DisagreementKind[];
  /** Reserve and payout recomputed here, from the published round values. */
  readonly risk: DrawRiskAssessment | null;
  /** True only when this device verified, and the server agrees with it. */
  readonly trusted: boolean;
}

/**
 * Every sealed contribution must be opened by a nonce that hashes back to it.
 * Returns the members whose opening is missing or wrong.
 */
export async function checkOpenings(
  drawId: string,
  sealed: readonly DrawMemberCommitment[],
  nonces: readonly DrawMemberNonce[]
): Promise<readonly string[]> {
  return findBadOpenings(drawId, sealed, nonces, webDrawHasher);
}

/**
 * Recompute a published draw in the browser and compare it with what the server
 * claims. The server's verdict is a claim to be checked, never the answer: a
 * server that reports a different winner, digest or payout than the arithmetic
 * produces is itself the tamper signal.
 */
export async function verifyInBrowser(wire: WireVerify): Promise<BrowserCheck> {
  const { round } = wire;
  // The nonces arrive beside the transcript on the wire. Fold them in so the one
  // verifier that derives the winner is also the one that checks every opening:
  // in v3 the winner depends on them, so there is no separate "opening check"
  // that could pass while the selection used something else.
  const transcript: DrawVerificationTranscript = { ...wire.transcript, memberNonces: wire.memberNonces };
  const revealed = round.revealed && transcript.seed.length > 0;

  const local = await verifyTranscript(transcript, webDrawHasher);

  const disagreements: DisagreementKind[] = [];
  if (
    round.drawId !== transcript.drawId ||
    round.groupId !== transcript.groupId ||
    round.cycleId !== transcript.cycleId ||
    round.round !== transcript.round ||
    round.commitment !== transcript.commitment ||
    round.rosterDigest !== transcript.rosterDigest ||
    round.participantCount !== transcript.participants.length
  ) {
    disagreements.push("identity");
  }

  let risk: DrawRiskAssessment | null = null;
  if (revealed) {
    if (wire.verification.verified !== local.verified) disagreements.push("verdict");
    if (local.verified && round.winnerMemberId !== local.winnerMemberId) disagreements.push("winner");
    if (
      wire.verification.transcriptDigest !== null &&
      local.transcriptDigest !== null &&
      wire.verification.transcriptDigest !== local.transcriptDigest
    ) {
      disagreements.push("digest");
    }
    if (
      wire.verification.nonceDigest !== undefined &&
      wire.verification.nonceDigest !== null &&
      local.nonceDigest !== null &&
      wire.verification.nonceDigest !== local.nonceDigest
    ) {
      disagreements.push("nonceDigest");
    }
    if (
      wire.verification.winnerMemberId !== null &&
      local.winnerMemberId !== null &&
      wire.verification.winnerMemberId !== local.winnerMemberId
    ) {
      disagreements.push("recordedWinner");
    }
    risk = recomputeRisk(round, transcript);
    if (
      local.verified &&
      (risk === null || risk.payoutAmount !== round.payoutAmount || risk.reserveAmount !== round.reserveAmount)
    ) {
      disagreements.push("payout");
    }
  }

  const warnings = [...local.warnings, ...wire.verification.warnings];
  return {
    local: { ...local, warnings },
    revealed,
    disagreements,
    risk,
    trusted: revealed && local.verified && disagreements.length === 0
  };
}

function recomputeRisk(round: WireRound, transcript: DrawVerificationTranscript): DrawRiskAssessment | null {
  const share = transcript.participants[0]?.contributionAmount;
  if (share === undefined) return null;
  try {
    const request = {
      drawId: round.drawId,
      round: round.round,
      potAmount: round.potAmount,
      reserveRatioBps: round.reserveRatioBps,
      totalRounds: round.totalRounds,
      contributionAmount: share,
      eligibleCount: transcript.participants.length
    };
    return assessDrawRisk(request, planReserve(request));
  } catch {
    return null;
  }
}

// -- sealed contributions (out-of-band protocol) -----------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;

export function randomHex(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface MySeal {
  readonly drawId: string;
  readonly memberId: string;
  readonly nonce: string;
  readonly sealed: string;
}

/** Seal this member's contribution on this device. Only `sealed` is ever shared. */
export async function sealForDraw(drawId: string, memberId: string): Promise<MySeal> {
  const nonce = randomHex();
  const contribution = await sealMemberContribution({ drawId, memberId, nonce }, webDrawHasher);
  return { drawId, memberId, nonce, sealed: contribution.sealed };
}

/** `memberId:sealedHash` — what a member sends the treasurer before the commit. */
export const sealLine = (seal: Pick<MySeal, "memberId" | "sealed">): string => `${seal.memberId}:${seal.sealed}`;
/** `memberId:nonce` — what a member sends the treasurer for the reveal. */
export const openingLine = (seal: Pick<MySeal, "memberId" | "nonce">): string => `${seal.memberId}:${seal.nonce}`;

/**
 * Has the treasurer's commitment been published with THIS member's seal in it?
 *
 * A member's nonce decides the winner, and it is only unknown to the treasurer
 * for as long as the member keeps it. Releasing it before the commitment is
 * published hands the treasurer the one input they could not grind over, so the
 * UI offers the opening line only once this returns true: the published round is
 * this draw, and the sealed set it committed to contains the member's own hash.
 */
export function commitmentPublishedFor(
  wire: Pick<WireVerify, "round" | "transcript"> | null,
  seal: Pick<MySeal, "drawId" | "memberId" | "sealed"> | null
): boolean {
  if (wire === null || seal === null) return false;
  if (wire.round.drawId !== seal.drawId || wire.transcript.drawId !== seal.drawId) return false;
  return wire.transcript.memberCommitments.some(
    (entry) => entry.memberId === seal.memberId && entry.sealed === seal.sealed
  );
}

export type LineParse<T> =
  | { readonly ok: true; readonly entries: readonly T[] }
  | { readonly ok: false; readonly line: number };

function parseLines<T>(text: string, build: (memberId: string, value: string) => T | null): LineParse<T> {
  const entries: T[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const split = line.indexOf(":");
    const memberId = split === -1 ? "" : line.slice(0, split).trim().toLowerCase();
    const value = split === -1 ? "" : line.slice(split + 1).trim();
    const entry = UUID.test(memberId) && !seen.has(memberId) ? build(memberId, value) : null;
    if (entry === null) return { ok: false, line: index + 1 };
    seen.add(memberId);
    entries.push(entry);
  }
  return { ok: true, entries };
}

export function parseSealLines(text: string): LineParse<DrawMemberCommitment> {
  return parseLines(text, (memberId, value) =>
    HEX_64.test(value.toLowerCase()) ? { memberId, sealed: value.toLowerCase() } : null
  );
}

export function parseOpeningLines(text: string): LineParse<DrawMemberNonce> {
  return parseLines(text, (memberId, value) =>
    value.length >= 16 && value.length <= 256 && /^[!-~]+$/.test(value) ? { memberId, nonce: value } : null
  );
}

// -- pot ---------------------------------------------------------------------------

/** Pot = per-member contribution × roster size, in exact minor units. Null if the amount is invalid. */
export function potFromContribution(contribution: string, memberCount: number): string | null {
  try {
    const minor = toEtbMinorUnits(contribution, true);
    return formatEtbMinorUnits(minor * BigInt(memberCount));
  } catch {
    return null;
  }
}

/** Normalise a typed amount (`5000`, `5000.5`) to the wire form with two decimals, or null. */
export function normaliseAmount(value: string): string | null {
  try {
    return formatEtbMinorUnits(toEtbMinorUnits(value.trim(), true));
  } catch {
    return null;
  }
}

// -- browser storage (per-device convenience; every access may throw) -------------

export interface DrawDraft {
  readonly drawId: string;
  readonly seed: string;
  readonly commitmentNonce: string;
  readonly commitKey: string;
  readonly revealKey: string;
  /** Set once the commit succeeded, so a reload resumes at the reveal. */
  readonly committed: boolean;
  /** Set once the reveal succeeded. The seed is public then and is wiped from storage. */
  readonly revealed?: boolean;
}

const DRAFT_KEY = (groupId: string) => `sened.draw.draft.${groupId}`;
const SEAL_KEY = (drawId: string) => `sened.draw.seal.${drawId}`;

export function readDraft(groupId: string): DrawDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_KEY(groupId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DrawDraft>;
    return isString(parsed.drawId) &&
      isString(parsed.seed) &&
      isString(parsed.commitmentNonce) &&
      isString(parsed.commitKey) &&
      isString(parsed.revealKey)
      ? (parsed as DrawDraft)
      : null;
  } catch {
    return null;
  }
}

export function writeDraft(groupId: string, draft: DrawDraft | null): void {
  try {
    if (draft === null) globalThis.localStorage?.removeItem(DRAFT_KEY(groupId));
    else globalThis.localStorage?.setItem(DRAFT_KEY(groupId), JSON.stringify(draft));
  } catch {
    // Storage may be blocked. The ceremony still works for this session.
  }
}

export function readSeal(drawId: string): MySeal | null {
  try {
    const raw = globalThis.localStorage?.getItem(SEAL_KEY(drawId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MySeal>;
    return isString(parsed.drawId) && isString(parsed.memberId) && isString(parsed.nonce) && isString(parsed.sealed)
      ? (parsed as MySeal)
      : null;
  } catch {
    return null;
  }
}

export function writeSeal(seal: MySeal): void {
  try {
    globalThis.localStorage?.setItem(SEAL_KEY(seal.drawId), JSON.stringify(seal));
  } catch {
    // Not fatal: the nonce is also shown on screen to copy.
  }
}

export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}
