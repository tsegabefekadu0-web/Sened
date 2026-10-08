"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BottomNav } from "@/components/navigation/BottomNav";
import { M2Dashboard } from "@/components/ledger/m2-dashboard";
import { createTranslator, type Locale } from "@/lib/i18n";

export function SenedShell() {
  const [locale, setLocale] = useState<Locale>("en");
  const t = createTranslator(locale);

  return (
    <div lang={locale} className="min-h-screen overflow-x-hidden bg-parchment-100 pb-[88px] text-coffee-900 md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-coffee-900 focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-gold-300"
      >
        {t("shell.skipToContent")}
      </a>
      {/* Wide screens: a clear way home at the top. Phones get the bottom bar below. */}
      <div className="hidden bg-[#2A1D17] px-6 py-2 md:block">
        <Link
          href="/"
          className="inline-flex min-h-12 items-center gap-2 font-ethiopic text-[18px] font-bold text-[#F3E6D3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F3C769]"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          {t("shell.backHome")}
        </Link>
      </div>
      <M2Dashboard locale={locale} onLocaleChange={setLocale} />
      <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        <BottomNav activeTab="ledger" locale={locale} ariaLabel={t("shell.tabBar")} />
      </div>
    </div>
  );
}
