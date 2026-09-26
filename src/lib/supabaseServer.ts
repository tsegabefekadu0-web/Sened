import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+([^\s,]+)$/i);
  const token = match?.[1];
  return token && token.length <= 16_384 ? token : null;
}

export function getUserScopedClient(token: string): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!token || !url || !anonKey) {
    return null;
  }
  try {
    return createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
  } catch {
    return null;
  }
}
