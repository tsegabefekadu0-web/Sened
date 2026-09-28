import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getUserScopedClient } from "@/lib/supabaseServer";

/**
 * The preamble every authenticated read shares.
 *
 * Written once because the order matters and the failure modes are different:
 * no token is 401, no Supabase configuration is 503, an unreachable auth server
 * is 503, and a rejected token is 401. Collapsing any two of those would tell a
 * treasurer "you have no accounts" when the truth is "we could not check", which
 * is the difference between a fixable problem and a mystery.
 */
export type AuthenticatedRead =
  | { readonly ok: true; readonly client: SupabaseClient; readonly userId: string }
  | { readonly ok: false; readonly error: string; readonly status: number };

export async function authenticateRead(request: Request): Promise<AuthenticatedRead> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+([^\s,]+)$/i);
  const token = match?.[1];
  if (!token || token.length > 16_384) {
    return { ok: false, error: "unauthorized", status: 401 };
  }
  const client = getUserScopedClient(token);
  if (!client) {
    return { ok: false, error: "not_configured", status: 503 };
  }
  const auth = await client.auth.getUser().catch(() => null);
  if (!auth) {
    return { ok: false, error: "auth_unavailable", status: 503 };
  }
  if (auth.error || !auth.data.user) {
    return { ok: false, error: "unauthorized", status: 401 };
  }
  return { ok: true, client, userId: auth.data.user.id };
}
