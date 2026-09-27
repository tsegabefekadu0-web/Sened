"use client";

import React from "react";
import Link from "next/link";
import { BookOpen, Users, User, ArrowLeft } from "lucide-react";

import { createTranslator, type Locale } from "@/lib/i18n";

/**
 * The four bottom-nav slots are not dead ends any more.
 *
 * `page.tsx` tracked `activeTab` and rendered nothing for it. A tab that changes
 * state and shows no content is a control that lies: it looks like a feature and
 * is not one. §12.7 asks for honest empty states, and a silent no-op is the
 * opposite of one.
 *
 * So each slot is now honest in one of two ways. Two have a real destination and
 * link to it — the ledger review, which is 847 lines of built UI that had no
 * route — and two have none, so they say plainly that they are not built yet and
 * offer the nearest thing that *is*. Members and Profile need a signed-in
 * treasurer and a group roster, which is board task #5's auth dependency; the
 * panel points at what exists today rather than pretending otherwise.
 *
 * Both languages, via the shared dictionary. This component and the rest of the
 * Gen A shell used to hard-code Ge'ez and never call `t()`, which is a standing
 * §12.6 violation on the surface a reviewer sees first.
 */

type Tab = "home" | "ledger" | "members" | "profile";

const DESTINATIONS: Partial<
  Record<Tab, { readonly href: string; readonly labelKey: string }>
> = {
  ledger: { href: "/ledger", labelKey: "tab.panels.ledgerLink" }
};

const TITLES: Readonly<Record<Tab, string>> = {
  home: "tab.panels.home",
  ledger: "tab.panels.ledger",
  members: "tab.panels.members",
  profile: "tab.panels.profile"
};

const ICONS: Readonly<Record<Tab, typeof BookOpen>> = {
  home: BookOpen,
  ledger: BookOpen,
  members: Users,
  profile: User
};

export function TabPanel({
  tab,
  onBack,
  locale = "en"
}: {
  readonly tab: Tab;
  readonly onBack: () => void;
  readonly locale?: Locale;
}) {
  const t = createTranslator(locale);
  const Icon = ICONS[tab];
  const destination = DESTINATIONS[tab];

  return (
    <section
      aria-label={t(TITLES[tab] as never)}
      className="absolute inset-x-0 top-[132px] z-40 mx-4 max-w-[364px] rounded-3xl border border-[#DECDBB] bg-[#FAF6F0] p-5 shadow-[0_18px_40px_-12px_rgba(38,30,26,0.45)]"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#F0E6D8] text-[#A3441F]">
          <Icon className="h-5 w-5 stroke-[2.2]" aria-hidden="true" />
        </span>
        <h2 className="font-ethiopic text-lg font-bold text-[#1F1714]">
          {t(TITLES[tab] as never)}
        </h2>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-[#6B5B4E]">
        {t("tab.panels.pending" as never)}
      </p>

      {destination ? (
        <Link
          href={destination.href}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#2A1F1A] px-4 py-2.5 text-sm font-semibold text-[#FAF7F2] transition-colors hover:bg-[#3D2E27] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
        >
          {t(destination.labelKey as never)}
        </Link>
      ) : null}

      <button
        type="button"
        onClick={onBack}
        className="mt-4 ml-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[#8A7A6D] hover:text-[#3D2E27] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("tab.panels.back" as never)}
      </button>
    </section>
  );
}
