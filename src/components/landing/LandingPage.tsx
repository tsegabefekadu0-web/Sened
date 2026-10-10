"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import React, { useRef, useState } from "react";

import { LandingChrome } from "@/components/landing/LandingChrome";
import { PhoneMockup } from "@/components/landing/PhoneMockup";
import { Reveal, WhenVisible } from "@/components/landing/Reveal";
import { LanguageSwitch } from "@/components/ui/AppHeader";
import { CoffeeSteps } from "@/components/ui/CoffeeSteps";
import { Icon, type IconName } from "@/components/ui/Icon";
import { SlideSwitch } from "@/components/ui/SlideSwitch";
import { TibebRibbon, WeaveSwatch, WovenRing } from "@/components/ui/Weave";
import { useTheme } from "@/lib/ui/theme";
import { useT } from "@/lib/ui/useT";

const DrawCeremony = dynamic(() => import("@/components/draw3d/DrawCeremony").then((m) => m.DrawCeremony), { ssr: false });

const FEATURES: ReadonlyArray<{ icon: IconName; title: "ui.landing.f1.title" | "ui.landing.f2.title" | "ui.landing.f3.title" | "ui.landing.f4.title"; body: "ui.landing.f1.body" | "ui.landing.f2.body" | "ui.landing.f3.body" | "ui.landing.f4.body" }> = [
  { icon: "book", title: "ui.landing.f1.title", body: "ui.landing.f1.body" },
  { icon: "shield", title: "ui.landing.f2.title", body: "ui.landing.f2.body" },
  { icon: "draw", title: "ui.landing.f3.title", body: "ui.landing.f3.body" },
  { icon: "phone", title: "ui.landing.f4.title", body: "ui.landing.f4.body" }
];

const FAQ = ["1", "2", "3", "4"] as const;

const WRAP = "mx-auto w-full max-w-[1120px] px-5 md:px-8";

