"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef } from "react";

import { Icon } from "@/components/ui/Icon";
import { Screen } from "@/components/ui/primitives";
import { TibebRibbon } from "@/components/ui/Weave";
import { monthLabelForLocale } from "@/lib/voice/months";
import { saveVoiceHandoff } from "@/lib/voice/handoff";
import { useVoiceCapture } from "@/lib/voice/useVoiceCapture";
import { useT } from "@/lib/ui/useT";

const BARS = [8, 14, 22, 12, 26, 18, 10, 24, 16, 28, 14, 20, 9, 22, 13, 18, 8, 12, 7];

/** Speak: the full-page listening screen. Voice first, typing when the microphone cannot be used. */
export default function SpeakPage() {
  const { t, locale } = useT();
  const router = useRouter();
  const cap = useVoiceCapture({ locale, language: "am" });
  const { start, cancel } = cap;
  const started = useRef(false);
  const finishing = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
    return () => cancel();
  }, [start, cancel]);

  const text = cap.mode === "type" ? cap.typed : cap.transcript;
  const words = (cap.recording && cap.interim ? cap.interim : text).split(/\s+/).filter(Boolean);
  const d = cap.draft;
  const found: string[] = [];
  if (d?.amount != null) found.push(`${d.amount.toLocaleString("en-US")} ${t("ui.birr")}`);
  const month = d ? monthLabelForLocale(d.month, locale) : null;
  if (month) found.push(month);
  if (d?.provider) found.push(t(`ui.channel.${d.provider}` as "ui.channel.telebirr"));
  if (d?.txRef) found.push(d.txRef);

  const goDraft = (utterance: string, source: "asr" | "human-typed") => {
    saveVoiceHandoff({ utterance, source });
    router.push("/voice/draft");
  };

  // After "done" while recording, wait for the transcript, then move on.
  useEffect(() => {
    if (finishing.current && cap.stage === "idle" && cap.transcript.trim() !== "") {
      finishing.current = false;
      goDraft(cap.transcript, "asr");
    } else if (finishing.current && cap.stage === "idle") {
      finishing.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap.stage, cap.transcript]);

  const done = async () => {
    if (cap.recording) {
      finishing.current = true;
      await cap.stop();
      return;
    }
    if (text.trim() !== "") goDraft(text, cap.mode === "type" ? "human-typed" : "asr");
  };

  const status = cap.recording ? t("ui.voice.listening") : cap.busy ? t("ui.voice.working") : t("ui.voice.ready");

  return (
    <Screen>
      <header className="relative flex items-center gap-2 overflow-hidden text-white" style={{ background: "var(--shop)", padding: "10px 14px 52px 8px", borderRadius: "0 0 28px 28px" }}>
        <Link href="/home" aria-label={t("ui.back.home")} onClick={() => cancel()} className="flex h-11 w-11 items-center justify-center rounded-full text-white">
          <Icon name="back" size={22} />
        </Link>
        <div className="flex min-w-0 grow flex-col">
          <h1 lang="am" className="m-0 font-serif text-[19px] font-bold leading-[1.2]">
            {status}
          </h1>
          <span className="font-display text-[13px] font-semibold opacity-90">Listening</span>
        </div>
        <TibebRibbon style={{ bottom: 0 }} />
      </header>

      <section aria-label={t("ui.voice.mic")} className="relative flex items-center justify-center" style={{ height: 330 }}>
        {[
          { s: 300, c: 5, d: "-2.4s" },
          { s: 228, c: 10, d: "-1.2s" },
          { s: 166, c: 18, d: "0s" }
        ].map((r) => (
          <span key={r.s} aria-hidden="true" className="absolute rounded-full" style={{ width: r.s, height: r.s, background: `color-mix(in srgb, var(--shop) ${r.c}%, transparent)`, animation: `snd-breathe 3.6s ease-in-out ${r.d} infinite` }} />
        ))}
        <button
          type="button"
          onClick={() => (cap.recording ? void cap.stop() : cap.busy ? undefined : void cap.start())}
          aria-label={cap.recording ? t("ui.voice.stop") : t("ui.voice.start")}
          className="relative flex h-28 w-28 items-center justify-center rounded-full border-none bg-prim text-primt"
          style={{ boxShadow: "0 1px 1px rgba(28,26,23,0.3), 0 20px 30px -12px rgba(28,26,23,0.6), inset 0 1px 0 rgba(255,255,255,0.14)" }}
        >
          <Icon name={cap.recording ? "stop" : "mic"} size={44} />
        </button>
        <span aria-hidden="true" className="absolute flex h-7 items-center gap-1" style={{ bottom: 10 }}>
          {BARS.map((h, i) => (
            <span key={i} className="snd-bar block" style={{ width: 3, height: h, borderRadius: 2, background: "var(--shop)", opacity: 0.75, animation: cap.recording ? `snd-bar 900ms ease-in-out ${-i * 70}ms infinite` : "none", transform: cap.recording ? undefined : "scaleY(.4)" }} />
          ))}
        </span>
      </section>

      <section className="snd-cotton mx-4 flex flex-col gap-4 rounded-[22px] border border-hair bg-card p-5" style={{ boxShadow: "var(--lift)" }}>
        <span lang="am" className="text-sm font-bold text-muted">
          {t("ui.voice.heard")}
        </span>
        {cap.mode === "type" ? (
          <label className="flex flex-col gap-2">
            <span className="sr-only">{t("ui.voice.typeLabel")}</span>
            <textarea
              value={cap.typed}
              onChange={(e) => cap.setTyped(e.target.value)}
              rows={3}
              placeholder={t("ui.voice.typePlaceholder")}
              className="w-full resize-y rounded-2xl border border-hair bg-field p-3 font-serif text-[20px] font-bold leading-[1.5] text-ink"
            />
          </label>
        ) : (
          <p lang="am" className="m-0 min-h-[34px] font-serif text-[22px] font-bold leading-[1.55]" aria-live="polite">
            {words.length ? (
              <>
                «
                {words.map((w, i) => (
                  <React.Fragment key={`${i}-${w}`}>
                    <span style={{ display: "inline-block", animation: "snd-word 260ms var(--snd-ease) both" }}>{w}</span>{" "}
                  </React.Fragment>
                ))}
                »
              </>
            ) : (
              <span className="text-muted">{t("ui.voice.line")}</span>
            )}
          </p>
        )}
        {cap.notice ? (
          <p lang="am" role="status" className="m-0 text-sm leading-[1.5] text-muted">
            {cap.notice}
          </p>
        ) : null}
        {found.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {found.map((f, i) => (
              <li key={f} lang="am" className="flex h-8 items-center rounded-2xl border border-hair bg-bg px-3.5 text-sm font-bold" style={{ animation: "snd-pop 320ms var(--snd-spring) both", animationDelay: `${i * 160}ms` }}>
                {f}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="mt-auto flex flex-col gap-1" style={{ padding: "26px 20px 30px" }}>
        <button
          type="button"
          onClick={() => void done()}
          disabled={cap.busy || (!cap.recording && text.trim() === "")}
          className="flex h-[54px] items-center justify-center gap-2.5 rounded-[27px] border-none bg-prim text-[17px] font-bold text-primt disabled:opacity-50"
          style={{ boxShadow: "0 8px 16px -10px rgba(28,26,23,0.7)" }}
        >
          <Icon name="check" size={22} />
          {t("ui.voice.done")}
        </button>
        <Link href="/home" onClick={() => cancel()} className="flex min-h-12 items-center justify-center text-base font-bold text-soft">
          {t("ui.cancel")}
        </Link>
      </div>
    </Screen>
  );
}
