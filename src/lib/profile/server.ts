import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileUpdateInput, UserProfile } from "./types";

export type ProfileResult =
  | { readonly status: "ok"; readonly profile: UserProfile }
  | { readonly status: "not-found" }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" }
  | { readonly status: "error" };

function parseProfileRow(data: unknown): UserProfile | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string") return null;

  const locale = row.preferredLocale ?? row.preferred_locale;
  const theme = row.preferredTheme ?? row.preferred_theme;
  const createdAt = row.createdAt ?? row.created_at;
  const updatedAt = row.updatedAt ?? row.updated_at;

  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "",
    phone: typeof row.phone === "string" ? row.phone : "",
    photo: typeof row.photo === "string" && row.photo.length > 0 ? row.photo : null,
    preferredLocale: locale === "en" || locale === "om" ? locale : "am",
    preferredTheme: theme === "light" || theme === "dark" ? theme : "system",
    createdAt: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
    updatedAt: typeof updatedAt === "string" ? updatedAt : new Date().toISOString()
  };
}

export async function getMyProfile(client: SupabaseClient): Promise<ProfileResult> {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) {
    return { status: "forbidden" };
  }

  const { data, error } = await client
    .from("profiles")
    .select("id, name, phone, photo, preferred_locale, preferred_theme, created_at, updated_at")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (error) {
    return { status: "error" };
  }

  if (!data) {
    // If no row exists yet, return an initial profile matching auth email
    const emailPrefix = userData.user.email ? userData.user.email.split("@")[0] : "";
    return {
      status: "ok",
      profile: {
        id: userData.user.id,
        name: emailPrefix,
        phone: "",
        photo: null,
        preferredLocale: "am",
        preferredTheme: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
  }

  const parsed = parseProfileRow(data);
  if (!parsed) return { status: "error" };
  return { status: "ok", profile: parsed };
}

export async function upsertMyProfile(
  client: SupabaseClient,
  input: ProfileUpdateInput
): Promise<ProfileResult> {
  const { data, error } = await client.rpc("sened_profile_upsert_v1", {
    requested_name: input.name ?? "",
    requested_phone: input.phone ?? "",
    requested_photo: input.photo ?? null,
    requested_locale: input.preferredLocale ?? "am",
    requested_theme: input.preferredTheme ?? "system"
  });

  if (error) {
    if (error.code === "42501" || error.message?.includes("profile_unauthorized")) {
      return { status: "forbidden" };
    }
    if (error.code === "22023" || error.message?.includes("profile_invalid")) {
      return { status: "invalid" };
    }
    return { status: "error" };
  }

  const parsed = parseProfileRow(data);
  if (!parsed) return { status: "error" };
  return { status: "ok", profile: parsed };
}
