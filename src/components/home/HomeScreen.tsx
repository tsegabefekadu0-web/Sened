"use client";

import Link from "next/link";
import React, { useMemo } from "react";

import { AppHeader, LanguageSwitch } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Icon } from "@/components/ui/Icon";
import { BasketRing, type RingKind } from "@/components/ui/BasketRing";
import { Card, CountUp, Screen, StatusPill } from "@/components/ui/primitives";
import { SampleChip, CommunityNotice } from "@/components/ui/Notices";
import { ETHIOPIC_MONTHS, ETHIOPIC_MONTHS_EN, geez, toEthiopic } from "@/lib/ui/geez";
import { useCommunity, formatBirr } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";

export function HomeScreen() {
  const { t, locale } = useT();
  const c = useCommunity();
  const loading = c.mode === "loading";
  const ec = useMemo(() => toEthiopic(new Date()), []);
  const month = locale === "am" ? ETHIOPIC_MONTHS[ec.month] : ETHIOPIC_MONTHS_EN[ec.month];

  const me = c.members.find((m) => m.isMe);
  const myKind = me?.status ?? "due";
  const contribution = c.cycle?.contribution ?? (c.mode === "sample" ? 5000 : null);
  const order: RingKind[] = useMemo(() => {
    const list = c.members.length > 0 ? c.members : [];
    if (list.length === 0) return Array.from({ length: 8 }, () => "due" as RingKind);
    const kinds = list.map((m) => (m.status === "paid" ? "paid" : m.status === "draft" ? "draft" : "due") as RingKind);
    const rank = { paid: 0, draft: 1, due: 2 } as const;
    return kinds.sort((a, b) => rank[a] - rank[b]);
  }, [c.members]);
  const counts = {
    paid: order.filter((k) => k === "paid").length,
    draft: order.filter((k) => k === "draft").length,
    due: order.filter((k) => k === "due").length
  };
  const target = c.cycle?.pot ?? 0;
  const potLabel = formatBirr(c.pot);
  const hasCommunity = c.mode === "sample" || c.mode === "live" || c.mode === "loading" || c.mode === "empty";
  const name = c.groupName || t("ui.home.noName");

  return (
    <Screen loading={loading}>
      <AppHeader bottom={84} ribbon={40}>
        <div className="flex min-h-[44px] items-center justify-start">
          <LanguageSwitch />
        </div>
        <SampleChip mode={c.mode} />
        <div className="flex items-center gap-3.5">
          <span lang="am" aria-hidden="true" className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-[18px] bg-white font-serif text-[30px] font-bold" style={{ color: "var(--shop)" }}>
            {c.mode === "sample" ? "እ" : name.trim().charAt(0) || "ሰ"}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 lang="am" className="m-0 font-serif text-[30px] font-bold leading-[1.2]">
              {name}
            </h1>
            {c.mode === "sample" ? <span className="font-display text-[15px] font-semibold opacity-90">Bole Neighbourhood Equb</span> : null}
          </div>
        </div>
      </AppHeader>

      <CommunityNotice mode={c.mode} />

      {hasCommunity ? (
        /* Phones: the three blocks stack (the wrapper vanishes). Desktop: share card left, round progress and next draw right. */
        <div className="contents lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-2 lg:items-start lg:gap-x-8">
          <Card className="snd-rise snd-stagger flex flex-col gap-4 p-5 lg:col-start-1 lg:row-span-2 lg:row-start-1" style={{ ["--i" as string]: 0, margin: "-30px 16px 0" } as React.CSSProperties}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span lang="am" className="text-base font-semibold text-soft">
                  {t("ui.home.share", { month })}
                </span>
                <span className="flex items-baseline gap-2">
                  {contribution !== null ? (
                    <CountUp to={contribution} className="font-display text-[32px] font-extrabold leading-[1.1]" style={{ letterSpacing: "-0.02em" }} />
                  ) : (
                    <span className="font-display text-[32px] font-extrabold leading-[1.1]">—</span>
                  )}
                  <span lang="am" className="font-serif text-xl font-bold">
                    {t("ui.birr")}
                  </span>
                </span>
              </div>
              <StatusPill kind={myKind === "paid" ? "paid" : "due"} label={myKind === "paid" ? t("ui.status.paid") : t("ui.status.due")} />
            </div>
            <Link
              href="/voice"
              className="flex h-[54px] items-center justify-center gap-2.5 rounded-[27px] bg-prim text-[17px] font-bold text-primt"
              style={{ boxShadow: "0 8px 16px -10px rgba(28,26,23,0.7)" }}
            >
              <Icon name="mic" size={22} />
              {t("ui.home.recordByVoice")}
            </Link>
            <p lang="am" className="m-0 text-center text-[15px] leading-[1.5] text-soft">
              {t("ui.home.speakHint")}
            </p>
          </Card>

          <section className="snd-rise lg:col-start-2 lg:row-start-1 lg:!mt-[26px]" style={{ ["--i" as string]: 3, margin: "34px 16px 0" } as React.CSSProperties}>
            <div className="mx-1 mb-3.5 flex items-baseline justify-between">
              <h2 lang="am" className="m-0 font-serif text-[25px] font-bold">
                {t("ui.home.roundProgress")}
              </h2>
              {c.cycle ? (
                <span lang="am" className="font-serif text-[17px] font-bold text-soft">
                  {t("ui.home.roundOf", { n: locale === "am" ? geez(c.cycle.round) : c.cycle.round, total: locale === "am" ? geez(c.cycle.totalRounds) : c.cycle.totalRounds })}
                </span>
              ) : null}
            </div>
            <Link href="/members" aria-label={t("ui.members.title")} className="snd-cotton flex items-center gap-4 rounded-[22px] border border-hair bg-card" style={{ padding: "22px 18px" }}>
              <BasketRing
                order={order}
                label={t("ui.home.ringLabel", { paid: counts.paid, draft: counts.draft, due: counts.due })}
                centerTop={potLabel}
                centerBottom={target > 0 ? t("ui.home.outOf", { total: formatBirr(target) }) : t("ui.birr")}
              />
              <ul className="m-0 flex grow list-none flex-col gap-3.5 p-0">
                {(
                  [
                    ["paid", t("ui.status.paid"), counts.paid, "var(--paid)"],
                    ["draft", t("ui.status.draft"), counts.draft, "var(--draft)"],
                    ["due", t("ui.status.due"), counts.due, "var(--due)"]
                  ] as const
                ).map(([k, label, n, color]) => (
                  <li key={k} className="flex items-center gap-[9px] text-[15px]">
                    <span className="h-3 w-3 rounded-full" style={{ background: color, boxShadow: "inset 0 -2px 2px rgba(0,0,0,0.22), inset 0 1px 1px rgba(255,255,255,0.4)" }} />
                    <span lang="am" className="grow">
                      {label}
                    </span>
                    <span className="font-display text-[17px] font-extrabold">{n}</span>
                  </li>
                ))}
              </ul>
            </Link>
          </section>

          <section className="snd-rise lg:col-start-2 lg:row-start-2" style={{ ["--i" as string]: 5, margin: "22px 16px 0" } as React.CSSProperties}>
            <Link href="/draw" className="snd-cotton flex min-h-[72px] items-center gap-3.5 rounded-[22px] border border-hair bg-card" style={{ padding: "14px 16px 14px 14px" }}>
              <span className="relative flex h-16 w-14 shrink-0 flex-col items-center justify-center overflow-hidden rounded-2xl bg-[#1C1A17] text-white">
                <span aria-hidden="true" className="absolute left-0 top-0 h-full w-full" style={{ background: "linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.30) 50%, transparent 70%)", animation: "snd-shimmer 900ms var(--snd-ease) 1100ms both" }} />
                <span lang="am" className="font-serif text-2xl font-bold leading-[1.2]">
                  {c.cycle ? (locale === "am" ? geez(c.cycle.round) : c.cycle.round) : "፴"}
                </span>
                <span lang="am" className="text-[13px] opacity-85">
                  {c.cycle ? t("ui.round") : month}
                </span>
              </span>
              <span className="flex grow flex-col gap-0.5">
                <span lang="am" className="font-serif text-[19px] font-bold">
                  {t("ui.home.nextDraw")}
                </span>
                <span lang="am" className="text-sm text-muted">
                  {t("ui.home.nextDrawHint")}
                </span>
              </span>
              <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-[var(--chipb)]">
                <Icon name="next" size={20} />
              </span>
            </Link>
          </section>
        </div>
      ) : null}
      <div style={{ height: 28 }} />
      <BottomNav />
    </Screen>
  );
}
