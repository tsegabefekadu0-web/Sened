"use client";

import React, { useMemo } from "react";
import Image from "next/image";
import { ChevronRight } from "lucide-react";

import { createTranslator, type Locale } from "@/lib/i18n";
import { formatPotBalance } from "@/lib/ledger/homeSummary";

interface DebterCardProps {
  /**
   * A number is the sample figure; a string is a ledger amount ("175000.00")
   * and is only grouped, never parsed as a float. `null` means there is no
   * balance to show (loading, signed in without a readable ledger) and the card
   * shows a dash rather than a number it does not have.
   */
  potBalance: number | string | null;
  onDrawClick?: () => void;
  /**
   * The shell is Ge'ez-primary, so this defaults to `am` and the card looks
   * exactly as it did before the copy moved into the dictionary. §12.6 wants a
   * string in both languages; the default is what decides which one a given
   * build shows.
   */
  locale?: Locale;
}

export function DebterCard({
  potBalance,
  onDrawClick,
  locale = "am"
}: DebterCardProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  return (
    <div className="relative mx-auto w-full select-none px-4 pb-2 pt-9 animate-[debterEnter_0.6s_cubic-bezier(0.22,1,0.36,1)_both]">
      {/* One card, fully visible: nothing is hidden behind a swipe. */}
      <div
        onClick={onDrawClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onDrawClick?.();
          }
        }}
        className="group relative cursor-pointer overflow-hidden rounded-[22px] border border-[#443226]/50 bg-gradient-to-br from-[#2D211B] via-[#241A14] to-[#1E1510] p-5 shadow-[0_14px_32px_-6px_rgba(28,20,16,0.45)] transition-all duration-200 active:scale-[0.98] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#C6532B]"
        role="button"
        tabIndex={0}
        aria-label={t("shell.debter.ariaLabel")}
      >
        {/* Subtle leather highlight */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.07] via-transparent to-black/40" />

        {/* Stitched border */}
        <div className="pointer-events-none absolute inset-1.5 rounded-[17px] border border-dashed border-[#967352]/35" />

        {/* Top-right woven Tibeb ribbon straps */}
        <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 select-none overflow-hidden">
          <div className="flex h-3.5 w-32 translate-x-5 translate-y-3.5 rotate-45 transform items-center justify-around border-y border-[#F6D582]/40 bg-gradient-to-r from-[#9C2712] via-[#D4A244] to-[#9C2712] px-2 shadow-sm">
            <span className="block h-1.5 w-1.5 rotate-45 bg-[#1C1410]" />
            <span className="block h-1.5 w-1.5 rotate-45 bg-[#FAF6F0]" />
            <span className="block h-1.5 w-1.5 rotate-45 bg-[#1C1410]" />
          </div>
          <div className="h-1.5 w-32 translate-x-5 translate-y-7 rotate-45 transform bg-[#D4A244] opacity-80 shadow-xs" />
        </div>

        <div className="relative z-10 flex items-center justify-between gap-2 py-1 pl-2 pr-1">
          {/* Pot balance */}
          <div className="min-w-0 flex-1">
            <h2 className="font-ethiopic text-[26px] font-black leading-tight text-[#F7F2EB]">
              {t("shell.debter.label")}
            </h2>
            <div className="mb-3 mt-1.5 h-px w-40 bg-gradient-to-r from-[#533E32] to-transparent" />

            <p className="font-ethiopic text-[18px] font-semibold leading-snug text-[#E6D9CA]">
              {t("shell.debter.potBalance")}
            </p>

            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="font-sans text-[40px] font-black leading-tight tabular-nums tracking-tight text-white">
                {potBalance === null ? (
                  <>
                    <span aria-hidden="true">-</span>
                    <span className="sr-only">{t("shell.debter.unavailable")}</span>
                  </>
                ) : (
                  formatPotBalance(potBalance)
                )}
              </span>
              {potBalance !== null && (
                <span className="font-ethiopic text-[22px] font-extrabold text-[#F3C769]">
                  {t("shell.debter.currency")}
                </span>
              )}
            </div>
          </div>

          {/* Mesob basket and what the card opens */}
          <div className="flex shrink-0 flex-col items-center justify-center pl-1">
            <div className="relative h-20 w-16 transition-transform duration-200 group-hover:scale-[1.03] group-active:scale-95">
              <Image
                src="/reference_assets/mesob_3d_clean.png"
                alt={t("shell.debter.mesobAlt")}
                fill
                sizes="64px"
                priority
                className="object-contain drop-shadow-lg"
              />
            </div>
            <span className="mt-1 inline-flex items-center gap-0.5 font-ethiopic text-[18px] font-bold leading-snug text-[#F3C769]">
              {t("shell.debter.nextDraw")}
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
