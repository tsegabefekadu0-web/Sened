import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { pickGroup } from "./clientRead";

/**
 * Browser helpers for invite links, group members and the treasurer toggle.
 * Each maps the HTTP contract to a small closed set of statuses so the UI never
 * has to look at a status code, and "could not look" never renders as "nothing".
 */

export type MemberAttire = "none" | "gabi" | "netela";

function toAttire(value: unknown): MemberAttire | null {
  if (value === undefined || value === null) return "none";
  return value === "none" || value === "gabi" || value === "netela" ? value : null;
}

export type FailureStatus = "unauthorized" | "forbidden" | "rate-limited" | "error";

function failureFor(status: number): FailureStatus {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  return "error";
}

function caught(error: unknown): { readonly status: "unauthorized" | "error" } {
  return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
}

// -- the join URL -----------------------------------------------------------

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** The shareable link. The token is in the fragment so it never reaches a server log. */
export function buildJoinUrl(origin: string, token: string): string {
  return `${origin}/join#token=${encodeURIComponent(token)}`;
}

/** The token in a URL fragment such as `#token=abc`, or null when absent or malformed. */
export function parseTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("token");
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

// -- redeem -----------------------------------------------------------------

export type RedeemOutcome =
  | { readonly status: "joined"; readonly groupId: string }
  | { readonly status: "already_member"; readonly groupId: string }
  | { readonly status: "expired" | "revoked" | "exhausted" | "invalid" }
  | { readonly status: "unauthorized" | "rate-limited" | "error" };

export async function redeemInviteToken(token: string, deps: AuthedFetchDeps = {}): Promise<RedeemOutcome> {
  try {
    const response = await authedFetch(
      "/api/ledger/invites/redeem",
      { method: "POST", body: JSON.stringify({ token }) },
      deps
    );
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as { outcome?: unknown; groupId?: unknown } | null;
      if (
        body &&
        typeof body.groupId === "string" &&
        (body.outcome === "joined" || body.outcome === "already_member")
      ) {
        return { status: body.outcome, groupId: body.groupId };
      }
      return { status: "error" };
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    switch (response.status) {
      case 400:
      case 404:
        return { status: "invalid" };
      case 410:
        return body?.error === "invite_expired"
          ? { status: "expired" }
          : body?.error === "invite_revoked"
            ? { status: "revoked" }
            : body?.error === "invite_exhausted"
              ? { status: "exhausted" }
              : { status: "invalid" };
      case 401:
        return { status: "unauthorized" };
      case 429:
        return { status: "rate-limited" };
      default:
        return { status: "error" };
    }
  } catch (error) {
    return caught(error);
  }
}

// -- create / list / revoke -------------------------------------------------

export interface CreatedInvite {
  readonly inviteId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly maxUses: number;
}

export type CreateInviteOutcome =
  | ({ readonly status: "created" } & CreatedInvite)
  | { readonly status: FailureStatus | "invalid" };

export async function createInviteLink(
  input: { readonly groupId: string; readonly expiresInHours: number; readonly maxUses: number },
  deps: AuthedFetchDeps = {}
): Promise<CreateInviteOutcome> {
  try {
    const response = await authedFetch(
      "/api/ledger/invites",
      { method: "POST", body: JSON.stringify(input) },
      deps
    );
    if (response.status === 201) {
      const body = (await response.json().catch(() => null)) as Partial<Record<keyof CreatedInvite, unknown>> | null;
      if (
        body &&
        typeof body.inviteId === "string" &&
        typeof body.token === "string" &&
        typeof body.expiresAt === "string" &&
        typeof body.maxUses === "number"
      ) {
        return {
          status: "created",
          inviteId: body.inviteId,
          token: body.token,
          expiresAt: body.expiresAt,
          maxUses: body.maxUses
        };
      }
      return { status: "error" };
    }
    if (response.status === 400 || response.status === 422) return { status: "invalid" };
    return { status: failureFor(response.status) };
  } catch (error) {
    return caught(error);
  }
}

export interface InviteRow {
  readonly inviteId: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly useCount: number;
  readonly status: "active" | "expired" | "revoked" | "used_up";
}

