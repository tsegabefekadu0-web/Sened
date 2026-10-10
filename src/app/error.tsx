"use client";

import React from "react";

import { LanguageSwitch } from "@/components/ui/AppHeader";
import { useT } from "@/lib/ui/useT";

/**
 * The route error boundary. Without this a thrown render shows Next's default
 * page with a stack trace and no way back — the worst possible thing to show a
 * treasurer who is trying to record a payment.
 *
 * `reset()` re-renders the segment, which is the honest fix for a transient
 * failure. The copy says the saved work is safe, because it is: the offline desk
 * and the ledger both keep their state on the device before anything is sent.
 */
export default function Error({ reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  const { t, locale } = useT();

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg px-5 py-5 text-ink">
      <div className="flex w-full justify-end">
        <LanguageSwitch />
      </div>

      <div className="flex grow flex-col items-center justify-center py-8 text-center">
        <div className="flex w-full max-w-[520px] flex-col items-center gap-6">
          <span
            lang="am"
            aria-hidden="true"
            className="flex h-[72px] w-[72px] items-center justify-center rounded-[22px] font-serif text-[34px] font-bold"
            style={{ background: "var(--dng)", color: "#fff" }}
          >
            ሰ
          </span>

          <div className="flex flex-col gap-3">
            <h1 lang={locale} className="m-0 font-serif text-[28px] font-bold leading-[1.25]">
              {t("ui.error.title")}
            </h1>
            <p lang={locale} className="m-0 text-base leading-[1.65] text-soft">
              {t("ui.error.body")}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={reset}
              className="flex h-[52px] items-center justify-center rounded-[26px] px-8 text-[17px] font-bold"
              style={{ background: "var(--prim)", color: "var(--primt)", boxShadow: "0 8px 16px -10px rgba(28,26,23,0.7)" }}
            >
              {t("ui.error.retry")}
            </button>
            <a href="/home" className="flex h-[52px] items-center justify-center rounded-[26px] border border-hair px-8 text-[17px] font-bold text-ink">
              {t("ui.notFound.back")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
