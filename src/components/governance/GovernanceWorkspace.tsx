"use client";

import React, { useState } from "react";

import { MeskelCross } from "@/components/cultural/CulturalIcons";
import { createTranslator, type Locale } from "@/lib/i18n";

import { GovernanceCopilot } from "./GovernanceCopilot";

export function GovernanceWorkspace() {
  const [locale, setLocale] = useState<Locale>("am");
  const t = createTranslator(locale);

  return (
    <main className="min-h-screen w-full bg-[#120D0A] flex flex-col items-center justify-center sm:py-6 antialiased selection:bg-amber-500 selection:text-coffee-950">
      <div className="w-full md:max-w-3xl bg-[#FAF6F0] h-[100dvh] md:h-[92vh] md:min-h-[640px] md:max-h-[960px] flex flex-col relative overflow-hidden md:rounded-3xl md:border md:border-[#382B24]/50 md:shadow-[0_25px_80px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)]">
        <header className="flex items-center justify-between gap-3 border-b border-[#322722] bg-[#1C1410] px-4 py-3 select-none">
          <div className="flex items-center gap-2.5">
            <MeskelCross className="h-7 w-7 drop-shadow-sm" />
            <div>
              <h1 className="font-ethiopic text-[16px] font-bold leading-tight tracking-wide text-[#FAF6F0]">
                {t("governance.eyebrow")}
              </h1>
              <p className="font-sans text-[10px] font-medium tracking-[0.16em] text-[#D4A244]">
                BYLAWS &middot; ScholarXIV
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLocale((value) => (value === "am" ? "en" : "am"))}
            aria-pressed={locale === "en"}
            aria-label={locale === "am" ? "Switch to English" : "Switch to Amharic"}
            className="min-h-9 rounded-xl border border-[#453630] px-3 font-sans text-[11px] font-semibold tracking-wide text-[#EBE2D8] transition-colors hover:border-[#D4A244] active:scale-95"
          >
            {locale === "am" ? "EN" : "አማ"}
          </button>
        </header>
        <div className="border-b border-[#EBE2D8] bg-[#F5EFEB] px-4 py-3">
          <h2 className="font-ethiopic text-[17px] font-bold leading-snug text-[#1C1410]">{t("governance.title")}</h2>
          <p className="mt-1 text-[12px] leading-snug text-[#6F625D]">{t("governance.intro")}</p>
        </div>

        <GovernanceCopilot locale={locale} />
      </div>
    </main>
  );
}
