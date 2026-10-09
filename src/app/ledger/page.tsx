"use client";

import React, { useEffect, useMemo, useState } from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Card, Screen, StatusPill } from "@/components/ui/primitives";
import { CommunityNotice, SampleChip } from "@/components/ui/Notices";
import { WeaveSwatch, WovenAvatar } from "@/components/ui/Weave";
import { ETHIOPIC_MONTHS, ETHIOPIC_MONTHS_EN, geez, toEthiopic } from "@/lib/ui/geez";
import { formatBirr, useCommunity, type LedgerRowView } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";
import type { MessageKey } from "@/lib/i18n";

const CHANNEL_KEY: Record<NonNullable<LedgerRowView["channel"]>, MessageKey> = {
  telebirr: "ui.channel.telebirr",
  cbe: "ui.channel.cbe",
  awash: "ui.channel.awash",
  cash: "ui.channel.cash",
  bank: "ui.channel.bank"
};

export default function LedgerPage() {
  const { t, locale } = useT();
  const c = useCommunity();
  const loading = c.mode === "loading";
  const cur = useMemo(() => Math.min(toEthiopic(new Date()).month, 11), []);
  const months = useMemo(() => [-2, -1, 0, 1].map((d) => (cur + d + 12) % 12), [cur]);
  const [picked, setPicked] = useState(cur);
  useEffect(() => setPicked(cur), [cur]);
  const names = locale === "am" ? ETHIOPIC_MONTHS : ETHIOPIC_MONTHS_EN;

  const rows = c.rows.filter((r) => r.month === picked);
  const total = rows.filter((r) => r.kind === "paid" || r.kind === "fixed" || r.kind === "saved").reduce((sum, r) => sum + r.amount, 0);
  const hasVoid = rows.some((r) => r.kind === "void");
  const note = rows.length === 0 ? t("ui.ledger.notStarted") : hasVoid ? t("ui.ledger.correctionNote") : picked < cur ? t("ui.ledger.allConfirmed") : "";
  const pillLabel = (k: LedgerRowView["kind"]) => t(`ui.status.${k}` as MessageKey);

  return (
    <Screen loading={loading}>
      <AppHeader title={t("ui.nav.ledger")} subtitle={c.cycle ? `Ledger · ዙር ${geez(c.cycle.round)}` : "Ledger"} bottom={48}>
        {c.mode === "sample" ? <SampleChip mode={c.mode} /> : null}
      </AppHeader>
      <CommunityNotice mode={c.mode} />

      <div role="group" aria-label={t("ui.ledger.months")} className="grid grid-cols-4 gap-2" style={{ padding: "18px 16px 6px" }}>
        {months.map((m) => {
          const on = picked === m;
          return (
            <button
              key={m}
              type="button"
              lang="am"
              aria-pressed={on}
              onClick={() => setPicked(m)}
              className="h-11 cursor-pointer whitespace-nowrap rounded-[22px] px-0.5 text-[15px] font-bold"
              style={
                on
                  ? { border: "none", background: "var(--prim)", color: "var(--primt)", animation: "snd-pop 280ms var(--snd-spring) both" }
                  : { border: "1.5px solid var(--chipb)", background: "var(--card)", color: "var(--ink)" }
              }
            >
              {names[m]}
            </button>
          );
        })}
      </div>

      {cur === 11 ? (
        <p lang="am" className="mx-5 mt-3 flex items-center gap-2.5 text-sm leading-[1.4] text-muted">
          <WeaveSwatch />
          {t("ui.ledger.pagume")}
        </p>
      ) : null}

      <div className="mx-5 mb-3 mt-[18px] flex items-baseline justify-between">
        <h2 lang="am" className="m-0 font-serif text-[25px] font-bold">
          {names[picked]}
        </h2>
        <span className="flex items-baseline gap-1.5">
          <span className="font-display text-[19px] font-extrabold" style={{ letterSpacing: "-0.02em" }}>
            {formatBirr(total)}
          </span>
          <span lang="am" className="text-sm text-muted">
            {t("ui.birr")}
          </span>
        </span>
      </div>

      <Card className="mx-4 overflow-hidden p-0" style={{ boxShadow: "none" }}>
        <ul className="m-0 list-none p-0" key={picked}>
          {rows.length === 0 ? (
            <li className="flex justify-center px-4 py-[30px] text-base text-muted">
              <span lang="am">{t("ui.ledger.empty")}</span>
            </li>
          ) : (
            rows.map((r, i) => {
              const voided = r.kind === "void";
              const meta = [r.correction ? t("ui.ledger.correction") : null, r.channel ? t(CHANNEL_KEY[r.channel]) : null, r.ref].filter(Boolean).join(" · ");
              return (
                <li
                  key={r.id}
                  className="box-border flex min-h-[72px] items-center gap-3 px-4 py-3"
                  style={{ borderBottom: i === rows.length - 1 ? undefined : "1px solid var(--hair2)", animation: "snd-rise 420ms var(--snd-emph) both", animationDelay: `${i * 40 + 140}ms` }}
                >
                  <WovenAvatar initial={r.initial} size={48} dim={voided} fontSize={18} />
                  <span className="flex min-w-0 grow flex-col gap-px">
                    <span lang="am" className={`font-serif text-base font-bold leading-[1.35] ${voided ? "relative inline-block self-start text-muted" : ""}`}>
                      {r.name}
                      {voided ? <Strike delay={700} /> : null}
                    </span>
                    <span lang="am" className="text-[13px] text-muted">
                      {meta}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-[5px]">
                    <span className={`font-display text-[18px] font-extrabold ${voided ? "relative inline-block self-start text-muted" : ""}`} style={{ letterSpacing: "-0.02em" }}>
                      {formatBirr(r.amount)}
                      {voided ? <Strike delay={760} /> : null}
                    </span>
                    <StatusPill kind={r.kind} label={pillLabel(r.kind)} />
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </Card>
      {note ? (
        <p lang="am" className="mx-6 mb-0 mt-3.5 text-sm leading-[1.5] text-muted">
          {note}
        </p>
      ) : null}
      <div style={{ height: 28 }} />
      <BottomNav />
    </Screen>
  );
}

function Strike({ delay }: { readonly delay: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute left-0 right-0"
      style={{ top: "55%", height: 1.6, background: "var(--muted)", transformOrigin: "left center", animation: `snd-strike 320ms var(--snd-ease) ${delay}ms both` }}
    />
  );
}
