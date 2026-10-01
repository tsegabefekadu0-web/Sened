"use client";

import { useEffect, useState } from "react";

import { getBrowserSupabase } from "./browserClient";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "unconfigured" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly accessToken: string; readonly email: string | null };

/**
 * The current session. Starts as `loading` on both server and first client
 * render so hydration matches, then resolves to one of the other three.
 * Anything that is not `signed-in` must behave exactly as it did before there
 * was a sign-in surface.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    const client = getBrowserSupabase();
    if (!client) {
      setState({ status: "unconfigured" });
      return;
    }
    let active = true;
    const apply = (session: { access_token: string; user?: { email?: string | null } } | null) => {
      if (!active) {
        return;
      }
      setState(
        session?.access_token
          ? { status: "signed-in", accessToken: session.access_token, email: session.user?.email ?? null }
          : { status: "signed-out" }
      );
    };
    client.auth
      .getSession()
      .then(({ data }) => apply(data.session))
      .catch(() => apply(null));
    const { data } = client.auth.onAuthStateChange((_event, session) => apply(session));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return state;
}
