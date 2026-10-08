"use client";

import { useEffect, useState } from "react";

import { isLocale, type Locale } from "@/lib/i18n";

/**
 * An app-wide language override.
 *
 * Every screen keeps its own `fallback` language (the home shell opens in
 * Amharic, the offline desk in English), so with no override nothing changes.
 * Once the voice assistant's `switchLanguage` picks a language, that choice is
 * remembered on this device and every screen that reads it follows. A screen's
 * own toggle still works and only changes that screen until the next override. Best effort: storage may be blocked, and the override
 * then lives only for the page's lifetime.
 */

const STORAGE_KEY = "sened.locale.v1";
const CHANGE_EVENT = "sened:locale-change";

let memory: Locale | null = null;

function readStored(): Locale | null {
  if (memory !== null) return memory;
  try {
    const value = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** The override, or `null` when nobody has chosen a language. */
export function getLocaleOverride(): Locale | null {
  return readStored();
}

/** Remember a language and tell every subscribed screen. */
export function setLocaleOverride(locale: Locale): void {
  memory = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Blocked storage: the in-memory choice still applies for this page.
  }
  try {
    document.documentElement.lang = locale;
  } catch {
    // No document (tests, server): nothing to update.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Drop-in for `useState<Locale>(fallback)`: `[locale, setLocale]`.
 *
 * The screen keeps its own state, so its own language toggle behaves exactly as
 * before. On top of that it follows the app-wide override: applied right after
 * mount (the server render and first client render use `fallback`, so
 * hydration matches) and whenever the assistant changes the language.
 */
export function useAppLocale(
  fallback: Locale
): readonly [Locale, (next: Locale | ((current: Locale) => Locale)) => void] {
  const [locale, setLocale] = useState<Locale>(fallback);
  useEffect(() => {
    const apply = () => {
      const override = getLocaleOverride();
      if (override !== null) setLocale(override);
    };
    apply();
    window.addEventListener(CHANGE_EVENT, apply);
    return () => window.removeEventListener(CHANGE_EVENT, apply);
  }, []);
  return [locale, setLocale] as const;
}
