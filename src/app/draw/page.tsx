"use client";

import Link from "next/link";
import React, { useState } from "react";

import { DrawCeremony } from "@/components/draw3d/DrawCeremony";
import { AppHeader } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { CoffeeSteps } from "@/components/ui/CoffeeSteps";
import { CommunityNotice } from "@/components/ui/Notices";
import { Button, Screen } from "@/components/ui/primitives";
import { TibebRibbon, WovenRing } from "@/components/ui/Weave";
import { geez } from "@/lib/ui/geez";
import { formatBirr, useCommunity } from "@/lib/ui/useCommunity";
import { useDrawView } from "@/lib/ui/useDrawView";
import { useT } from "@/lib/ui/useT";

export default function DrawPage() {
  const { t, locale } = useT();
  const c = useCommunity();
  const [replayKey, setReplayKey] = useState(0);
  const { view, verify } = useDrawView(c, replayKey);
  const [progress, setProgress] = useState({ step: 0, won: false });
  const [checked, setChecked] = useState(false);
  const loading = view.status === "loading";
  const ready = view.status === "ready" ? view : null;
  const roundNo = (n: number) => (locale === "am" ? geez(n) : String(n));

  const steps = [
    { name: t("ui.draw.abol"), text: t("ui.draw.abolText") },
    { name: t("ui.draw.tona"), text: t("ui.draw.tonaText") },
    { name: t("ui.draw.baraka"), text: t("ui.draw.barakaText") }
  ];

  return (
    <Screen loading={loading}>
      <header
        className="relative flex flex-col overflow-hidden text-white lg:!grid lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:items-center lg:gap-x-10 lg:!pl-[max(20px,calc((100%-1200px)/2+20px))] lg:!pr-[max(20px,calc((100%-1200px)/2+20px))]"
        style={{ background: "var(--shop)", padding: "18px 20px 70px", borderRadius: "0 0 28px 28px" }}
      >
        <div className="flex items-center gap-2 lg:col-start-1 lg:row-start-1" style={{ marginLeft: -12 }}>
          <Link href="/home" aria-label={t("ui.back.home")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white">
            <BackIcon />
          </Link>
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <h1 lang="am" className="m-0 font-serif text-[30px] font-bold leading-[1.2] lg:text-[40px]">
              {t("ui.nav.draw")}
            </h1>
            <span lang="am" className="font-serif text-[15px] font-medium opacity-90">
              {ready ? t("ui.draw.roundOf", { n: roundNo(ready.round) }) : t("ui.draw.noDraw")}
            </span>
          </div>
        </div>
        {ready ? (
          <DrawCeremony
            key={`${ready.drawId ?? "demo"}-${ready.winner.name}-${replayKey}`}
            winnerName={ready.winner.name}
            roundLabel={`${t("ui.draw.title")} · ${t("ui.draw.roundOf", { n: roundNo(ready.round) })}`}
            groupName={c.groupName}
            letters={ready.letters}
            replayLabel={t("ui.draw.replay")}
            canvasLabel={t("ui.draw.canvas")}
            onProgress={(step, won) => setProgress({ step, won })}
            className="lg:col-start-2 lg:row-start-1 lg:!mx-0 lg:!mt-0"
          />
        ) : (
          <div className="lg:col-start-2 lg:row-start-1" style={{ height: 120 }} />
        )}
        <TibebRibbon style={{ bottom: 50 }} />
      </header>

      <CommunityNotice mode={c.mode} />

      {/* Phones: one column (the wrapper vanishes). Desktop: winner and verification left, the coffee steps right. */}
      <div className="contents lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-2 lg:items-start lg:gap-x-8">
      {ready ? (
        <section
          id="snd-win"
          aria-label={t("ui.draw.winner")}
          className={`snd-cotton snd-fade relative flex items-center gap-3.5 rounded-[22px] border border-hair bg-card lg:col-start-1 lg:row-start-1 ${progress.won ? "snd-won" : ""}`}
          style={{ margin: "-46px 16px 0", padding: "18px 20px", boxShadow: "var(--lift)", transition: "box-shadow 700ms cubic-bezier(0.32,0.72,0,1), border-color 700ms cubic-bezier(0.32,0.72,0,1), transform 700ms cubic-bezier(0.32,0.72,0,1)" }}
        >
          <span aria-hidden="true" className="snd-pls" />
          <WovenRing size={64}>
            <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-[#1C1A17] font-serif text-2xl font-bold text-white">
              {ready.winner.initial}
            </span>
          </WovenRing>
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span lang="am" className="text-sm text-muted">
              {t("ui.draw.winner")}
            </span>
            <span lang="am" data-testid="draw-winner" className="font-serif text-xl font-bold leading-[1.3]">
              {ready.winner.name}
            </span>
          </div>
          <span className="flex shrink-0 items-baseline gap-[5px]">
            <span className="font-display text-[22px] font-extrabold" style={{ letterSpacing: "-0.02em" }}>
              {formatBirr(ready.pot)}
            </span>
            <span lang="am" className="font-serif text-[15px] font-bold">
              {t("ui.birr")}
            </span>
          </span>
        </section>
      ) : view.status === "none" || view.status === "error" ? (
        <p lang="am" role="status" className="snd-cotton mx-4 rounded-[22px] border border-hair bg-card p-5 text-base leading-[1.5] text-soft lg:col-start-1 lg:row-start-1" style={{ marginTop: -46 }}>
          {view.status === "none" ? t("ui.draw.none") : t("ui.notice.error")}
        </p>
      ) : null}

      <div style={{ margin: "26px 16px 0" }} className="snd-rise lg:col-start-2 lg:row-span-3 lg:row-start-1">
        <CoffeeSteps steps={steps} filled={checked ? 3 : progress.step} label={t("ui.draw.coffee")} />
      </div>

      {ready ? (
        <div className="flex flex-col gap-3 lg:col-start-1 lg:row-start-2" style={{ margin: "22px 16px 0" }}>
          <Button
            onPress={async () => {
              const ok = await verify();
              setChecked(ok);
              return ok;
            }}
            successLabel={t("ui.status.paid")}
            errorLabel={t("ui.tryAgain")}
            disabled={checked}
            className={checked ? "!bg-[#E3F1E8] !text-[#1F6B3F]" : ""}
          >
            {checked ? t("ui.draw.verified") : t("ui.draw.verify")}
          </Button>
          <p lang="am" className="m-0 text-center text-sm leading-[1.5] text-muted">
            {checked ? t("ui.draw.verifiedHelp") : t("ui.draw.help")}
            {ready.demo ? ` ${t("ui.draw.demo")}` : ""}
          </p>
          {ready.demo ? (
            <button type="button" onClick={() => { setChecked(false); setReplayKey((k) => k + 1); }} className="h-12 rounded-3xl border-[1.5px] border-prim bg-card text-base font-bold text-ink">
              {t("ui.draw.again")}
            </button>
          ) : null}
        </div>
      ) : null}
      {c.mode === "live" && c.role !== null ? (
        <Link href="/draw/manage" data-testid="manage-link" className="flex h-[54px] lg:col-start-1 lg:row-start-3 items-center justify-center rounded-[27px] border-[1.5px] border-prim bg-card text-[17px] font-bold text-ink" style={{ margin: "12px 16px 0" }}>
          <span lang="am">{c.role === "owner" || c.role === "treasurer" ? t("ui.manage.link") : t("ui.manage.memberLink")}</span>
        </Link>
      ) : null}
      </div>
      <div style={{ height: 28 }} />
      <BottomNav active="home" />
    </Screen>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m14.6 5.4-6.6 6.6 6.6 6.6" />
    </svg>
  );
}
