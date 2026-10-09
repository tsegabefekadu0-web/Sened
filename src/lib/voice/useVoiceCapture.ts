"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authedFetch, NotSignedInError } from "@/lib/auth/authedFetch";
import { createTranslator, type Locale } from "@/lib/i18n";
import { parseContributionUtterance } from "./parser";
import { createBrowserRecognizer, isSpeechRecognitionSupported, type BrowserRecognizer } from "./recognition";
import { VoiceRecorder, isRecordingSupported } from "./recorder";
import type { ProvisionalContribution, VoiceLanguage } from "./types";

export type CaptureStage = "idle" | "requesting" | "recording" | "stopping" | "transcribing";

/**
 * The capture pipeline behind the voice screens (extracted from the old
 * VoiceCapture component, behaviour unchanged): the Amharic voice service when
 * it is set up, the phone's own listening when it is not, typing when neither
 * works. Whatever is understood is parsed into a provisional draft. Nothing here
 * is verified; only the bank check makes a contribution final.
 */
export function useVoiceCapture({
  locale = "am",
  language = "am",
  initialTyped
}: {
  readonly locale?: Locale;
  readonly language?: VoiceLanguage;
  readonly initialTyped?: string;
} = {}) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [stage, setStage] = useState<CaptureStage>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interim, setInterim] = useState("");
  const [transcript, setTranscript] = useState("");
  const [typed, setTyped] = useState(initialTyped?.trim() ? initialTyped : "");
  const [mode, setMode] = useState<"voice" | "type">(initialTyped?.trim() ? "type" : "voice");
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recognizerRef = useRef<BrowserRecognizer | null>(null);
  const finalTextRef = useRef("");

  const [canRecordAudio, setCanRecordAudio] = useState(false);
  useEffect(() => {
    setCanRecordAudio(isRecordingSupported());
  }, []);

  const effectiveTranscript = mode === "type" ? typed : transcript;
  const draft: ProvisionalContribution | null = useMemo(
    () => (effectiveTranscript.trim().length > 0 ? parseContributionUtterance(effectiveTranscript) : null),
    [effectiveTranscript]
  );

  useEffect(() => {
    if (stage !== "recording") return;
    const startedAt = Date.now();
    const handle = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(handle);
  }, [stage]);

  // Leaving the screen stops the microphone.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recognizerRef.current?.abort();
    },
    []
  );

  const goTyping = useCallback((message: string | null) => {
    setMode("type");
    setStage("idle");
    setNotice(message);
  }, []);

  const serviceIsConfigured = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/voice/capabilities", { cache: "no-store" });
      if (!response.ok) return false;
      const body = (await response.json()) as { sttConfigured?: boolean };
      return body.sttConfigured === true;
    } catch {
      return false;
    }
  }, []);

  const startNativeListening = useCallback((): boolean => {
    if (!isSpeechRecognitionSupported()) return false;
    finalTextRef.current = "";
    try {
      const recognizer = createBrowserRecognizer(language, {
        onInterim: (text) => setInterim(text),
        onFinal: (text) => {
          finalTextRef.current = `${finalTextRef.current} ${text}`.trim();
          setInterim("");
        },
        onError: () => {
          recognizerRef.current = null;
          goTyping(t("voice.fallback.type"));
        },
        onEnd: () => {
          if (recognizerRef.current === null) return;
          recognizerRef.current = null;
          setStage("idle");
          const text = finalTextRef.current.trim();
          if (text.length > 0) {
            setTranscript(text);
            setMode("voice");
          } else {
            goTyping(t("voice.fallback.type"));
          }
        }
      });
      recognizerRef.current = recognizer;
      recognizer.start();
      return true;
    } catch {
      recognizerRef.current = null;
      return false;
    }
  }, [goTyping, language, t]);

  const start = useCallback(async () => {
    setNotice(null);
    setMode("voice");
    setTranscript("");
    setInterim("");
    setStage("requesting");
    const configured = canRecordAudio ? await serviceIsConfigured() : false;
    if (!configured) {
      if (startNativeListening()) {
        setNotice(t("voice.fallback.native"));
        setStage("recording");
        setElapsedSeconds(0);
        return;
      }
      goTyping(t("voice.fallback.type"));
      return;
    }
    const recorder = new VoiceRecorder({
      barCount: 8,
      onStatus: (status) => {
        if (status === "requesting_permission") setStage("requesting");
      },
      onError: (error) => setNotice(error.message)
    });
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setElapsedSeconds(0);
      setStage("recording");
    } catch {
      recorderRef.current = null;
      goTyping(t("voice.fallback.type"));
    }
  }, [canRecordAudio, goTyping, serviceIsConfigured, startNativeListening, t]);

  const stop = useCallback(async () => {
    if (recognizerRef.current) {
      setStage("stopping");
      recognizerRef.current.stop();
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) return;
    setStage("stopping");
    const result = await recorder.stop();
    recorderRef.current = null;
    if (result === null) {
      goTyping(t("voice.fallback.type"));
      return;
    }
    if (!result.quality.usable) {
      goTyping(
        result.quality.reason === "silent"
          ? t("voice.captureSilent")
          : result.quality.reason === "too_short"
            ? t("voice.captureTooShort")
            : t("voice.captureTooLong")
      );
      return;
    }
    setStage("transcribing");
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        language,
        durationMs: result.durationMs
      })
    };
    try {
      const response = await authedFetch("/api/voice/transcribe", init).catch((error: unknown) => {
        if (error instanceof NotSignedInError) return fetch("/api/voice/transcribe", init);
        throw error;
      });
      const payload = response.ok ? ((await response.json()) as { transcript?: string }) : null;
      const text = typeof payload?.transcript === "string" ? payload.transcript : "";
      if (text.trim().length === 0) {
        goTyping(t("voice.transcribeFailedBody"));
        return;
      }
      setTranscript(text);
      setMode("voice");
      setStage("idle");
    } catch {
      goTyping(t("voice.transcribeFailedBody"));
    }
  }, [goTyping, language, t]);

  /** Stop listening without keeping anything. */
  const cancel = useCallback(() => {
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setStage("idle");
  }, []);

  const reset = useCallback(() => {
    cancel();
    setTranscript("");
    setTyped("");
    setInterim("");
    setNotice(null);
    setMode("voice");
  }, [cancel]);

  return {
    t,
    stage,
    recording: stage === "recording",
    busy: stage === "requesting" || stage === "stopping" || stage === "transcribing",
    elapsedSeconds,
    interim,
    transcript,
    typed,
    setTyped,
    mode,
    setMode,
    notice,
    draft,
    start,
    stop,
    cancel,
    reset
  };
}
