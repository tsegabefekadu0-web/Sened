"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { AppFrame } from "@/components/shell/AppFrame";
import { type Locale, createTranslator } from "@/lib/i18n";

/**
 * A plain, centred screen for the few pages that do one thing (sign in, join).
 * A dark band with a way back and the language button, then the content in the
 * middle of the column: one heading, one short sentence, one big button.
 */
export function SimpleScreen({
  locale,
  onToggleLocale,
  icon,
  title,
  children
}: {
  readonly locale: Locale;
  readonly onToggleLocale: () => void;
  readonly icon?: React.ReactNode;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const t = createTranslator(locale);
  return (
    <AppFrame>
      <div className="flex shrink-0 items-center justify-between bg-[#2A1D17] px-4 py-2 text-[#F3E6D3]">
        <Link
          href="/"
          className="inline-flex min-h-12 items-center gap-2 font-ethiopic text-[18px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F3C769]"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          {t("auth.backHome")}
        </Link>
        <button
          type="button"
          onClick={onToggleLocale}
          className="min-h-12 rounded-lg px-3 font-ethiopic text-[18px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F3C769]"
        >
          {locale === "am" ? t("shell.english") : t("shell.amharic")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8 text-center">
        <div className="w-full space-y-6">
          {icon ? (
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[#F0E6D8] text-[#A9411D]">{icon}</div>
          ) : null}
          <h1 className="font-ethiopic text-[30px] font-bold leading-tight text-[#2A1D17]">{title}</h1>
          {children}
        </div>
      </div>
    </AppFrame>
  );
}

export const PRIMARY_BUTTON =
  "flex min-h-[60px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-[#B84A22] to-[#8F2D12] px-5 py-3 font-ethiopic text-[20px] font-bold text-white shadow-[0_8px_18px_rgba(143,45,18,0.3)] active:scale-[0.98] disabled:opacity-60 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]";
export const BODY_TEXT = "font-ethiopic text-[18px] leading-[1.7] text-[#3A2C22]";
