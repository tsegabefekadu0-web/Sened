"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/auth/authedFetch";
import { getBrowserSupabase } from "@/lib/auth/browserClient";

/**
 * The member's own profile. Synchronized with the server when signed in,
 * and preserved in localStorage for offline / sample mode.
 */
export interface Profile {
  readonly name: string;
  readonly phone: string;
  /** A public URL or small square JPEG data URL, or null. */
  readonly photo: string | null;
  readonly preferredLocale?: "am" | "en" | "om";
  readonly preferredTheme?: "system" | "light" | "dark";
}

const KEY = "sened.profile.v1";
const EVENT = "sened:profile-change";
export const EMPTY_PROFILE: Profile = { name: "", phone: "", photo: null };

export function readProfile(): Profile {
  if (typeof window === "undefined") return EMPTY_PROFILE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_PROFILE;
    const p = JSON.parse(raw) as Partial<Profile>;
    return {
      name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
      phone: typeof p.phone === "string" ? p.phone.slice(0, 30) : "",
      photo: typeof p.photo === "string" ? p.photo : null,
      preferredLocale: p.preferredLocale === "en" || p.preferredLocale === "om" ? p.preferredLocale : "am",
      preferredTheme: p.preferredTheme === "light" || p.preferredTheme === "dark" ? p.preferredTheme : "system"
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function writeProfile(profile: Profile): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch {
    return false;
  }
}

async function uploadAvatarIfDataUrl(photo: string | null): Promise<string | null> {
  if (!photo || !photo.startsWith("data:image/")) return photo;
  const client = getBrowserSupabase();
  if (!client) return photo;

  try {
    const { data: userData } = await client.auth.getUser();
    if (!userData?.user) return photo;

    // Convert data URL to Blob
    const res = await fetch(photo);
    const blob = await res.blob();
    const fileName = `${userData.user.id}/avatar.jpg`;

    const { error } = await client.storage.from("avatars").upload(fileName, blob, {
      contentType: "image/jpeg",
      upsert: true
    });
    if (error) return photo;

    const { data: pubData } = client.storage.from("avatars").getPublicUrl(fileName);
    return pubData?.publicUrl ? `${pubData.publicUrl}?t=${Date.now()}` : photo;
  } catch {
    return photo;
  }
}

export async function syncProfileToServer(profile: Profile): Promise<boolean> {
  try {
    const uploadedPhoto = await uploadAvatarIfDataUrl(profile.photo);
    const payload = {
      name: profile.name,
      phone: profile.phone,
      photo: uploadedPhoto && uploadedPhoto.length <= 2000 ? uploadedPhoto : null,
      preferredLocale: profile.preferredLocale,
      preferredTheme: profile.preferredTheme
    };

    const res = await authedFetch("/api/profile", {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      if (uploadedPhoto !== profile.photo) {
        writeProfile({ ...profile, photo: uploadedPhoto });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function useProfile(): readonly [Profile, (next: Profile) => Promise<boolean>] {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);

  useEffect(() => {
    const sync = () => setProfile(readProfile());
    sync();
    window.addEventListener(EVENT, sync);

    // Fetch from server if signed in
    let active = true;
    authedFetch("/api/profile", { method: "GET" })
      .then(async (res) => {
        if (!active || !res.ok) return;
        const data = (await res.json().catch(() => null)) as { profile?: Partial<Profile> } | null;
        if (!data?.profile) return;
        const current = readProfile();
        const serverProf: Profile = {
          name: data.profile.name || current.name,
          phone: data.profile.phone || current.phone,
          photo: data.profile.photo || current.photo,
          preferredLocale: data.profile.preferredLocale || current.preferredLocale,
          preferredTheme: data.profile.preferredTheme || current.preferredTheme
        };
        writeProfile(serverProf);
      })
      .catch(() => {});

    return () => {
      active = false;
      window.removeEventListener(EVENT, sync);
    };
  }, []);

  const save = useCallback(async (next: Profile): Promise<boolean> => {
    writeProfile(next);
    await syncProfileToServer(next);
    return true; // the device copy is saved; the server copy follows when it can
  }, []);

  return [profile, save] as const;
}

/** Downscale a chosen image to a 256px square JPEG data URL. */
export async function photoToDataUrl(file: File): Promise<string | null> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 8_000_000) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) return null;
    const side = Math.min(bitmap.width, bitmap.height);
    g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}