export type LoadInvitesOutcome =
  | { readonly status: "ready"; readonly invites: readonly InviteRow[] }
  | { readonly status: FailureStatus };

const INVITE_STATUSES = ["active", "expired", "revoked", "used_up"];

export async function loadInvites(groupId: string, deps: AuthedFetchDeps = {}): Promise<LoadInvitesOutcome> {
  try {
    const response = await authedFetch(
      `/api/ledger/invites?groupId=${encodeURIComponent(groupId)}`,
      { method: "GET" },
      deps
    );
    if (!response.ok) return { status: failureFor(response.status) };
    const body = (await response.json().catch(() => null)) as { invites?: unknown } | null;
    if (!body || !Array.isArray(body.invites)) return { status: "error" };
    const invites: InviteRow[] = [];
    for (const entry of body.invites as Record<string, unknown>[]) {
      if (
        typeof entry.inviteId !== "string" ||
        typeof entry.expiresAt !== "string" ||
        typeof entry.maxUses !== "number" ||
        typeof entry.useCount !== "number" ||
        typeof entry.status !== "string" ||
        !INVITE_STATUSES.includes(entry.status)
      ) {
        return { status: "error" };
      }
      invites.push({
        inviteId: entry.inviteId,
        expiresAt: entry.expiresAt,
        maxUses: entry.maxUses,
        useCount: entry.useCount,
        status: entry.status as InviteRow["status"]
      });
    }
    return { status: "ready", invites };
  } catch (error) {
    return caught(error);
  }
}

export type MutationOutcome = { readonly status: "ok" } | { readonly status: FailureStatus | "invalid" | "not-found" };

async function mutate(path: string, payload: unknown, deps: AuthedFetchDeps): Promise<MutationOutcome> {
  try {
    const response = await authedFetch(path, { method: "POST", body: JSON.stringify(payload) }, deps);
    if (response.ok) return { status: "ok" };
    if (response.status === 404) return { status: "not-found" };
    if (response.status === 400 || response.status === 422) return { status: "invalid" };
    return { status: failureFor(response.status) };
  } catch (error) {
    return caught(error);
  }
}

export function revokeInviteLink(inviteId: string, deps: AuthedFetchDeps = {}): Promise<MutationOutcome> {
  return mutate("/api/ledger/invites/revoke", { inviteId }, deps);
}

/** The existing `POST /api/ledger/member-roles`: grant or clear the treasurer role. */
export function setTreasurer(
  input: { readonly groupId: string; readonly userId: string; readonly role: "treasurer" | "member" },
  deps: AuthedFetchDeps = {}
): Promise<MutationOutcome> {
  return mutate("/api/ledger/member-roles", input, deps);
}

// -- members ----------------------------------------------------------------

export interface MemberRow {
  readonly userId: string;
  readonly role: "owner" | "treasurer" | "member";
  readonly joinedAt: string;
  readonly email: string | null;
  /** The member's own avatar choice; `none` when never chosen. */
  readonly attire: MemberAttire;
}

export type LoadMembersOutcome =
  | { readonly status: "ready"; readonly members: readonly MemberRow[] }
  | { readonly status: FailureStatus };

export async function loadMembers(groupId: string, deps: AuthedFetchDeps = {}): Promise<LoadMembersOutcome> {
  try {
    const response = await authedFetch(
      `/api/ledger/members?groupId=${encodeURIComponent(groupId)}`,
      { method: "GET" },
      deps
    );
    if (!response.ok) return { status: failureFor(response.status) };
    const body = (await response.json().catch(() => null)) as { members?: unknown } | null;
    if (!body || !Array.isArray(body.members)) return { status: "error" };
    const members: MemberRow[] = [];
    for (const entry of body.members as Record<string, unknown>[]) {
      if (
        typeof entry.userId !== "string" ||
        typeof entry.joinedAt !== "string" ||
        (entry.role !== "owner" && entry.role !== "treasurer" && entry.role !== "member")
      ) {
        return { status: "error" };
      }
      // Anything but a known value fails the read: a guess here would draw the wrong shawl.
      const attire = toAttire(entry.attire);
      if (attire === null) return { status: "error" };
      members.push({
        userId: entry.userId,
        role: entry.role,
        joinedAt: entry.joinedAt,
        email: typeof entry.email === "string" ? entry.email : null,
        attire
      });
    }
    return { status: "ready", members };
  } catch (error) {
    return caught(error);
  }
}

