import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { clearCachedPayerChoices } from "@/lib/ledger/payerChoiceCache";

/**
 * The app-wide **active group**: which of the signed-in user's groups every
 * surface (home, ledger, draw, offline desk, members, profile) is acting on.
 *
 * Resolution, in order:
 *   1. exactly one group  -> that one, no question asked;
 *   2. the user's remembered choice, if it is still one of their groups;
 *   3. otherwise none: the user is asked (the group switcher), and every
 *      consumer shows a "choose a group" state. Nothing guesses among several,
 *      because guessing is how money lands on the wrong ledger.
 *
 * The choice is only a preference about which id the client sends. The server
 * validates membership for every group id on every request; nothing here
 * grants anything.
 *
 * Remembered per signed-in user id in localStorage (best effort: every access
 * is guarded), validated against the current group list so a stale or foreign
 * id is ignored, and cleared on sign-out. The last-known group list is cached
 * under the same user id so the offline desk can still tell which group is
 * active with no network.
 */

export type GroupRole = "owner" | "treasurer" | "member";

/** What the switcher needs to show about one of the user's groups. */
export interface GroupOption {
  readonly groupId: string;
  /** The group's name from `ledger_groups.name`; may be empty. */
  readonly name: string;
  readonly role: GroupRole | null;
}

export type ActiveGroupStatus = "idle" | "loading" | "ready" | "no-group" | "unauthorized" | "error";

export interface ActiveGroupState {
  readonly status: ActiveGroupStatus;
  /** The signed-in identity this state belongs to; `null` when nobody is signed in. */
  readonly identity: string | null;
  readonly groups: readonly GroupOption[];
  readonly activeGroupId: string | null;
  /** The user belongs to several groups and has not chosen one. */
  readonly needsChoice: boolean;
  /** The list came from the on-device cache because the server could not be reached. */
  readonly stale: boolean;
}

export const IDLE_STATE: ActiveGroupState = {
  status: "idle",
  identity: null,
  groups: [],
  activeGroupId: null,
  needsChoice: false,
  stale: false
};

const CHOICE_KEY_PREFIX = "sened.activeGroup.v1.";
const LIST_KEY_PREFIX = "sened.groups.v1.";

