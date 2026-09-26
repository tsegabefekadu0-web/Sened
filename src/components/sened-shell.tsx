"use client";

import { useState } from "react";
import { M2Dashboard } from "@/components/ledger/m2-dashboard";
import { createTranslator, type Locale } from "@/lib/i18n";

export function SenedShell() {
  const [locale, setLocale] = useState<Locale>("en");
  const t = createTranslator(locale);

  return (
    <div lang={locale} className="min-h-screen overflow-x-hidden bg-parchment-100 text-coffee-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-coffee-900 focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-gold-300"
      >
        {t("shell.skipToContent")}
      </a>
      <M2Dashboard locale={locale} onLocaleChange={setLocale} />
    </div>
  );
}
