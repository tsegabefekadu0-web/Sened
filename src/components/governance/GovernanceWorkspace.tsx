"use client";

import React from "react";

import { MeskelCross } from "@/components/cultural/CulturalIcons";
import { createTranslator } from "@/lib/i18n";
import { useAppLocale } from "@/lib/appLocale";

import { AppFrame } from "@/components/shell/AppFrame";
import { BottomNav } from "@/components/navigation/BottomNav";
import { GovernanceCopilot } from "./GovernanceCopilot";

export function GovernanceWorkspace() {
  const [locale, setLocale] = useAppLocale("am");
  const t = createTranslator(locale);

  return (
    <AppFrame>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#322722] bg-[#1C1410] px-4 py-3 select-none">
          <div className="flex items-center gap-2.5">
            <MeskelCross className="h-7 w-7 drop-shadow-sm" />
            <div>
              <h1 className="font-ethiopic text-[20px] font-bold leading-snug text-[#FAF6F0]">
                {t("governance.eyebrow")}
              </h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLocale((value) => (value === "am" ? "en" : "am"))}
                        aria-pressed={locale === "en"}
            aria-label={locale === "am" ? t("shell.switchToEnglish") : t("shell.switchToAmharic")}
            className="min-h-12 rounded-xl border border-[#453630] px-3 font-sans text-base font-semibold  text-[#EBE2D8] transition-colors hover:border-[#D4A244] active:scale-95"
          >
            {locale === "am" ? t("shell.english") : t("shell.amharic")}
          </button>
        </header>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="border-b border-[#EBE2D8] bg-[#F5EFEB] px-4 py-3">
          <h2 className="font-ethiopic text-[20px] font-bold leading-snug text-[#1C1410]">{t("governance.title")}</h2>
          <p className="mt-1 text-[18px] leading-[1.65] text-[#3A2C22]">{t("governance.intro")}</p>
        </div>

        <GovernanceCopilot locale={locale} />
        </div>
        <BottomNav activeTab="none" locale={locale} />
    </AppFrame>
  );
}
