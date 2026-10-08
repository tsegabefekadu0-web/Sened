"use client";

import React, { useState } from "react";

import { DrawBoard } from "@/components/draw/DrawBoard";
import { HapticsToggle } from "@/components/draw/HapticsToggle";
import { LiveDraw } from "@/components/draw/LiveDraw";
import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { MeskelCross } from "@/components/cultural/CulturalIcons";
import type { Locale } from "@/components/draw/copy";
import { useSession } from "@/lib/auth/useSession";
import { translate } from "@/lib/i18n";

export default function DrawPage() {
  const [locale, setLocale] = useState<Locale>("am");
  const session = useSession();

  return (
    <main className="min-h-screen w-full bg-[#120D0A] flex flex-col items-center justify-center sm:py-6 antialiased selection:bg-amber-500 selection:text-coffee-950">
      {/* Responsive Shell Frame: Native 100% on phone, expansive premium dashboard canvas on desktop */}
      <div className="w-full md:max-w-5xl lg:max-w-6xl bg-[#FAF6F0] h-[100dvh] md:h-[92vh] md:min-h-[820px] md:max-h-[960px] flex flex-col relative overflow-hidden md:rounded-3xl md:border md:border-[#382B24]/50 md:shadow-[0_25px_80px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#322722] bg-[#1C1410] px-4 py-3 select-none">
          <div className="flex items-center gap-2.5">
            <MeskelCross className="h-7 w-7 drop-shadow-sm" />
            <div>
              <h1 className="font-ethiopic text-[16px] font-bold leading-tight tracking-wide text-[#FAF6F0]">
                እጣ
              </h1>
              <p className="font-sans text-[10px] font-medium tracking-[0.16em] text-[#D4A244]">
                {locale === "am" ? "ሊረጋገጥ የሚችል እጣ" : "VERIFIABLE DRAW"}
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
          {/* Which group the draw is for; renders nothing unless signed in with a group. */}
          <GroupSwitcher locale={locale} tone="dark" className="basis-full sm:max-w-xs" />
        </header>

        <HapticsToggle locale={locale} />

        {session.status === "signed-in" ? (
          <LiveDraw locale={locale} accessToken={session.accessToken} />
        ) : session.status === "loading" ? (
          <p role="status" className="px-4 py-6 text-[13px] text-[#6F625D]">
            {translate(locale, "drawLive.loading")}
          </p>
        ) : (
          // Signed out, or this build has no Supabase: the on-device demo,
          // labelled as such. It never calls /api/draw/*.
          <DrawBoard
            locale={locale}
            demoNotice={translate(
              locale,
              session.status === "unconfigured" ? "draw.demoUnconfigured" : "draw.demoSignedOut"
            )}
          />
        )}
      </div>
    </main>
  );
}