function storageOf(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRemembered(userId: string | null, storage?: Storage | null): string | null {
  const store = storageOf(storage);
  if (!userId || !store) return null;
  try {
    const value = store.getItem(CHOICE_KEY_PREFIX + userId);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeRemembered(userId: string | null, groupId: string, storage?: Storage | null): void {
  const store = storageOf(storage);
  if (!userId || !store) return;
  try {
    store.setItem(CHOICE_KEY_PREFIX + userId, groupId);
  } catch {
    // Storage blocked or full: the choice simply is not remembered.
  }
}

function readCachedGroups(userId: string | null, storage?: Storage | null): readonly GroupOption[] | null {
  const store = storageOf(storage);
  if (!userId || !store) return null;
  try {
    const raw = store.getItem(LIST_KEY_PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const groups = Array.isArray(parsed) ? parseGroupOptions(parsed) : [];
    // An empty cached list says nothing about the groups the user has now.
    return groups.length > 0 ? groups : null;
  } catch {
    return null;
  }
}

function writeCachedGroups(userId: string | null, groups: readonly GroupOption[], storage?: Storage | null): void {
  const store = storageOf(storage);
  if (!userId || !store) return;
  try {
    store.setItem(LIST_KEY_PREFIX + userId, JSON.stringify(groups));
  } catch {
    // Best effort.
  }
}

/** Forget this user's remembered choice and cached group list (sign-out). */
export function clearRemembered(userId: string | null, storage?: Storage | null): void {
  const store = storageOf(storage);
  if (!userId || !store) return;
  try {
    store.removeItem(CHOICE_KEY_PREFIX + userId);
    store.removeItem(LIST_KEY_PREFIX + userId);
  } catch {
    // Nothing to do.
  }
}

/** Keep only well-formed groups from a `GET /api/my-groups` body; nothing is invented. */
export function parseGroupOptions(value: unknown): GroupOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: GroupOption[] = [];
  for (const item of value as readonly Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null || typeof item.groupId !== "string" || item.groupId === "") continue;
    if (seen.has(item.groupId)) continue;
    seen.add(item.groupId);
    options.push({
      groupId: item.groupId,
      name: typeof item.name === "string" ? item.name.trim() : "",
      role: item.role === "owner" || item.role === "treasurer" || item.role === "member" ? item.role : null
    });
  }
  return options;
}

/** The pure rule: only group / remembered-and-still-valid / nothing. */
export function resolveActiveGroupId(groups: readonly GroupOption[], remembered: string | null): string | null {
  if (groups.length === 1) return groups[0].groupId;
  if (remembered && groups.some((group) => group.groupId === remembered)) return remembered;
  return null;
}

/**
 * True when what the server just resolved for this caller is not the group the
 * client believes is active: the server says "choose" (the remembered group is
 * gone, or there are several and none is chosen), or it resolved a group other
 * than the preference. The consumer then asks the store to reload, so the
 * switcher, the forms and the ledger all name the same group.
 */
export function serverDisagreesWithActiveGroup(
  result: { readonly status: string; readonly groupId?: string },
  preferred: string | null
): boolean {
  if (result.status === "choose-group") return true;
  return typeof result.groupId === "string" && result.groupId !== preferred;
}

/** A short, honest label for a group with no name: a piece of its id, not an invented name. */
export function shortGroupId(groupId: string): string {
  return groupId.replace(/-/g, "").slice(0, 8);
}

export type FetchedGroups =
  | { readonly kind: "ok"; readonly groups: readonly GroupOption[]; readonly userId: string | null }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

/** Default loader: `GET /api/my-groups` with the session's Bearer token. */
export async function fetchMyGroups(deps: AuthedFetchDeps = {}): Promise<FetchedGroups> {
  try {
    const response = await authedFetch("/api/my-groups", { method: "GET" }, deps);
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { groups?: unknown };
    if (!Array.isArray(body.groups)) return { kind: "error" };
    const first = (body.groups as readonly Record<string, unknown>[]).find(
      (group) => typeof group?.userId === "string" && group.userId !== ""
    );
    return {
      kind: "ok",
      groups: parseGroupOptions(body.groups),
      userId: first ? (first.userId as string) : null
    };
  } catch (error) {
    return error instanceof NotSignedInError ? { kind: "unauthorized" } : { kind: "error" };
  }
}

export interface ActiveGroupStoreOptions {
  readonly fetchGroups?: () => Promise<FetchedGroups>;
  /** Test seam; defaults to `window.localStorage` (or nothing where it is unavailable). */
  readonly storage?: Storage | null;
}

/**
 * The store behind the active group: a plain subscribe/snapshot object (works
 * with `useSyncExternalStore`) so it is testable without React.
 */
export class ActiveGroupStore {
  private state: ActiveGroupState = IDLE_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchGroups: () => Promise<FetchedGroups>;
  private readonly storage: Storage | null | undefined;
  /** The user id the remembered choice is keyed by; known from the session or from the server. */
  private userId: string | null = null;
  private sessionUserId: string | null = null;
  private generation = 0;

  constructor(options: ActiveGroupStoreOptions = {}) {
    this.fetchGroups = options.fetchGroups ?? (() => fetchMyGroups());
    this.storage = options.storage;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): ActiveGroupState => this.state;

  private set(next: ActiveGroupState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Tell the store who is signed in (`null` for nobody). A new identity discards
   * everything of the previous one and loads the new user's groups; going to
   * `null` (sign-out) also forgets the remembered choice. The same identity again is a no-op.
   */
  setIdentity(identity: string | null, userId: string | null = null): void {
    if (identity === this.state.identity) {
      return;
    }
    this.generation += 1;
    if (this.state.identity !== null) {
      // Leaving an identity (sign-out or a different account): the previous one's
      // cached payer lists must not be offered to whoever comes next.
      clearCachedPayerChoices();
    }
    if (identity === null) {
      clearRemembered(this.userId, this.storage);
      this.userId = null;
      this.sessionUserId = null;
      this.set(IDLE_STATE);
      return;
    }
    this.userId = userId;
    this.sessionUserId = userId;
    this.set({ ...IDLE_STATE, status: "loading", identity });
    void this.load(identity);
  }

  /** Re-read the user's groups; optionally make `adoptGroupId` (e.g. a group just joined) the active one. */
  reload(adoptGroupId?: string): void {
    const identity = this.state.identity;
    if (identity === null) return;
    this.generation += 1;
    void this.load(identity, adoptGroupId);
  }

  /** Choose a group. An id that is not one of the user's groups is ignored. */
  select(groupId: string): void {
    const state = this.state;
    if (state.identity === null || !state.groups.some((group) => group.groupId === groupId)) {
      return;
    }
    if (state.activeGroupId === groupId && !state.needsChoice) {
      return;
    }
    writeRemembered(this.userId, groupId, this.storage);
    this.set({ ...state, activeGroupId: groupId, needsChoice: false });
  }

  private async load(identity: string, adoptGroupId?: string): Promise<void> {
    const generation = this.generation;
    const fetched = await this.fetchGroups();
    if (generation !== this.generation || this.state.identity !== identity) {
      return; // the user changed or a newer read superseded this one
    }
    if (fetched.kind === "unauthorized") {
      this.set({ ...IDLE_STATE, status: "unauthorized", identity });
      return;
    }
    let groups: readonly GroupOption[];
    let stale = false;
    if (fetched.kind === "ok") {
      this.userId = this.sessionUserId ?? fetched.userId;
      groups = fetched.groups;
      writeCachedGroups(this.userId, groups, this.storage);
    } else {
      const cached = readCachedGroups(this.userId, this.storage);
      if (cached === null) {
        this.set({ ...IDLE_STATE, status: "error", identity });
        return;
      }
      groups = cached;
      stale = true;
    }
    if (groups.length === 0) {
      this.set({ ...IDLE_STATE, status: "no-group", identity });
      return;
    }
    if (adoptGroupId && groups.some((group) => group.groupId === adoptGroupId)) {
      writeRemembered(this.userId, adoptGroupId, this.storage);
    }
    const activeGroupId = resolveActiveGroupId(groups, readRemembered(this.userId, this.storage));
    this.set({
      status: "ready",
      identity,
      groups,
      activeGroupId,
      needsChoice: activeGroupId === null,
      stale
    });
  }
}