/** The public landing page, shown at `/` to signed-out visitors and at `/welcome`. Amharic first; the switch in the corner makes it English. */
export function LandingPage() {
  const { t, locale } = useT();
  const [theme, setTheme] = useTheme();
  const [step, setStep] = useState(0);
  // The condensed nav and the scroll hairline measure this to decide when to appear.
  const heroRef = useRef<HTMLElement>(null);

  const steps = [
    { name: t("ui.draw.abol"), text: t("ui.landing.how1") },
    { name: t("ui.draw.tona"), text: t("ui.landing.how2") },
    { name: t("ui.draw.baraka"), text: t("ui.landing.how3") }
  ];

  return (
    <div className="min-h-[100dvh] bg-bg text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-prim focus:px-4 focus:py-3 focus:text-primt">
        {t("shell.skipToContent")}
      </a>

      <LandingChrome heroRef={heroRef} />

      {/* ---------- Hero ---------- */}
      <header ref={heroRef} className="relative overflow-hidden text-white" style={{ background: "var(--shop)", borderRadius: "0 0 36px 36px" }}>
        <div className={`${WRAP} flex items-center justify-between py-4`}>
          <Link href="/welcome" className="flex items-center gap-3" aria-label="ሰነድ">
            <span lang="am" aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white font-serif text-2xl font-bold" style={{ color: "var(--shop)" }}>
              ሰ
            </span>
            <span lang="am" className="font-serif text-2xl font-bold">
              ሰነድ
            </span>
          </Link>
          <nav aria-label={t("ui.nav.main")} className="flex items-center gap-3 md:gap-5">
            <LanguageSwitch />
            <Link href="/sign-in" className="hidden h-11 items-center rounded-full border border-white/50 px-5 text-[15px] font-bold text-white sm:flex">
              {t("ui.landing.signIn")}
            </Link>
          </nav>
        </div>

        <div className={`${WRAP} grid items-center gap-10 pb-28 pt-8 md:pb-32 lg:grid-cols-[1.1fr_0.9fr] lg:gap-6 lg:pt-14`}>
          <div className="flex flex-col gap-6">
            <h1 lang="am" className="m-0 font-serif text-[56px] font-bold leading-[1.05] sm:text-[72px] lg:text-[96px]" style={{ animation: "snd-rise 600ms var(--snd-emph) both" }}>
              ሰነድ
            </h1>
            <p lang={locale} className="m-0 max-w-[30ch] font-serif text-[26px] font-bold leading-[1.35] sm:text-[32px]" style={{ animation: "snd-rise 600ms var(--snd-emph) 80ms both" }}>
              {t("ui.landing.headline")}
            </p>
            <figure className="m-0 flex flex-col gap-1.5" style={{ animation: "snd-rise 600ms var(--snd-emph) 160ms both" }}>
              <blockquote lang="am" className="m-0 font-serif text-[22px] font-bold leading-[1.4] sm:text-[26px]">
                «{t("ui.proverb")}»
              </blockquote>
              <figcaption className="font-display text-[15px] font-medium opacity-90">{t("ui.proverbGloss")}</figcaption>
            </figure>
            <div className="flex flex-col gap-3 sm:flex-row" style={{ animation: "snd-rise 600ms var(--snd-emph) 240ms both" }}>
              <Link
                href="/sign-up"
                className="flex h-[58px] items-center justify-center rounded-[29px] bg-white px-8 text-lg font-bold text-[#1C1A17]"
                style={{ boxShadow: "0 12px 20px -12px rgba(0,0,0,0.6)" }}
              >
                <span lang="am">{t("ui.landing.cta")}</span>
              </Link>
              <Link href="/home" className="flex h-[58px] items-center justify-center rounded-[29px] border border-white/60 px-8 text-lg font-bold text-white">
                {t("ui.landing.seeSample")}
              </Link>
            </div>
          </div>
          <div style={{ animation: "snd-rise 700ms var(--snd-emph) 200ms both" }}>
            <PhoneMockup
              labels={{
                name: t("ui.landing.mockName"),
                share: t("ui.home.share", { month: locale === "am" ? "መስከረም" : "Meskerem" }),
                record: t("ui.home.recordByVoice"),
                progress: t("ui.home.roundProgress"),
                paid: t("ui.status.paid"),
                draft: t("ui.status.draft"),
                due: t("ui.status.due"),
                status: t("ui.status.due")
              }}
            />
          </div>
        </div>
        <TibebRibbon style={{ bottom: 0 }} />
      </header>

      <main id="main">
        {/* ---------- How it works ---------- */}
        <section className={`${WRAP} py-20 md:py-28`} aria-labelledby="how-title">
          <Reveal className="mb-10 flex max-w-[640px] flex-col gap-3">
            <WeaveSwatch className="!w-14" />
            <h2 id="how-title" lang="am" className="m-0 font-serif text-[32px] font-bold leading-[1.2] md:text-[44px]">
              {t("ui.landing.howTitle")}
            </h2>
            <p lang={locale} className="m-0 text-lg leading-[1.6] text-soft">
              {t("ui.landing.howLead")}
            </p>
          </Reveal>
          <div className="grid items-start gap-8 lg:grid-cols-2">
            <Reveal>
              <CoffeeSteps steps={steps} filled={step + 1} label={t("ui.draw.coffee")} />
            </Reveal>
            <Reveal delay={120} className="flex flex-col gap-4">
              <div className="flex gap-2" role="tablist" aria-label={t("ui.landing.howTitle")}>
                {steps.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    role="tab"
                    aria-selected={step === i}
                    onClick={() => setStep(i)}
                    lang="am"
                    className="h-11 rounded-3xl px-5 text-[15px] font-bold"
                    style={step === i ? { background: "var(--prim)", color: "var(--primt)", border: "none", animation: "snd-pop 280ms var(--snd-spring) both" } : { background: "var(--card)", color: "var(--ink)", border: "1.5px solid var(--chipb)" }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              {/* key={step} remounts the body so it re-runs its entrance on every switch;
                  without it the copy would teleport with no bridge between states. */}
              <p key={step} lang={locale} className="snd-panel m-0 text-xl leading-[1.6]" role="tabpanel">
                {[t("ui.landing.how1Long"), t("ui.landing.how2Long"), t("ui.landing.how3Long")][step]}
              </p>
            </Reveal>
          </div>
        </section>

        {/* ---------- Trust ---------- */}
        <section className="bg-hair2 py-20 md:py-28" aria-labelledby="trust-title">
          <div className={WRAP}>
            <Reveal className="mb-10 flex max-w-[640px] flex-col gap-3">
              <h2 id="trust-title" lang="am" className="m-0 font-serif text-[32px] font-bold leading-[1.2] md:text-[44px]">
                {t("ui.landing.trustTitle")}
              </h2>
            </Reveal>
            <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f, i) => (
                <Reveal as="li" key={f.title} delay={i * 70} className="snd-cotton flex flex-col gap-3 rounded-[22px] border border-hair bg-card p-6">
                  <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "var(--tint)", color: "var(--shop)" }}>
                    <Icon name={f.icon} size={26} variant="duo" />
                  </span>
                  <h3 lang={locale} className="m-0 font-serif text-xl font-bold leading-[1.3]">
                    {t(f.title)}
                  </h3>
                  <p lang={locale} className="m-0 text-base leading-[1.6] text-soft">
                    {t(f.body)}
                  </p>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- 3D showpiece ---------- */}
        <section className={`${WRAP} py-20 md:py-28`} aria-labelledby="draw-title">
          <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <Reveal className="flex flex-col gap-4">
              <h2 id="draw-title" lang="am" className="m-0 font-serif text-[32px] font-bold leading-[1.2] md:text-[44px]">
                {t("ui.landing.drawTitle")}
              </h2>
              <p lang={locale} className="m-0 text-lg leading-[1.6] text-soft">
                {t("ui.landing.drawBody")}
              </p>
            </Reveal>
            <div className="relative overflow-hidden text-white" style={{ background: "var(--shop)", borderRadius: 28, padding: "20px 20px 0" }} data-testid="landing-draw">
              <WhenVisible minHeight={340}>
                <DrawCeremony
                  winnerName="ወ/ሮ ጽጌ ከ"
                  roundLabel={t("ui.landing.drawRound")}
                  groupName={t("ui.landing.mockName")}
                  letters={["በ", "አ", "ጽ", "ታ", "ፋ", "ዮ", "ሙ"]}
                  replayLabel={t("ui.draw.replay")}
                  canvasLabel={t("ui.draw.canvas")}
                  onProgress={() => undefined}
                />
              </WhenVisible>
            </div>
          </div>
        </section>

        {/* ---------- Community teaser ---------- */}
        <section className="bg-hair2 py-20 md:py-28" aria-labelledby="chat-title">
          <div className={`${WRAP} grid items-center gap-10 lg:grid-cols-2`}>
            <Reveal className="flex flex-col gap-4">
              <h2 id="chat-title" lang="am" className="m-0 font-serif text-[32px] font-bold leading-[1.2] md:text-[44px]">
                {t("ui.landing.chatTitle")}
              </h2>
              <p lang={locale} className="m-0 text-lg leading-[1.6] text-soft">
                {t("ui.landing.chatBody")}
              </p>
            </Reveal>
            {/* Each bubble scrolls in on its own beat. `aria-hidden` sits on the
                wrapper so it still covers every child Reveal. */}
            <div className="flex flex-col gap-3" aria-hidden="true">
              {[
                { who: "ፋ", name: "ወ/ሮ ፋጡማ አ", text: "እንኳን ደስ አለሽ ጽጌ! በሰላም ይግባሽ።", mine: false },
                { who: "ጽ", name: "ወ/ሮ ጽጌ ከ", text: "አመሰግናለሁ ጎረቤቶቼ! ቡናው ለእኔ ነው።", mine: false },
                { who: "", name: "", text: "ተረድቻለሁ፣ ዛሬ ማታ በቴሌብር አስገባለሁ።", mine: true }
              ].map((m, i) => (
                <Reveal key={i} delay={i * 90} className={`flex items-end gap-2.5 ${m.mine ? "justify-end" : "justify-start"}`}>
                  {!m.mine ? (
                    <WovenRing size={40}>
                      <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-base font-bold">
                        {m.who}
                      </span>
                    </WovenRing>
                  ) : null}
                  <div
                    className="max-w-[80%] px-3.5 py-2.5"
                    style={m.mine ? { background: "color-mix(in srgb, var(--shop) 82%, #000)", color: "#fff", borderRadius: "18px 6px 18px 18px" } : { background: "var(--bubble)", border: "1px solid var(--hair)", borderRadius: "6px 18px 18px 18px" }}
                  >
                    {!m.mine ? (
                      <span lang="am" className="mb-0.5 block text-[13px] font-bold text-muted">
                        {m.name}
                      </span>
                    ) : null}
                    <span lang="am" className="text-base leading-[1.55]">
                      {m.text}
                    </span>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- FAQ ---------- */}
        <section className={`${WRAP} py-20 md:py-28`} aria-labelledby="faq-title">
          <Reveal className="mb-8">
            <h2 id="faq-title" lang="am" className="m-0 font-serif text-[32px] font-bold leading-[1.2] md:text-[44px]">
              {t("ui.landing.faqTitle")}
            </h2>
          </Reveal>
          <div className="flex max-w-[820px] flex-col gap-3">
            {FAQ.map((n) => (
              <details key={n} className="snd-cotton group rounded-[18px] border border-hair bg-card px-5 py-1">
                <summary lang={locale} className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 font-serif text-lg font-bold">
                  {t(`ui.landing.q${n}` as "ui.landing.q1")}
                  <span aria-hidden="true" className="transition-transform duration-300 group-open:rotate-45">
                    <Icon name="plus" size={22} />
                  </span>
                </summary>
                {/* The answer is wrapped so its height can be interpolated; the inner
                    box carries the clipping and the bottom gap that used to be a margin. */}
                <div className="snd-faq">
                  <div>
                    <p lang={locale} className="m-0 pb-4 text-base leading-[1.65] text-soft">
                      {t(`ui.landing.a${n}` as "ui.landing.a1")}
                    </p>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* ---------- Closing call ---------- */}
        <section className="px-5 pb-20 md:px-8">
          <Reveal className="relative mx-auto flex max-w-[1120px] flex-col items-start gap-5 overflow-hidden text-white" >
            <div className="relative w-full overflow-hidden px-6 py-12 md:px-12" style={{ background: "var(--shop)", borderRadius: 32 }}>
              <h2 lang={locale} className="m-0 max-w-[22ch] font-serif text-[30px] font-bold leading-[1.25] md:text-[40px]">
                {t("ui.landing.closing")}
              </h2>
              <Link href="/sign-up" className="mt-6 inline-flex h-[58px] items-center rounded-[29px] bg-white px-8 text-lg font-bold text-[#1C1A17]">
                <span lang="am">{t("ui.landing.cta")}</span>
              </Link>
              <TibebRibbon style={{ bottom: 0 }} />
            </div>
          </Reveal>
        </section>
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="border-t border-hair">
        <div className={`${WRAP} flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between`}>
          <div className="flex items-center gap-3">
            <span lang="am" aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-prim font-serif text-xl font-bold text-primt">
              ሰ
            </span>
            <div className="flex flex-col">
              <span lang="am" className="font-serif text-lg font-bold">
                ሰነድ · Sened
              </span>
              <span lang={locale} className="text-sm text-muted">
                {t("ui.landing.footer")}
              </span>
            </div>
          </div>
          <nav aria-label={t("ui.landing.footerNav")} className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px] font-bold">
            <Link href="/home">{t("ui.landing.seeSample")}</Link>
            <Link href="/sign-in">{t("ui.landing.signIn")}</Link>
            <Link href="/governance">{t("ui.landing.bylaws")}</Link>
          </nav>
          <SlideSwitch checked={theme === "dark"} onChange={(on) => setTheme(on ? "dark" : "light")} label={t("ui.account.look")} left={<Icon name="sun" size={18} />} right={<Icon name="moon" size={18} />} compact />
        </div>
      </footer>
    </div>
  );
}
