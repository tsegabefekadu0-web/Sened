"use client";

import Link from "next/link";
import React from "react";

import { LanguageSwitch } from "@/components/ui/AppHeader";
import { useT } from "@/lib/ui/useT";
import { TibebRibbon } from "@/components/ui/Weave";

/**
 * The 404. A dead link used to fall through to Next's default white page, which
 * on a brand this considered reads as a broken app. This keeps the identity: the
 * woven mark, the tibeb ribbon, and a way home in the visitor's language.
 *
 * A client component because the app's language override lives in localStorage
 * and there is no server-side locale to read — the same reason every other
 * screen in this app is a client component.
 *
 * The language switch is here on purpose: the app opens in Amharic, so without
 * it somebody who follows a bad link and reads only English would be stranded.
 */
export default function NotFound() {
  const { t, locale } = useT();

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-bg px-5 py-5 text-ink">
      <div className="flex w-full justify-end">
        <LanguageSwitch />
      </div>

      <div className="flex grow flex-col items-center justify-center py-8 text-center">
        <div className="flex w-full max-w-[520px] flex-col items-center gap-6">
          <span
            lang="am"
            aria-hidden="true"
            className="flex h-[72px] w-[72px] items-center justify-center rounded-[22px] font-serif text-[34px] font-bold"
            style={{ background: "var(--shop)", color: "#fff" }}
          >
            ሰ
          </span>

          <div className="flex flex-col gap-3">
            {/* Geez numerals, so the code is not a Latin afterthought. */}
            <p lang="am" data-testid="notfound-code" className="m-0 font-serif text-[64px] font-bold leading-none" style={{ color: "var(--shop)" }}>
              ፬፻፬
            </p>
            <h1 lang={locale} className="m-0 font-serif text-[28px] font-bold leading-[1.25]">
              {t("ui.notFound.title")}
            </h1>
            <p lang={locale} className="m-0 text-base leading-[1.65] text-soft">
              {t("ui.notFound.body")}
            </p>
          </div>

          <Link
            href="/home"
            className="flex h-[52px] items-center justify-center rounded-[26px] px-8 text-[17px] font-bold"
            style={{ background: "var(--prim)", color: "var(--primt)", boxShadow: "0 8px 16px -10px rgba(28,26,23,0.7)" }}
          >
            {t("ui.notFound.back")}
          </Link>
        </div>
      </div>

      {/* The woven edge the app header and the hero also carry. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[22px]" aria-hidden="true">
        <TibebRibbon style={{ bottom: 0 }} />
      </div>
    </div>
  );
}
