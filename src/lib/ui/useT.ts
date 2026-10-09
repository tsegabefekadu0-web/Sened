"use client";

import { useCallback, useMemo } from "react";

import { setLocaleOverride, useAppLocale } from "@/lib/appLocale";
import { createTranslator, type Locale } from "@/lib/i18n";

/**
 * The language of the whole app: Amharic first, with the device-wide override
 * (set by the language switch or the English assistant) applied after mount.
 */
export function useT() {
  const [locale] = useAppLocale("am");
  const t = useMemo(() => createTranslator(locale), [locale]);
  const setLocale = useCallback((next: Locale) => setLocaleOverride(next), []);
  return { t, locale, setLocale };
}