// -- which group -----------------------------------------------------------

export type MyGroupOutcome =
  | {
      readonly status: "ready";
      readonly groupId: string;
      readonly name: string;
      readonly role: "owner" | "treasurer" | "member";
      /** The caller's own avatar attire in this group. */
      readonly attire: MemberAttire;
      /** The caller's own user id, for previewing their avatar frame; null if the server did not say. */
      readonly userId: string | null;
    }
  | { readonly status: "no-group" | "choose-group" }
  | { readonly status: FailureStatus };

/**
 * The caller's active group from `GET /api/my-groups`: `options.groupId` when it
 * is one of theirs, else their only group. With several and none chosen it
 * reports `choose-group` rather than guessing.
 */
export async function loadMyGroup(
  deps: AuthedFetchDeps = {},
  options: { readonly groupId?: string | null } = {}
): Promise<MyGroupOutcome> {
  try {
    const response = await authedFetch("/api/my-groups", { method: "GET" }, deps);
    if (!response.ok) return { status: failureFor(response.status) };
    const body = (await response.json().catch(() => null)) as { groups?: unknown } | null;
    if (!body || !Array.isArray(body.groups)) return { status: "error" };
    if (body.groups.length === 0) return { status: "no-group" };
    const picked = pickGroup(body.groups as readonly Record<string, unknown>[], options.groupId);
    if (picked === null) return { status: "choose-group" };
    const group = picked as Record<string, unknown>;
    if (
      typeof group.groupId !== "string" ||
      typeof group.name !== "string" ||
      (group.role !== "owner" && group.role !== "treasurer" && group.role !== "member")
    ) {
      return { status: "error" };
    }
    const attire = toAttire(group.attire);
    if (attire === null) return { status: "error" };
    return { status: "ready", groupId: group.groupId, name: group.name, role: group.role, attire, userId: typeof group.userId === "string" ? group.userId : null };
  } catch (error) {
    return caught(error);
  }
}

// -- the member's own attire -------------------------------------------------

export type SaveAttireOutcome =
  | { readonly status: "saved"; readonly attire: MemberAttire }
  | { readonly status: FailureStatus | "invalid" | "unavailable" };

/**
 * Save the signed-in member's own avatar attire. The body carries the group and
 * the value only; whose attire it is comes from the session on the server.
 */
export async function saveMyAttire(
  input: { readonly groupId: string; readonly attire: MemberAttire },
  deps: AuthedFetchDeps = {}
): Promise<SaveAttireOutcome> {
  try {
    const response = await authedFetch(
      "/api/ledger/member-attire",
      { method: "PUT", body: JSON.stringify(input) },
      deps
    );
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as { attire?: unknown } | null;
      const attire = body ? toAttire(body.attire) : null;
      return attire === null || body?.attire === undefined ? { status: "error" } : { status: "saved", attire };
    }
    if (response.status === 400) return { status: "invalid" };
    if (response.status === 503) return { status: "unavailable" };
    return { status: failureFor(response.status) };
  } catch (error) {
    return caught(error);
  }
}

// -- carrying an invite across sign-in ---------------------------------------
// The magic link is opened in a fresh page load, so the #token fragment is gone
// by the time the person is signed in. The token is parked in localStorage only
// while they sign in, and removed as soon as it has been redeemed (or rejected).

const PENDING_KEY = "sened.pendingInvite";

export function stashPendingInvite(token: string): void {
  try {
    window.localStorage.setItem(PENDING_KEY, token);
  } catch {
    // Storage blocked: the person will have to open the link again.
  }
}

export function peekPendingInvite(): string | null {
  try {
    const token = window.localStorage.getItem(PENDING_KEY);
    return token && TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to do.
  }
}
