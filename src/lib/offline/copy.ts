/**
 * The offline console's copy, sourced from the shared dictionary.
 *
 * This file used to hold 69 `offline.*` strings of its own, mirroring the
 * triples filed in `docs/requests/agent-4.md` R3, because `src/lib/i18n.ts` is
 * single-writer (AGENTWORK.md §4.1) and A4 was not allowed to edit it. Those
 * keys are now in the dictionary, so the mirror is gone: every string below is
 * read from `dictionaries` at call time and there is exactly one copy of each.
 *
 * The exported shape is unchanged on purpose. `src/app/offline/offline-console.tsx`
 * and its 20 tests both depend on `offlineCopy` and on `OFFLINE_COPY[key].en`
 * / `.am`, and A4 filed the deletion of this file as a *request*, not as
 * permission to break its own lane's tests. A thin adapter is the smaller
 * change and leaves one owner for the strings.
 */

import { dictionaries, translate, type Locale } from "@/lib/i18n";

export type OfflineLocale = Locale;

type Entry = { readonly en: string; readonly am: string };

function collect(prefix: string): Record<string, Entry> {
  const collected: Record<string, Entry> = {};
  for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
    if (typeof key === "string" && key.startsWith(prefix)) {
      collected[key] = { en: dictionaries.en[key], am: dictionaries.am[key] };
    }
  }
  return collected;
}

/** The `offline.*` slice of the shared dictionary, shaped as A4 left it. */
export const OFFLINE_COPY = collect("offline.") as Readonly<Record<string, Entry>>;

export type OfflineCopyKey = keyof typeof OFFLINE_COPY & string;

/**
 * Resolve a string.
 *
 * Still throws on an unknown key rather than returning the key itself: a
 * missing translation must be a loud failure in development, not an Ethiopian
 * treasurer reading a raw key on a Sunday.
 */
export function offlineCopy(
  locale: OfflineLocale,
  key: OfflineCopyKey,
  variables: Readonly<Record<string, string | number>> = {}
): string {
  if (!Object.prototype.hasOwnProperty.call(OFFLINE_COPY, key)) {
    throw new Error(`Unknown offline copy key: ${String(key)}`);
  }
  return translate(locale, key as never, variables);
}
