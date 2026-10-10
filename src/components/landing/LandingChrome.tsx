"use client";

import Link from "next/link";
import React, { useEffect, useRef } from "react";

import { LanguageSwitch } from "@/components/ui/AppHeader";
import { useT } from "@/lib/ui/useT";

/**
 * The landing page's scroll spine.
 *
 * Two pieces, both driven by one passive scroll listener:
 *  - a tibeb-gold hairline across the top that fills as you descend the page;
 *  - a condensed copy of the hero nav that slides in once the hero has scrolled
 *    away, so the sign-in entry point and the language switch are never lost on
 *    a page three viewports tall.
 *
 * The listener writes straight to the DOM through refs and never calls setState,
 * so scrolling the landing page re-renders nothing. The bar moves by `transform`
 * only. Under reduced motion the CSS transitions collapse automatically, and the
 * bar stays functional because it is rAF-driven rather than animated.
 */
export function LandingChrome({ heroRef }: { readonly heroRef: React.RefObject<HTMLElement> }) {
  const { t } = useT();
  const barRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    const head = headRef.current;
    if (!bar || !head) return;

    let heroH = 0;
    let frame = 0;
    let lastP = -1;
    let lastShown: boolean | null = null;

    const measure = () => {
      const hero = heroRef.current;
      heroH = hero ? hero.offsetHeight : 0;
    };

    const apply = () => {
      frame = 0;
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
      // Show the bar once the hero is mostly gone; the hairline marks the same line.
      const shown = heroH > 0 ? y + 72 >= heroH : y >= 72;
      if (p !== lastP) {
        bar.style.transform = `scaleX(${p})`;
        lastP = p;
      }
      if (shown !== lastShown) {
        head.dataset.shown = shown ? "1" : "0";
        lastShown = shown;
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    measure();
    apply();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    // The hero's height changes with locale (Amharic wraps wider than English) and
    // with the viewport, so the trigger line has to be re-measured, not assumed.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { measure(); schedule(); }) : null;
    if (ro && heroRef.current) ro.observe(heroRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
    };
  }, [heroRef]);

  return (
    <>
      <span
        ref={barRef}
        aria-hidden="true"
        className="snd-prog"
        style={{ transform: "scaleX(0)" }}
      />
      {/* visibility (not opacity alone) keeps the links out of the tab order while
          the bar is hidden, so nothing invisible can take focus. */}
      <div ref={headRef} className="snd-lbar" data-shown="0">
        <div className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-5 py-2.5 md:px-8">
          <Link href="/welcome" className="flex items-center gap-2.5" aria-label="ሰነድ">
            <span lang="am" aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-prim font-serif text-xl font-bold text-primt">
              ሰ
            </span>
            <span lang="am" className="font-serif text-lg font-bold">
              ሰነድ
            </span>
          </Link>
          <div className="flex items-center gap-3 md:gap-5">
            <LanguageSwitch onGreen={false} />
            <Link href="/sign-in" className="flex h-10 items-center rounded-full border border-hair px-4 text-[15px] font-bold">
              {t("ui.landing.signIn")}
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
