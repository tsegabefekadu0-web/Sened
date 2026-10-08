"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, HardDriveDownload, Info, Loader2, Mic, RefreshCw, Square, Type } from "lucide-react";

import { authedFetch, NotSignedInError } from "@/lib/auth/authedFetch";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { monthLabelForLocale } from "@/lib/voice/months";
import { VoiceRecorder, isRecordingSupported } from "@/lib/voice/recorder";
import {
  createBrowserRecognizer,
  isSpeechRecognitionSupported,
  type BrowserRecognizer
} from "@/lib/voice/recognition";
import {
  VOICE_BLOCKING_ISSUE_CODES,
  type ProvisionalContribution,
  type VoiceIssueCode,
  type VoiceLanguage
} from "@/lib/voice/types";
import type { BankVerificationOutcome } from "@/components/voice/VoiceModal";
import "./voice.css";

/** i18n key for each issue code. Codes not listed here are never rendered raw. */
const ISSUE_KEYS: Readonly<Record<VoiceIssueCode, MessageKey>> = {
  UNPARSEABLE: "voice.issueUnparseable",
  NO_AMOUNT: "voice.issueNoAmount",
  AMBIGUOUS_AMOUNT: "voice.issueAmbiguousAmount",
  CURRENCY_MISMATCH: "voice.issueCurrencyMismatch",
  INFERRED_CURRENCY: "voice.issueInferredCurrency",
  NO_CHANNEL: "voice.issueNoChannel",
  AMBIGUOUS_CHANNEL: "voice.issueAmbiguousChannel",
  CASH_CHANNEL: "voice.issueCashChannel",
  NO_TX_REF: "voice.issueNoTxRef",
  UNRELIABLE_TX_REF: "voice.issueUnreliableTxRef",
  MULTIPLE_MONTHS: "voice.issueMultipleMonths"
};

export interface VoiceCaptureProps {
  readonly locale?: Locale;
  readonly language?: VoiceLanguage;
  /** Text to show for review when the screen opens (the English assistant hands over what it heard). */
  readonly initialTyped?: string;
  /** With a verifier, the primary action is the bank check. Without one it is a local provisional note. */
  readonly onRequestVerification?: (draft: ProvisionalContribution) => Promise<BankVerificationOutcome>;
  readonly onRecordLocally?: (
    draft: ProvisionalContribution,
    origin: { readonly transcriptSource: "human-typed" | "asr" }
  ) => void | Promise<void>;
  /** Called after a successful save or send. The modal closes; the page shows a confirmation. */
  readonly onDone?: () => void;
}

type Stage = "idle" | "requesting" | "recording" | "stopping" | "transcribing";

/**
 * Say it, see it, save it.
 *
 * One big button records (the Amharic voice service when it is set up, the
 * phone's own listening when it is not, typing when neither works). Whatever
 * was understood is read back in large plain text. Nothing here is verified:
 * the only thing that makes a contribution final is the bank check.
 */
