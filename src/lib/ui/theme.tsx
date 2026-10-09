"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "sened.theme.v1";
const CHANGE_EVENT = "sened:theme-change";

/**
 * Runs before first paint (inlined in the root layout) so the page never flashes
 * the wrong theme: a saved choice wins, otherwise the device preference. It also
 * sets `<html lang>` from the saved language.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}d.setAttribute("data-theme",t)}catch(e){d.setAttribute("data-theme","light")}try{var l=localStorage.getItem("sened.locale.v1");if(l==="en"||l==="am"){d.lang=l}}catch(e){}})();`;

export function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Blocked storage: the choice still applies for this page.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `[theme, setTheme]`. Starts "light" for hydration, then reads what the init script set. */
export function useTheme(): readonly [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);
  const set = useCallback((next: Theme) => applyTheme(next), []);
  return [theme, set] as const;
}
