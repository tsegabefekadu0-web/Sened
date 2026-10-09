"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { saveVoiceHandoff } from "@/lib/voice/handoff";
import { useVoiceCapture } from "@/lib/voice/useVoiceCapture";
import { useSharedVoxideClient, voxideConfigured } from "@/lib/voice/voxideStore";
import { closeVoiceSheet, useVoiceSheetOpen } from "@/lib/ui/voiceSheet";
import { useT } from "@/lib/ui/useT";
import { Icon } from "./Icon";
import { SlideSwitch } from "./SlideSwitch";
import { TibebRibbon } from "./Weave";

const VoxideVoiceBridge = dynamic(() => import("@/components/assistant/VoxideVoiceBridge"), { ssr: false });

const BAR_HEIGHTS = [8, 14, 22, 12, 26, 18, 10, 24, 16, 28, 14, 20, 9, 22, 13, 18, 8, 12, 7];

/**
 * The voice sheet that rises from the dock. One switch picks the voice:
 * Amharic runs the app's own pipeline (microphone, then the transcript goes to
 * the draft screen); English hands the microphone to the Voxide assistant.
 */
export function VoiceSheet() {
  const open = useVoiceSheetOpen();
  const router = useRouter();
  const { t, locale } = useT();
  const [english, setEnglish] = useState(false);
  const [voxStatus, setVoxStatus] = useState("idle");
  const client = useSharedVoxideClient();
  const capture = useVoiceCapture({ locale, language: "am" });
  const { start, cancel } = capture;
  const sheetRef = useRef<HTMLElement | null>(null);

  // Amharic: start listening as the sheet opens; stop when it closes or the voice changes.
  useEffect(() => {
    if (open && !english) {
      void start();
      return () => cancel();
    }
    return undefined;
  }, [open, english, start, cancel]);

  // Escape closes; focus moves into the sheet while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeVoiceSheet();
    };
    window.addEventListener("keydown", onKey);
    sheetRef.current?.querySelector<HTMLElement>("button[aria-label]")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onStatus = useCallback((s: string) => setVoxStatus(s), []);

  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    if (!open) setFinishing(false);
  }, [open]);

  const finish = async () => {
    if (english || !capture.recording) {
      closeVoiceSheet();
      if (!english) router.push("/voice");
      return;
    }
    setFinishing(true);
    await capture.stop();
  };

  // The Amharic pipeline hands back a transcript: carry it to the draft; otherwise open typing.
  useEffect(() => {
    if (!open || english || !finishing || capture.stage !== "idle") return;
    setFinishing(false);
    closeVoiceSheet();
    if (capture.transcript.trim() !== "") {
      saveVoiceHandoff({ utterance: capture.transcript, source: "asr" });
      router.push("/voice/draft");
    } else {
      router.push("/voice");
    }
  }, [open, english, finishing, capture.stage, capture.transcript, router]);

  const configured = voxideConfigured();
  const vox = english ? (configured ? (client ? "ready" : "loading") : "missing") : null;
  const title = english ? t("ui.voice.titleEn") : t("ui.voice.title");
  const sub = english ? t("ui.voice.subEn") : t("ui.voice.subAm");
  const listen = english
    ? vox === "missing"
      ? t("ui.voice.enMissing")
      : voxStatus === "listening"
        ? t("ui.voice.listeningEn")
        : t("ui.voice.connecting")
    : capture.recording
      ? t("ui.voice.listening")
      : capture.busy
        ? t("ui.voice.working")
        : t("ui.voice.ready");
  const line = english ? t("ui.voice.lineEn") : capture.interim || capture.notice || t("ui.voice.line");
  const cta = english ? t("ui.voice.doneEn") : t("ui.voice.done");

  return (
    <>
      {open && english && configured && client ? <VoxideVoiceBridge client={client} active={open && english} onStatus={onStatus} /> : null}
      <div
        id="snd-vs-back"
        onClick={closeVoiceSheet}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 19,
          backgroundColor: "rgba(12,10,8,0.56)",
          opacity: open ? 1 : 0,
          visibility: open ? "visible" : "hidden",
          transition: `opacity 320ms var(--snd-ease), visibility 0s linear ${open ? "0s" : "320ms"}`
        }}
      />
      <section
        id="snd-vs-sheet"
        data-open={open ? "1" : "0"}
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("ui.voice.title")}
        data-no-sk
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 20,
          maxWidth: 480,
          margin: "0 auto",
          borderRadius: "28px 28px 0 0",
          overflow: "hidden",
          backgroundColor: "var(--card)",
          color: "var(--ink)",
          boxShadow: "0 -20px 40px -20px rgba(0,0,0,0.5)",
          transform: `translateY(${open ? "0" : "105%"})`,
          visibility: open ? "visible" : "hidden",
          transition: `transform 320ms var(--snd-emph), visibility 0s linear ${open ? "0s" : "320ms"}`
        }}
      >
        <TibebRibbon style={{ top: 0 }} animate={open} />
        <div className="flex flex-col items-center gap-3.5" style={{ padding: "40px 20px 24px" }}>
          <div className="flex w-full items-center justify-between">
            <span className="flex flex-col gap-px">
              <span lang="am" className="font-serif text-[22px] font-bold leading-[1.25]">
                {title}
              </span>
              <span className="text-sm text-muted">{sub}</span>
            </span>
            <button type="button" aria-label={t("ui.close")} onClick={closeVoiceSheet} className="flex h-11 w-11 items-center justify-center rounded-full border-none bg-hair2 p-0 text-ink">
              <Icon name="close" size={22} />
            </button>
          </div>

          <div aria-hidden="true" className="relative flex h-[220px] w-full items-center justify-center">
            {[
              { s: 210, c: 0.05, d: "-2.4s" },
              { s: 160, c: 0.1, d: "-1.2s" },
              { s: 118, c: 0.18, d: "0s" }
            ].map((r) => (
              <span
                key={r.s}
                className="absolute rounded-full"
                style={{ width: r.s, height: r.s, backgroundColor: `color-mix(in srgb, var(--shop) ${r.c * 100}%, transparent)`, animation: `snd-breathe 3.6s ease-in-out ${r.d} infinite` }}
              />
            ))}
            <span
              className="relative flex h-[84px] w-[84px] items-center justify-center rounded-full bg-prim text-primt"
              style={{ boxShadow: "0 16px 24px -12px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.14)" }}
            >
              <Icon name="mic" size={34} />
            </span>
            <span className="absolute flex h-[26px] items-center gap-1" style={{ bottom: 4 }}>
              {BAR_HEIGHTS.map((h, i) => (
                <span key={i} className="snd-bar block" style={{ width: 3, height: h, borderRadius: 2, backgroundColor: "var(--shop)", opacity: 0.8, animation: `snd-bar 900ms ease-in-out ${-i * 70}ms infinite` }} />
              ))}
            </span>
          </div>

          <span lang={english ? "en" : "am"} role="status" className="text-[15px] font-bold text-soft">
            {listen}
          </span>

          <div className="flex items-center justify-center gap-2 rounded-[30px] bg-hair2" style={{ padding: "6px 14px" }}>
            <SlideSwitch checked={english} onChange={setEnglish} label={t("ui.voice.switchLabel")} left="አማርኛ" right="English" />
          </div>

          <p lang={english ? "en" : "am"} className="m-0 min-h-[24px] text-center text-base leading-[1.5] text-soft">
            {line}
          </p>

          <button
            type="button"
            onClick={() => void finish()}
            className="flex h-[54px] w-full items-center justify-center rounded-[27px] border-none bg-prim text-[17px] font-bold text-primt"
            style={{ boxShadow: "0 8px 16px -10px rgba(0,0,0,0.7)" }}
          >
            <span lang={english ? "en" : "am"}>{cta}</span>
          </button>
        </div>
      </section>
    </>
  );
}
