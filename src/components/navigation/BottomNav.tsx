"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { BookOpen, Dices, Home, User } from "lucide-react";

import { createTranslator, type Locale } from "@/lib/i18n";

export type NavTab = "home" | "profile";

interface BottomNavProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  /** Ge'ez-primary, so `am` by default. */
  locale?: Locale;
}

const ITEM =
  "relative flex min-h-[64px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 font-ethiopic text-[16px] font-bold leading-tight transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#F3C769]";

/**
 * The one navigation. Four places, each with its name written under its icon.
 * Ledger and Draw open their own screens; Home and Profile stay on this one.
 * Speaking a contribution is the big button on the home screen, not a tab.
 */
export function BottomNav({ activeTab = "home", onTabChange, locale = "am" }: BottomNavProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const tone = (active: boolean) => (active ? "text-[#F3C769]" : "text-[#E3D3BF] hover:text-[#F3C769]");
  const bar = (active: boolean) =>
    active ? <span className="absolute inset-x-4 top-0 h-[3px] rounded-b-full bg-[#F3C769]" aria-hidden="true" /> : null;

  return (
    <nav
      aria-label={t("shell.primaryNavigation")}
      className="relative z-30 w-full shrink-0 select-none border-t-2 border-[#C89736] bg-[#1A1412] pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_14px_rgba(0,0,0,0.25)]"
    >
      <div className="mx-auto flex w-full max-w-[480px] items-stretch">
        <button
          type="button"
          onClick={() => onTabChange("home")}
          aria-current={activeTab === "home" ? "page" : undefined}
          className={`${ITEM} ${tone(activeTab === "home")}`}
        >
          {bar(activeTab === "home")}
          <Home className="h-6 w-6 stroke-[2.2]" aria-hidden="true" />
          <span>{t("shell.nav.home")}</span>
        </button>

        <Link href="/ledger" className={`${ITEM} ${tone(false)}`}>
          <BookOpen className="h-6 w-6 stroke-[2.2]" aria-hidden="true" />
          <span>{t("shell.nav.ledger")}</span>
        </Link>

        <Link href="/draw" className={`${ITEM} ${tone(false)}`}>
          <Dices className="h-6 w-6 stroke-[2.2]" aria-hidden="true" />
          <span>{t("shell.nav.draw")}</span>
        </Link>

        <button
          type="button"
          onClick={() => onTabChange("profile")}
          aria-current={activeTab === "profile" ? "page" : undefined}
          className={`${ITEM} ${tone(activeTab === "profile")}`}
        >
          {bar(activeTab === "profile")}
          <User className="h-6 w-6 stroke-[2.2]" aria-hidden="true" />
          <span>{t("shell.nav.profile")}</span>
        </button>
      </div>
    </nav>
  );
}
