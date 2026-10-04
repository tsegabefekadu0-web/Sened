"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useSession } from "@/lib/auth/useSession";
import {
  ActiveGroupStore,
  IDLE_STATE,
  type ActiveGroupState,
  type FetchedGroups,
  type GroupOption
} from "./activeGroup";

interface ContextValue {
  readonly store: ActiveGroupStore;
  /** Who the session says is signed in right now (`null` for nobody), read during render. */
  readonly identity: string | null;
}

const ActiveGroupContext = createContext<ContextValue | null>(null);

/**
 * Mounted once, in `src/app/layout.tsx`, so every page shares one active group
 * and a change made in any switcher reaches every consumer.
 */
export function ActiveGroupProvider({
  children,
  fetchGroups,
  storage
}: {
  readonly children: React.ReactNode;
  /** Test seam. Defaults to `GET /api/my-groups`. */
  readonly fetchGroups?: () => Promise<FetchedGroups>;
  /** Test seam. Defaults to `window.localStorage`. */
  readonly storage?: Storage | null;
}) {
  const session = useSession();
  const storeRef = useRef<ActiveGroupStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new ActiveGroupStore({ fetchGroups, storage });
  }
  const store = storeRef.current;
  const identity = session.status === "signed-in" ? (session.userId ?? session.email ?? "signed-in") : null;
  const userId = session.status === "signed-in" ? (session.userId ?? null) : null;

  useEffect(() => {
    store.setIdentity(identity, userId);
  }, [store, identity, userId]);

  const value = useMemo<ContextValue>(() => ({ store, identity }), [store, identity]);
  return <ActiveGroupContext.Provider value={value}>{children}</ActiveGroupContext.Provider>;
}

export interface ActiveGroupApi extends ActiveGroupState {
  /** False when no provider is mounted (a component rendered on its own, e.g. in a test). */
  readonly provided: boolean;
  readonly active: GroupOption | null;
  readonly select: (groupId: string) => void;
  /** Re-read the groups; pass a group id to make it the active one (a group just joined). */
  readonly reload: (adoptGroupId?: string) => void;
}

const NOOP = () => {};
const UNPROVIDED: ActiveGroupApi = {
  ...IDLE_STATE,
  provided: false,
  active: null,
  select: NOOP,
  reload: NOOP
};
const subscribeNothing = () => NOOP;

/** The active group state and its actions. */
export function useActiveGroup(): ActiveGroupApi {
  const context = useContext(ActiveGroupContext);
  const store = context?.store ?? null;
  const state = useSyncExternalStore(
    store ? store.subscribe : subscribeNothing,
    store ? store.getState : () => IDLE_STATE,
    () => IDLE_STATE
  );
  // Stable for the life of the store, so a consumer can list them as effect dependencies.
  const actions = useMemo(
    () => ({
      select: (groupId: string) => store?.select(groupId),
      reload: (adoptGroupId?: string) => store?.reload(adoptGroupId)
    }),
    [store]
  );
  return useMemo<ActiveGroupApi>(() => {
    if (store === null || context === null) return UNPROVIDED;
    // State of another identity (or a session the provider has not caught up
    // with yet) must never take effect for this one.
    const current = state.identity === context.identity ? state : IDLE_STATE;
    return {
      ...current,
      status: context.identity !== null && current.identity === null ? "loading" : current.status,
      provided: true,
      active: current.groups.find((group) => group.groupId === current.activeGroupId) ?? null,
      select: actions.select,
      reload: actions.reload
    };
  }, [store, context, state, actions]);
}

/**
 * What a data consumer needs: whether it may read yet, and which group id to send.
 *
 * `ready` is false only while a signed-in user's groups are still being
 * resolved, so a consumer waits instead of reading once with no preference and
 * again with the real one. Without a provider it is always ready with no
 * preference, and the read falls back to "the only group, else ask".
 * `groupId` is a preference only; the read validates it against the groups the
 * server returns, and the server validates membership again.
 */
export function useActiveGroupPreference(): { readonly ready: boolean; readonly groupId: string | null } {
  const api = useActiveGroup();
  return {
    ready: !api.provided || api.status !== "loading",
    groupId: api.activeGroupId
  };
}
