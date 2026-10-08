"use client";

import React, { useMemo } from "react";
import { DiamondMedallion, VerticalTibebBorder, ScallopedPlaque } from "@/components/cultural/CulturalIcons";
import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { createTranslator, type Locale } from "@/lib/i18n";

interface HeaderProps {
  onOpenDigest: () => void;
  isPlayingAudio?: boolean;
  /** Ge'ez-primary, so `am` by default. */
  locale?: Locale;
}

/**
 * The dark Ethiopian band: diamond border, group name, and the gold listen pill.
 * Kept short on purpose so the balance is on screen without scrolling.
 */
export function Header({ onOpenDigest, isPlayingAudio = false, locale = "am" }: HeaderProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  return (
    <header className="relative w-full shrink-0 select-none bg-gradient-to-b from-[#1C1410] via-[#211712] to-[#1A1210] px-5 pb-8 pt-3">
      {/* Warm inner glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(212,162,68,0.06)_0%,_transparent_60%)]" />

      {/* Left and right vertical Tibeb embroidery borders */}
      <div className="pointer-events-none absolute bottom-0 left-1 top-0 w-3.5 overflow-hidden opacity-90">
        <VerticalTibebBorder className="h-full w-full" />
      </div>
      <div className="pointer-events-none absolute bottom-0 right-1 top-0 w-3.5 overflow-hidden opacity-90">
        <VerticalTibebBorder className="h-full w-full" />
      </div>

      <div className="relative z-10 mx-auto flex flex-col items-center text-center">
        <DiamondMedallion className="h-7 w-24 drop-shadow-sm" />
        <h1 className="mt-1 font-ethiopic text-[24px] font-bold leading-tight text-[#F7F2EB]">
          {t("shell.header.groupName")}
        </h1>
        <p className="font-ethiopic text-[18px] font-medium leading-snug text-[#E3D3BF]">
          {t("shell.header.subtitle")}
        </p>
        {/* Which group the whole app is acting on; renders nothing unless signed in with a group. */}
        <GroupSwitcher locale={locale} tone="dark" className="mx-auto mt-2 w-full max-w-[17rem] px-1 text-left [&>p]:text-center" />
      </div>

      {/* The gold listen pill overlaps the seam */}
      <div className="absolute -bottom-7 left-1/2 z-20 -translate-x-1/2">
        <ScallopedPlaque
          title={t("shell.header.listen")}
          onClick={onOpenDigest}
          isPlaying={isPlayingAudio}
        />
      </div>
    </header>
  );
}
