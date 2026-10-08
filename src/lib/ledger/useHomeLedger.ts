"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionState } from "@/lib/auth/useSession";
import { serverDisagreesWithActiveGroup } from "@/lib/groups/activeGroup";
import { useActiveGroupPreference } from "@/lib/groups/useActiveGroup";
import { loadHomeLedger, type HomeLedgerResult } from "./clientHome";

/**
 * What the home screen is looking at.
 *
 * `sample` is the only state in which the screen may show fixture numbers, and
 * it means exactly "there is no signed-in session". While the session itself is
 * still resolving the view is `loading`, not `sample`: a signed-in treasurer
 * must never see the fixture balance flash up as if it were theirs.
 */
export type HomeLedgerView =
  | { readonly kind: "sample" }
  | { readonly kind: "loading" }
  | { readonly kind: "live"; readonly result: HomeLedgerResult };

export function useHomeLedger(session: SessionState): HomeLedgerView & { readonly reload: () => void } {
  const signedIn = session.status === "signed-in";
  // The ledger read follows the app's active group; it waits for the groups to
  // resolve rather than reading once with no preference and again with one.
  const { ready: groupReady, groupId, reload: reloadGroups } = useActiveGroupPreference();
  const [result, setResult] = useState<HomeLedgerResult | null>(null);
  const [round, setRound] = useState(0);
  const loadedGroup = useRef<string | null>(null);
  // Re-read the ledger in place (after the treasurer records a payer) without
  // flashing the loading state: the rows stay until the fresh read replaces them.
  const reload = useCallback(() => setRound((value) => value + 1), []);

  useEffect(() => {
    if (!signedIn || !groupReady) {
      loadedGroup.current = null;
      setResult(null);
      return;
    }
    let active = true;
    // A different group is a different ledger: never leave the previous group's
    // rows on screen. Only a reload of the same group keeps them while it re-reads.
    const sameGroup = loadedGroup.current === groupId;
    loadedGroup.current = groupId;
    setResult((previous) => (round === 0 || !sameGroup ? null : previous));
    void loadHomeLedger({}, { groupId }).then((next) => {
      if (active) {
        setResult(next);
        // The server resolved a different group than the switcher shows (or none):
        // re-read the groups so the switcher and this ledger name the same one.
        if (serverDisagreesWithActiveGroup(next as { status: string; groupId?: string }, groupId)) {
          reloadGroups();
        }
      }
    });
    return () => {
      active = false;
    };
  }, [signedIn, groupReady, groupId, round, reloadGroups]);

  if (session.status === "loading") {
    return { kind: "loading", reload };
  }
  if (!signedIn) {
    return { kind: "sample", reload };
  }
  return result === null ? { kind: "loading", reload } : { kind: "live", result, reload };
}