export function VoiceCapture({
  locale = "am",
  language = "am",
  initialTyped,
  onRequestVerification,
  onRecordLocally,
  onDone
}: VoiceCaptureProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  const [stage, setStage] = useState<Stage>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interim, setInterim] = useState("");
  const [transcript, setTranscript] = useState("");
  const [typed, setTyped] = useState(initialTyped?.trim() ? initialTyped : "");
  const [mode, setMode] = useState<"voice" | "type">(initialTyped?.trim() ? "type" : "voice");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recognizerRef = useRef<BrowserRecognizer | null>(null);
  const finalTextRef = useRef("");
  const draftRef = useRef<HTMLDivElement | null>(null);

  // Browser capabilities are read after mount so the server and first client render agree.
  const [canRecordAudio, setCanRecordAudio] = useState(false);
  useEffect(() => {
    setCanRecordAudio(isRecordingSupported());
  }, []);

  const effectiveTranscript = mode === "type" ? typed : transcript;
  const draft = useMemo(
    () => (effectiveTranscript.trim().length > 0 ? parseContributionUtterance(effectiveTranscript) : null),
    [effectiveTranscript]
  );

  // After speaking, bring what was understood into view (typing is left alone).
  useEffect(() => {
    if (transcript) {
      draftRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }, [transcript]);

  // Elapsed clock while recording.
  useEffect(() => {
    if (stage !== "recording") {
      return;
    }
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

  /** The Amharic voice service answers `sttConfigured` truthfully; no answer counts as "not set up". */
  const serviceIsConfigured = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/voice/capabilities", { cache: "no-store" });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { sttConfigured?: boolean };
      return body.sttConfigured === true;
    } catch {
      return false;
    }
  }, []);

  const startNativeListening = useCallback((): boolean => {
    if (!isSpeechRecognitionSupported()) {
      return false;
    }
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
          if (recognizerRef.current === null) {
            return;
          }
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

  const startRecording = useCallback(async () => {
    setNotice(null);
    setSubmitError(null);
    setSaved(false);
    setMode("voice");
    setTranscript("");
    setInterim("");
    setStage("requesting");

    const configured = canRecordAudio ? await serviceIsConfigured() : false;
    if (!configured) {
      // The phone's own listening, then typing, with one plain message either way.
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
        if (status === "requesting_permission") {
          setStage("requesting");
        }
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

  const stopRecording = useCallback(async () => {
    // The phone's own listening ends with a final result.
    if (recognizerRef.current) {
      setStage("stopping");
      recognizerRef.current.stop();
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
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
    const response = await authedFetch("/api/voice/transcribe", init).catch((error: unknown) => {
      if (error instanceof NotSignedInError) {
        return fetch("/api/voice/transcribe", init);
      }
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
  }, [goTyping, language, t]);

  const recording = stage === "recording";
  const busy = stage === "requesting" || stage === "stopping" || stage === "transcribing";

  const onMicClick = (): void => {
    if (recording) {
      void stopRecording();
    } else if (!busy) {
      void startRecording();
    }
  };

  const canVerify = Boolean(onRequestVerification) && Boolean(draft) && !draft?.blocking;
  const canRecordLocally = Boolean(onRecordLocally) && Boolean(draft) && !draft?.blocking;

  const recordLocally = useCallback(async () => {
    if (!draft || !onRecordLocally) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onRecordLocally(draft, { transcriptSource: mode === "voice" ? "asr" : "human-typed" });
      setSaved(true);
      setTyped("");
      setTranscript("");
      onDone?.();
    } catch {
      setSubmitError(t("voice.recordLocallyFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [draft, mode, onDone, onRecordLocally, t]);

  const submitForVerification = useCallback(async () => {
    if (!draft || !onRequestVerification) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await onRequestVerification(draft);
      if (!outcome.verified) {
        setSubmitError(t(outcome.notice ?? "voice.submitUnverifiedReason"));
        return;
      }
      setSaved(true);
      onDone?.();
    } catch {
      setSubmitError(t("voice.submitUnverifiedReason"));
    } finally {
      setSubmitting(false);
    }
  }, [draft, onDone, onRequestVerification, t]);

  const micLabel = recording
    ? elapsedSeconds > 0
      ? `${t("voice.tapToFinish")} (${t("voice.recordingElapsed", { seconds: elapsedSeconds })})`
      : t("voice.tapToFinish")
    : stage === "requesting"
      ? t("voice.permissionRequest")
      : stage === "stopping" || stage === "transcribing"
        ? t("voice.transcribing")
        : t("voice.tapToSpeak");

  const primaryClass = (enabled: boolean): string =>
    `flex min-h-[60px] w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 font-ethiopic text-[20px] font-bold focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769] ${
      enabled
        ? "bg-gradient-to-b from-[#B84A22] to-[#8F2D12] text-white shadow-[0_8px_18px_rgba(143,45,18,0.3)] active:scale-[0.98]"
        : "cursor-not-allowed bg-[#E2D6C6] text-[#5B4A3C]"
    }`;

  return (
    <div className={`sened-voice flex flex-col gap-5 text-[#2A1D17] ${recording ? "sened-voice--recording" : ""}`}>
      <p className="font-ethiopic text-[18px] leading-[1.7] text-[#3A2C22]">{t("voice.say.example")}</p>

      {/* The one big action. */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onMicClick}
          disabled={busy}
          className="group flex w-full flex-col items-center gap-3 rounded-3xl py-2 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769] disabled:opacity-80"
        >
          <span className="relative flex items-center justify-center">
            {recording ? (
              <>
                <span className="sened-voice-pulse" />
                <span className="sened-voice-pulse" />
              </>
            ) : null}
            <span
              className={`relative z-10 flex h-28 w-28 items-center justify-center rounded-full border-4 border-[#F3C769] text-white shadow-[0_10px_24px_rgba(143,45,18,0.4)] ${
                recording ? "bg-[#8F2D12]" : "bg-gradient-to-b from-[#B84A22] to-[#8F2D12]"
              }`}
            >
              {busy ? (
                <Loader2 className="h-12 w-12 animate-spin" aria-hidden="true" />
              ) : recording ? (
                <Square className="h-10 w-10 fill-white" aria-hidden="true" />
              ) : (
                <Mic className="h-12 w-12" aria-hidden="true" />
              )}
            </span>
          </span>
          <span className="font-ethiopic text-[22px] font-bold leading-snug text-[#2A1D17]" aria-live="polite">
            {recording && interim ? interim : micLabel}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            if (recording) {
              recognizerRef.current?.abort();
              recognizerRef.current = null;
              recorderRef.current?.cancel();
              recorderRef.current = null;
              setStage("idle");
            }
            setMode(mode === "type" ? "voice" : "type");
          }}
          className="inline-flex min-h-[56px] items-center justify-center gap-2 rounded-2xl border-2 border-[#A9411D] bg-white px-6 font-ethiopic text-[20px] font-bold text-[#6E3414] active:scale-[0.98] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
        >
          {mode === "voice" ? <Type className="h-6 w-6" aria-hidden="true" /> : <Mic className="h-6 w-6" aria-hidden="true" />}
          {mode === "voice" ? t("voice.typeInstead") : t("voice.voiceInstead")}
        </button>
      </div>

      {notice ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-2xl border border-[#C89736] bg-[#FFF4DC] px-4 py-3 font-ethiopic text-[18px] leading-[1.6] text-[#4A3414]"
        >
          <Info className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      ) : null}

      {mode === "voice" && transcript ? (
        <div className="rounded-2xl border border-[#D9C8B5] bg-white px-4 py-3">
          <p className="font-ethiopic text-[16px] font-semibold text-[#5B4A3C]">{t("voice.transcriptLabel")}</p>
          <p className="mt-1 font-ethiopic text-[20px] leading-[1.6] text-[#2A1D17]">{transcript}</p>
        </div>
      ) : null}

      {mode === "type" ? (
        <div>
          <label htmlFor="sened-voice-typed" className="font-ethiopic text-[18px] font-bold text-[#2A1D17]">
            {t("voice.transcriptLabel")}
          </label>
          <textarea
            id="sened-voice-typed"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            rows={3}
            placeholder={t("voice.transcriptPlaceholder")}
            className="mt-2 w-full resize-y rounded-2xl border-2 border-[#B9A58F] bg-white p-3 font-ethiopic text-[20px] leading-[1.6] text-[#2A1D17] placeholder:text-[#7A6857] focus:border-[#A9411D] focus:outline-none"
          />
        </div>
      ) : null}

      {draft ? (
        <div ref={draftRef}>
          <DraftReadBack draft={draft} t={t} locale={locale} />
        </div>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-3">
          {onRequestVerification ? (
            <button
              type="button"
              disabled={!canVerify || submitting}
              onClick={() => void submitForVerification()}
              className={primaryClass(canVerify && !submitting)}
            >
              {submitting ? <RefreshCw className="h-6 w-6 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-6 w-6" aria-hidden="true" />}
              {t("voice.submit")}
            </button>
          ) : onRecordLocally ? (
            <button
              type="button"
              disabled={!canRecordLocally || submitting}
              onClick={() => void recordLocally()}
              className={primaryClass(canRecordLocally && !submitting)}
            >
              {submitting ? <RefreshCw className="h-6 w-6 animate-spin" aria-hidden="true" /> : <HardDriveDownload className="h-6 w-6" aria-hidden="true" />}
              {t("voice.recordLocally")}
            </button>
          ) : (
            <p className="flex items-start gap-2 rounded-2xl bg-[#FBEFE6] px-4 py-3 font-ethiopic text-[18px] text-[#6E3414]">
              <AlertTriangle className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{t("voice.submitUnwiredBody")}</span>
            </p>
          )}
          {onRequestVerification && draft.blocking ? (
            <p className="flex items-start gap-2 rounded-2xl bg-[#FBEFE6] px-4 py-3 font-ethiopic text-[18px] text-[#6E3414]">
              <AlertTriangle className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{t("voice.submitUnverifiedReason")}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {submitError ? (
        <p role="alert" className="flex items-start gap-2 rounded-2xl bg-[#FBEFE6] px-4 py-3 font-ethiopic text-[18px] font-semibold text-[#8F2D12]">
          <AlertTriangle className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{submitError}</span>
        </p>
      ) : null}

      {saved ? (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-[#E5F3EA] px-4 py-3 font-ethiopic text-[18px] font-semibold text-[#14502F]">
          <CheckCircle2 className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{t("voice.saved")}</span>
        </p>
      ) : null}

      <p className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#4F4137]">{t("voice.final.note")}</p>
    </div>
  );
}

/** What was understood, in the reader's own script and words. */
function DraftReadBack({
  draft,
  t,
  locale
}: {
  readonly draft: ProvisionalContribution;
  readonly t: ReturnType<typeof createTranslator>;
  readonly locale: Locale;
}) {
  const blockingIssues = draft.issues.filter((code) => VOICE_BLOCKING_ISSUE_CODES.has(code));
  const warningIssues = draft.issues.filter((code) => !VOICE_BLOCKING_ISSUE_CODES.has(code));

  const channel = (): string => {
    if (draft.provider === "telebirr") return t("voice.channelTelebirr");
    if (draft.provider === "cbe") return t("voice.channelCbe");
    if (draft.provider === "awash") return t("voice.channelAwash");
    if (draft.rail === "cash") return t("voice.channelCash");
    if (draft.rail === "bank") return t("voice.channelBankUnnamed");
    return t("voice.channelNone");
  };

  // Amharic readers see the month in Ge'ez and the amount in birr; English stays Latin.
  const month = monthLabelForLocale(draft.month, locale === "am" ? "am" : "en") ?? t("voice.fieldMonthMissing");
  const amount =
    draft.amount === null
      ? t("voice.fieldAmountMissing")
      : `${draft.amount.toLocaleString("en-US")} ${draft.currency === "ETB" ? t("voice.currencyEtb") : draft.currency}`;

  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["month", t("voice.fieldMonth"), month],
    ["amount", t("voice.fieldAmount"), amount],
    ["channel", t("voice.fieldChannel"), channel()],
    ["txref", t("voice.fieldTxRef"), draft.txRef ?? t("voice.fieldTxRefMissing")]
  ];

  const issues = [
    ...blockingIssues.map((code) => ({ code, blocking: true })),
    ...warningIssues.map((code) => ({ code, blocking: false }))
  ];

  return (
    <section aria-label={t("voice.draft.heading")} className="rounded-2xl border-2 border-[#C89736] bg-[#FFF9EC] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-ethiopic text-[20px] font-bold text-[#2A1D17]">{t("voice.draft.heading")}</h3>
        <span className="rounded-full bg-[#E8D9BE] px-3 py-1 font-ethiopic text-[16px] font-bold text-[#5B4326]">
          {t("voice.provisionalBadge")}
        </span>
      </div>
      <dl className="mt-3 divide-y divide-[#E6D7B8]">
        {rows.map(([id, label, value]) => (
          <div key={id} className="flex items-baseline justify-between gap-4 py-2">
            <dt className="font-ethiopic text-[18px] text-[#4F4137]">{label}</dt>
            <dd
              data-testid={id === "amount" ? "extraction-amount" : undefined}
              className="text-right font-ethiopic text-[22px] font-bold text-[#2A1D17]"
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {issues.map(({ code, blocking }) => (
        <p
          key={code}
          className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2 font-ethiopic text-[18px] leading-[1.55] ${
            blocking ? "bg-[#FBE3DA] text-[#7A2410]" : "bg-[#F6EBD2] text-[#5B4326]"
          }`}
        >
          {blocking ? (
            <AlertTriangle className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
          ) : (
            <Info className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
          )}
          <span>{t(ISSUE_KEYS[code])}</span>
        </p>
      ))}
    </section>
  );
}
