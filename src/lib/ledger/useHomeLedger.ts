"use client";

import { useEffect, useState } from "react";

import type { SessionState } from "@/lib/auth/useSession";
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

export function useHomeLedger(session: SessionState): HomeLedgerView {
  const signedIn = session.status === "signed-in";
  const [result, setResult] = useState<HomeLedgerResult | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setResult(null);
      return;
    }
    let active = true;
    setResult(null);
    void loadHomeLedger().then((next) => {
      if (active) {
        setResult(next);
      }
    });
    return () => {
      active = false;
    };
  }, [signedIn]);

  if (session.status === "loading") {
    return { kind: "loading" };
  }
  if (!signedIn) {
    return { kind: "sample" };
  }
  return result === null ? { kind: "loading" } : { kind: "live", result };
}
