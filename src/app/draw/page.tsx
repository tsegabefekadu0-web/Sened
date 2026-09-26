"use client";

import React, { useState } from "react";

import { DrawBoard } from "@/components/draw/DrawBoard";
import { MeskelCross } from "@/components/cultural/CulturalIcons";
import type { Locale } from "@/components/draw/copy";

export default function DrawPage() {
  const [locale, setLocale] = useState<Locale>("am");

  return (
    <main className="min-h-screen w-full bg-[#120D0A] flex flex-col items-center justify-center sm:py-6 antialiased selection:bg-amber-500 selection:text-coffee-950">
      <div className="w-full max-w-[396px] bg-[#FAF6F0] h-[100dvh] sm:h-[844px] flex flex-col relative overflow-hidden sm:rounded-[48px] sm:border-[8px] sm:border-[#261E1A] sm:shadow-[0_25px_80px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.08)]">
        {/*
          A1 owns `src/app/page.tsx` and links here during integration
          (docs/requests/agent-3.md R-4). The frame classes above are copied
          verbatim from `page.tsx:60-62` so this route is indistinguishable from
          the M1 shell it will one day sit beside.
        */}
        <header className="flex items-center justify-between gap-3 border-b border-[#322722] bg-[#1C1410] px-4 py-3 select-none">
          <div className="flex items-center gap-2.5">
            <MeskelCross className="h-7 w-7 drop-shadow-sm" />
            <div>
              <h1 className="font-ethiopic text-[16px] font-bold leading-tight tracking-wide text-[#FAF6F0]">
                እጣ
              </h1>
              <p className="font-sans text-[10px] font-medium tracking-[0.16em] text-[#D4A244]">
                VERIFIABLE DRAW
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

        <DrawBoard locale={locale} />
      </div>
    </main>
  );
}
