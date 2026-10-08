"use client";

import React from "react";

import { DiamondMedallion } from "@/components/cultural/CulturalIcons";
import { BottomNav, type NavTab } from "@/components/navigation/BottomNav";
import { AppFrame } from "@/components/shell/AppFrame";
import { type Locale, createTranslator } from "@/lib/i18n";

/**
 * The frame for every main screen except home: the dark band with the diamond
 * border and the language button, a scrolling body, and the same bottom bar as
 * home, so nobody is ever stuck on a screen with no way back.
 */
export function ScreenFrame({
  locale,
  onToggleLocale,
  title,
  activeTab = "none",
  children
}: {
  readonly locale: Locale;
  readonly onToggleLocale: () => void;
  readonly title: string;
  readonly activeTab?: NavTab | "none";
  readonly children: React.ReactNode;
}) {
  const t = createTranslator(locale);
  return (
    <AppFrame>
      <header className="relative flex shrink-0 select-none items-center justify-between gap-3 bg-gradient-to-b from-[#1C1410] via-[#211712] to-[#1A1210] px-4 py-3 text-[#F7F2EB]">
        <div className="min-w-0">
          <DiamondMedallion className="h-5 w-16" />
          <h1 className="mt-1 font-ethiopic text-[24px] font-bold leading-tight">{title}</h1>
        </div>
        <button
          type="button"
          onClick={onToggleLocale}
          aria-label={locale === "am" ? t("shell.switchToEnglish") : t("shell.switchToAmharic")}
          className="min-h-12 shrink-0 rounded-xl border-2 border-[#C89736] px-4 font-ethiopic text-[18px] font-bold text-[#F3E6D3] active:scale-95 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
        >
          {locale === "am" ? t("shell.english") : t("shell.amharic")}
        </button>
      </header>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
      <BottomNav activeTab={activeTab} locale={locale} />
    </AppFrame>
  );
}
