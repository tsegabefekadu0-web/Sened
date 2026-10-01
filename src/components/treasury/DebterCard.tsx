"use client";

import React, { useMemo } from "react";
import Image from "next/image";
import { ChevronRight } from "lucide-react";

import { createTranslator, type Locale } from "@/lib/i18n";

interface DebterCardProps {
  potBalance: number;
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
  potBalance = 175000,
  onDrawClick,
  locale = "am"
}: DebterCardProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  return (
    <div className="relative w-full max-w-md md:max-w-none mx-auto pt-7 md:pt-2 pb-2 px-4 md:px-0 select-none animate-[debterEnter_0.6s_cubic-bezier(0.22,1,0.36,1)_both]">
      {/* Horizontal Carousel Container: Main Debter Card + Peek Card */}
      <div className="relative flex items-stretch gap-2.5">
        {/* Main Saddle Leather Debter Card */}
        <div
          onClick={onDrawClick}
          className="relative flex-1 rounded-[22px] p-5 bg-gradient-to-br from-[#2D211B] via-[#241A14] to-[#1E1510] shadow-[0_14px_32px_-6px_rgba(28,20,16,0.45)] cursor-pointer active:scale-[0.98] transition-all duration-200 overflow-hidden border border-[#443226]/50 group"
          role="button"
          tabIndex={0}
          aria-label={t("shell.debter.ariaLabel")}
        >
          {/* Subtle Leather Texture Highlight */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.07] via-transparent to-black/40 pointer-events-none" />

          {/* Outer Perimeter Stitched Border */}
          <div className="absolute inset-1.5 rounded-[17px] border border-dashed border-[#967352]/35 pointer-events-none" />

          {/* Left Spine Double Stitched Line (Booklet Binding Look) */}
          <div className="absolute left-3.5 top-1.5 bottom-1.5 w-2 border-r border-dashed border-[#967352]/35 pointer-events-none" />

          {/* Top-Right Corner: Diagonal Woven Tibeb Ribbon Straps */}
          <div className="absolute top-0 right-0 w-24 h-24 overflow-hidden pointer-events-none select-none">
            {/* Ribbon 1: Gold & Terracotta Band */}
            <div className="w-32 h-3.5 bg-gradient-to-r from-[#9C2712] via-[#D4A244] to-[#9C2712] rotate-45 transform translate-x-5 translate-y-3.5 flex items-center justify-around px-2 shadow-sm border-y border-[#F6D582]/40">
              <span className="w-1.5 h-1.5 bg-[#1C1410] rotate-45 block" />
              <span className="w-1.5 h-1.5 bg-[#FAF6F0] rotate-45 block" />
              <span className="w-1.5 h-1.5 bg-[#1C1410] rotate-45 block" />
            </div>
            {/* Ribbon 2: Parallel Thin Band */}
            <div className="w-32 h-1.5 bg-[#D4A244] rotate-45 transform translate-x-5 translate-y-7 shadow-xs opacity-80" />
          </div>

          {/* Card Body Content: Left Column (Balance) & Right Column (Mesob) */}
          <div className="relative z-10 flex items-center justify-between pl-3 pr-1 py-1">
            {/* Left Column: Debter Title + Pot Balance */}
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-2">
                <h2 className="text-2xl sm:text-[26px] font-black text-[#F7F2EB] tracking-wide font-ethiopic drop-shadow-xs">
                  {t("shell.debter.label")}
                </h2>
                <ChevronRight className="w-4 h-4 text-[#D4A244]/50 group-hover:text-[#D4A244] group-hover:translate-x-0.5 transition-all duration-200" />
              </div>
              <div className="w-40 h-[1px] bg-gradient-to-r from-[#533E32] to-transparent mt-1.5 mb-3" />

              <p className="text-[11px] font-semibold text-[#B8A799] tracking-wide font-sans uppercase">
                {t("shell.debter.potBalance")}
              </p>

              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-[30px] sm:text-[34px] font-black text-white tracking-tight font-sans tabular-nums">
                  {potBalance.toLocaleString()}
                </span>
                <span className="text-lg sm:text-xl font-extrabold text-[#D4A244] font-ethiopic">
                  {t("shell.debter.currency")}
                </span>
              </div>
            </div>

            {/* Right Column: 3D Woven Mesob Basket + next draw */}
            <div className="shrink-0 flex flex-col items-center justify-center pl-2">
              <div className="relative w-16 h-20 group-hover:scale-[1.03] group-active:scale-95 transition-transform duration-200">
                <Image
                  src="/reference_assets/mesob_3d_clean.png"
                  alt={t("shell.debter.mesobAlt")}
                  fill
                  sizes="64px"
                  priority
                  className="object-contain drop-shadow-lg"
                />
              </div>
              <span className="text-[12px] sm:text-[13px] font-bold text-[#D4A244] font-ethiopic tracking-wide mt-1 group-hover:text-[#F3C769] transition-colors">
                {t("shell.debter.nextDraw")}
              </span>
            </div>
          </div>
        </div>

        {/* Peek Card on Right: Authentic Carousel Affordance */}
        <div className="w-4 shrink-0 rounded-l-[20px] bg-gradient-to-r from-[#2D211B] to-[#1E1510] border-l border-t border-b border-dashed border-[#967352]/35 shadow-md relative overflow-hidden self-stretch opacity-90">
          <div className="absolute top-0 right-0 w-8 h-8 bg-gradient-to-r from-[#9C2712] to-[#D4A244] rotate-45 transform translate-x-2 -translate-y-2 opacity-70" />
        </div>
      </div>

      {/* Centered Pagination Indicator Dots (— · ·) */}
      <div className="flex justify-center items-center gap-1.5 mt-2.5">
        <span className="w-6 h-1.5 rounded-full bg-[#8A5E3D] shadow-xs" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#C9B8A8]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#C9B8A8]" />
      </div>
    </div>
  );
}
