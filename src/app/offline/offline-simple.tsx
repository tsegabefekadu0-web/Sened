"use client";

import React from "react";
import { CheckCircle2, CloudOff, Send, WifiOff } from "lucide-react";

import { ScreenFrame } from "@/components/shell/ScreenFrame";
import type { OfflineLocale } from "@/lib/offline/copy";

export type SimpleOfflineStatus = "saved" | "waiting" | "retry" | "sent" | "problem";

export interface SimpleOfflineItem {
  readonly id: string;
  readonly kind: "note" | "entry";
  /** What the person said or entered, in their own words, when there is any. */
  readonly text: string;
  readonly amount: string | null;
  readonly status: SimpleOfflineStatus;
}

const TONE: Record<SimpleOfflineStatus, string> = {
  saved: "bg-[#F3ECE2] text-[#3A2C22]",
  waiting: "bg-[#FFF4DC] text-[#4A3414]",
  retry: "bg-[#FFF4DC] text-[#4A3414]",
  sent: "bg-[#E5F3EA] text-[#14502F]",
  problem: "bg-[#FBE3DA] text-[#7A2410]"
};

/**
 * "Saved while offline": a plain list of what is waiting on this phone, each
 * with its status in words, and one big button to send it. The developer view
 * (roster, drafts form, raw queue and ids) is at `/offline?debug=1`.
 */
export function SimpleOfflineScreen({
  locale,
  t,
  onToggleLocale,
  items,
  online,
  busy,
  canSend,
  onSend,
  message,
  problem
}: {
  readonly locale: OfflineLocale;
  readonly t: (key: string, variables?: Record<string, string | number>) => string;
  readonly onToggleLocale: () => void;
  readonly items: readonly SimpleOfflineItem[];
  readonly online: boolean | null;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly message: string | null;
  readonly problem: string | null;
}) {
  return (
    <ScreenFrame locale={locale} onToggleLocale={onToggleLocale} title={t("offline.simple.title")}>
      <div className="space-y-5 px-4 py-5">
        <p className="font-ethiopic text-[18px] leading-[1.7] text-[#3A2C22]">{t("offline.simple.intro")}</p>

        {online === false ? (
          <p className="flex items-start gap-2 rounded-2xl bg-[#FFF4DC] px-4 py-3 font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#4A3414]">
            <WifiOff className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t("offline.simple.noInternet")}</span>
          </p>
        ) : null}

        <button
          type="button"
          onClick={onSend}
          disabled={busy || !canSend}
          className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-b from-[#B84A22] to-[#8F2D12] px-5 py-3 font-ethiopic text-[22px] font-bold text-white shadow-[0_8px_18px_rgba(143,45,18,0.3)] active:scale-[0.98] disabled:cursor-not-allowed disabled:from-[#E2D6C6] disabled:to-[#E2D6C6] disabled:text-[#5B4A3C] disabled:shadow-none focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
        >
          <Send className="h-6 w-6" aria-hidden="true" />
          {busy ? t("offline.simple.sending") : t("offline.simple.send")}
        </button>

        {message ? (
          <p role="status" className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#14502F]">
            {message}
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#8F2D12]">
            {problem}
          </p>
        ) : null}

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[#C9B79F] bg-[#F3ECE2] px-5 py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-[#14502F]" aria-hidden="true" />
            <p className="font-ethiopic text-[20px] font-semibold leading-[1.6] text-[#2A1D17]">{t("offline.simple.empty")}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className={`rounded-2xl px-4 py-3 ${TONE[item.status]}`}>
                <p className="flex items-center gap-2 font-ethiopic text-[20px] font-bold leading-snug">
                  <CloudOff className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {item.kind === "note" ? t("offline.simple.note") : t("offline.simple.entry")}
                  {item.amount ? <span className="ms-auto">{item.amount}</span> : null}
                </p>
                {item.text ? <p className="mt-1 break-words font-ethiopic text-[18px] leading-[1.6]">{item.text}</p> : null}
                <p className="mt-1 font-ethiopic text-[18px] font-semibold leading-snug">
                  {t(`offline.simple.status.${item.status}`)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScreenFrame>
  );
}
