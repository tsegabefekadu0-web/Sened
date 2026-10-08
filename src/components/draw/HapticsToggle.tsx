"use client";

import React, { useEffect, useState } from "react";

import {
  getHapticsEnabled,
  hapticsHeldByReducedMotion,
  isHapticsSupported,
  setHapticsEnabled,
  subscribeHaptics
} from "@/lib/draw/haptics";
import { translate, type Locale } from "@/lib/i18n";

/**
 * The user's switch for vibration feedback on /draw.
 *
 * Support and reduced-motion are read after mount (they depend on the browser),
 * so the server render and first client render match. Where the browser cannot
 * vibrate (iOS Safari) the switch is disabled and says why, rather than
 * pretending to work.
 */
export function HapticsToggle({ locale }: { readonly locale: Locale }) {
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setSupported(isHapticsSupported());
    setReduced(hapticsHeldByReducedMotion());
    setEnabled(getHapticsEnabled());
    setReady(true);
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(hapticsHeldByReducedMotion());
    query?.addEventListener?.("change", onChange);
    const unsubscribe = subscribeHaptics(() => setEnabled(getHapticsEnabled()));
    return () => {
      query?.removeEventListener?.("change", onChange);
      unsubscribe();
    };
  }, []);

  if (!ready) return null;

  const note = !supported
    ? translate(locale, "draw.haptics.unsupported")
    : reduced
      ? translate(locale, "draw.haptics.reduced")
      : null;

  return (
    <div data-testid="haptics-toggle" className="border-b border-[#DCCFC7] bg-[#FAF6F0] px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-base font-semibold text-[#1C1410]">{translate(locale, "draw.haptics.label")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={supported && enabled}
          disabled={!supported}
          onClick={() => setHapticsEnabled(!enabled)}
          className="min-h-12 min-w-[64px] rounded-xl border border-[#DCCFC7] px-3 text-base font-semibold text-[#1C1410] disabled:opacity-50"
        >
          {supported && enabled ? translate(locale, "draw.haptics.on") : translate(locale, "draw.haptics.off")}
        </button>
      </div>
      {note ? (
        <p data-testid="haptics-note" className="mt-1 text-base leading-relaxed text-[#4F4137]">
          {note}
        </p>
      ) : null}
    </div>
  );
}
