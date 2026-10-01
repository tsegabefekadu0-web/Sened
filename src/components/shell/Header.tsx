"use client";

import React, { useMemo } from "react";
import {
  MeskelCross,
  DiamondMedallion,
  VerticalTibebBorder,
  ScallopedPlaque,
} from "@/components/cultural/CulturalIcons";
import { createTranslator, type Locale } from "@/lib/i18n";

interface HeaderProps {
  onOpenDigest: () => void;
  isPlayingAudio?: boolean;
  /** Ge'ez-primary, so `am` by default — see `DebterCard`. */
  locale?: Locale;
}

export function Header({ onOpenDigest, isPlayingAudio = false, locale = "am" }: HeaderProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  return (
    <header className="relative w-full bg-gradient-to-b from-[#1C1410] via-[#211712] to-[#1A1210] pt-8 pb-9 px-5 select-none shrink-0">
      {/* Warm inner glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(212,162,68,0.06)_0%,_transparent_60%)] pointer-events-none" />

      {/* Left and Right Vertical Tibeb Embroidery Ribbon Borders */}
      <div className="absolute left-1 top-0 bottom-0 w-3.5 overflow-hidden pointer-events-none opacity-90">
        <VerticalTibebBorder className="w-full h-full" />
      </div>
      <div className="absolute right-1 top-0 bottom-0 w-3.5 overflow-hidden pointer-events-none opacity-90">
        <VerticalTibebBorder className="w-full h-full" />
      </div>

      <div className="max-w-4xl mx-auto">
        {/* Top Ornamental Row: Meskel Cross + Diamond Medallion */}
        <div className="relative z-10 flex items-center justify-between px-3 pt-1">
          {/* Left: Ethiopian Meskel Cross */}
          <div className="w-10 h-10 flex items-center justify-center">
            <MeskelCross className="w-9 h-9 drop-shadow-sm" />
          </div>

          {/* Center: Traditional Diamond Embroidery Medallion */}
          <div className="flex-1 flex justify-center items-center px-1">
            <DiamondMedallion className="w-28 sm:w-32 h-9 drop-shadow-sm" />
          </div>

          {/* Right: Subtle balance indicator */}
          <div className="w-10 h-10 flex items-center justify-center">
            <span className="text-[10px] font-bold text-[#D4A244]/70 font-sans tracking-widest">
              {t("shell.debter.currency")}
            </span>
          </div>
        </div>

        {/* Center Main Community Title */}
        <div className="relative z-10 text-center mt-4 mb-2">
          <h1 className="text-[22px] sm:text-[24px] font-extrabold text-[#F7F2EB] tracking-wide font-ethiopic drop-shadow-sm">
            {t("shell.header.groupName")}
          </h1>
          <p className="mt-1 text-[11px] font-medium text-[#B8A08A] tracking-wide font-sans">
            {t("shell.header.subtitle")}
          </p>
        </div>
      </div>

      {/* Bottom Center Scalloped Arch Plaque overlapping the seam */}
      <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 z-20">
        <ScallopedPlaque
          title={t("shell.header.listen")}
          onClick={onOpenDigest}
          isPlaying={isPlayingAudio}
        />
      </div>

      {/* Bottom edge fade */}
      <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-b from-transparent to-[#F4EEE5]/20 pointer-events-none" />
    </header>
  );
}
