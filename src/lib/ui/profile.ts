"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The member's own profile, kept on this device. There is no profile endpoint
 * yet (name, phone and photo are not stored on the server); the email always
 * comes from the sign-in session. TODO(backend): sync name, phone, photo.
 */
export interface Profile {
  readonly name: string;
  readonly phone: string;
  /** A small square JPEG data URL, or null. */
  readonly photo: string | null;
}

const KEY = "sened.profile.v1";
const EVENT = "sened:profile-change";
export const EMPTY_PROFILE: Profile = { name: "", phone: "", photo: null };

export function readProfile(): Profile {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_PROFILE;
    const p = JSON.parse(raw) as Partial<Profile>;
    return {
      name: typeof p.name === "string" ? p.name.slice(0, 80) : "",
      phone: typeof p.phone === "string" ? p.phone.slice(0, 20) : "",
      photo: typeof p.photo === "string" && p.photo.startsWith("data:image/") ? p.photo : null
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function writeProfile(profile: Profile): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch {
    return false;
  }
}

export function useProfile(): readonly [Profile, (next: Profile) => boolean] {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  useEffect(() => {
    const sync = () => setProfile(readProfile());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const save = useCallback((next: Profile) => writeProfile(next), []);
  return [profile, save] as const;
}

/** Downscale a chosen image to a 256px square JPEG data URL. */
export async function photoToDataUrl(file: File): Promise<string | null> {
  if (!/^image\/(jpeg|png)$/.test(file.type) || file.size > 8_000_000) return null;
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
