import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase client, or `null` when this build is not configured.
 *
 * `null` is the fail-closed answer: with no URL or anon key there is no way to
 * sign in, and every caller treats that as "signed out" rather than crashing a
 * build, a test or the e2e run. The two `process.env.NEXT_PUBLIC_*` reads must
 * stay as literal property accesses so Next inlines them into the client bundle.
 *
 * The anon key is public by design; every `/api` route re-verifies the JWT
 * itself, so nothing here is trusted by the server.
 */
let cached: { readonly key: string; readonly client: SupabaseClient } | null = null;

export function isAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  );
}

export function getBrowserSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    return null;
  }
  const key = `${url}|${anonKey}`;
  if (cached && cached.key === key) {
    return cached.client;
  }
  try {
    const client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "implicit"
      }
    });
    cached = { key, client };
    return client;
  } catch {
    return null;
  }
}

/** The current access token, or `null` if signed out, unconfigured or unreadable. */
export async function getAccessToken(): Promise<string | null> {
  const client = getBrowserSupabase();
  if (!client) {
    return null;
  }
  try {
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
