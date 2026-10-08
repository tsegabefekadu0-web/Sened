"use client";

import React from "react";

import { DrawBoard } from "@/components/draw/DrawBoard";
import { HapticsToggle } from "@/components/draw/HapticsToggle";
import { LiveDraw } from "@/components/draw/LiveDraw";
import { AppFrame } from "@/components/shell/AppFrame";
import { BottomNav } from "@/components/navigation/BottomNav";
import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { MeskelCross } from "@/components/cultural/CulturalIcons";
import { useSession } from "@/lib/auth/useSession";
import { useAppLocale } from "@/lib/appLocale";
import { translate } from "@/lib/i18n";

export default function DrawPage() {
  const [locale, setLocale] = useAppLocale("am");
  const session = useSession();

  return (
    <AppFrame>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#322722] bg-[#1C1410] px-4 py-3 select-none">
          <div className="flex items-center gap-3">
            <MeskelCross className="h-9 w-9 drop-shadow-sm" />
            <div>
              <h1 className="font-ethiopic text-[22px] font-bold leading-tight text-[#FAF6F0]">
                {translate(locale, "shell.nav.draw")}
              </h1>
              <p className="font-ethiopic text-base font-medium leading-snug text-[#EBD9B4]">
                {translate(locale, "draw.page.subtitle")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLocale((value) => (value === "am" ? "en" : "am"))}
            aria-label={locale === "am" ? "Switch to English" : "Switch to Amharic"}
            className="min-h-12 rounded-xl border border-[#6B5A50] px-4 font-sans text-base font-semibold text-[#EBE2D8] transition-colors hover:border-[#D4A244] active:scale-95"
          >
            {locale === "am" ? translate("en", "shell.english") : translate("am", "shell.amharic")}
          </button>
          {/* Which group the draw is for; renders nothing unless signed in with a group. */}
          <GroupSwitcher locale={locale} tone="dark" className="basis-full" />
        </header>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <HapticsToggle locale={locale} />

        {session.status === "signed-in" ? (
          <LiveDraw locale={locale} accessToken={session.accessToken} />
        ) : session.status === "loading" ? (
          <p role="status" className="px-4 py-6 text-base text-[#4F4137]">
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
        <BottomNav activeTab="draw" locale={locale} />
    </AppFrame>
  );
}
