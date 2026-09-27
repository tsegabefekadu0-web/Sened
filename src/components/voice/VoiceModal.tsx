"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Mic,
  RefreshCw,
  ShieldAlert,
  Square,
  Type,
  X
} from "lucide-react";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { VoiceRecorder, isRecordingSupported, type RecorderStatus } from "@/lib/voice/recorder";
import { isSpeechRecognitionSupported } from "@/lib/voice/recognition";
import {
  VOICE_BLOCKING_ISSUE_CODES,
  type ProvisionalContribution,
  type VoiceIssueCode,
  type VoiceLanguage
} from "@/lib/voice/types";
import "./voice.css";

const BAR_COUNT = 32;
const TICK_MS = 100;

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

export interface BankVerificationOutcome {
  /** Only a real `VERIFIED` state from AGENT-1's route may say `true`. */
  readonly verified: boolean;
  readonly verificationId?: string;
}

export interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Hands a sound draft to AGENT-1's `/api/bank-verifications`. Supplied at
   * integration. While absent, the submit control is disabled and says why —
   * a dead fetch would be a fake, and a local success would be a lie.
   *
   * There is deliberately no "add this to the treasury" callback any more. The
   * one this file used to expose was wired in `page.tsx` to
   * `telebirrVerified: newEntry.channel === "Telebirr"`, which turned a spoken
   * sentence into a bank confirmation — §12.3. Nothing may reach the ledger
   * from speech; only a real `VERIFIED` result may, and that arrives through
   * the verifier's response, not through a second, unchecked door.
   */
  onRequestVerification?: (draft: ProvisionalContribution) => Promise<BankVerificationOutcome>;
  /** Defaults to `am` so the M1 shell's existing Amharic copy is unchanged. */
  locale?: Locale;
  language?: VoiceLanguage;
}

type Stage =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "transcribing"
  | "unavailable"
  | "review";

export function VoiceModal({
  isOpen,
  onClose,
  onRequestVerification,
  locale = "am",
  language = "am"
}: VoiceModalProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  const [stage, setStage] = useState<Stage>("idle");
  const [bars, setBars] = useState<number[]>(() => new Array<number>(BAR_COUNT).fill(0));
  const [level, setLevel] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interim, setInterim] = useState("");
  const [transcript, setTranscript] = useState("");
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<"voice" | "type">("voice");
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const recorderRef = useRef<VoiceRecorder | null>(null);

  const support = typeof window !== "undefined" ? isRecordingSupported() : false;
  const nativeRecognition = typeof window !== "undefined" ? isSpeechRecognitionSupported() : false;

  const effectiveTranscript = mode === "type" ? typed : transcript;
  const draft = useMemo(
    () => (effectiveTranscript.trim().length > 0 ? parseContributionUtterance(effectiveTranscript) : null),
    [effectiveTranscript]
  );

  const reset = useCallback(() => {
    setStage("idle");
    setBars(new Array<number>(BAR_COUNT).fill(0));
    setLevel(0);
    setElapsedSeconds(0);
    setInterim("");
    setTranscript("");
    setTyped("");
    setRecorderError(null);
    setTranscribeError(null);
    setSubmitError(null);
    setSubmitting(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      reset();
      setMode("voice");
    } else {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    }
  }, [isOpen, reset]);

  // Elapsed clock, driven off the recorder's real start time.
  useEffect(() => {
    if (stage !== "recording") {
      return;
    }
    const handle = setInterval(() => {
      setElapsedSeconds(Math.floor((recorderRef.current?.elapsedMs ?? 0) / 1000));
    }, TICK_MS);
    return () => clearInterval(handle);
  }, [stage]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        recorderRef.current?.cancel();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const startRecording = useCallback(async () => {
    if (recorderRef.current) {
      recorderRef.current.cancel();
    }
    const recorder = new VoiceRecorder({
      barCount: BAR_COUNT,
      onBars: (next) => setBars([...next]),
      onLevel: (next) => setLevel(next),
      onStatus: (status: RecorderStatus) => {
        if (status === "requesting_permission") {
          setStage("requesting");
        }
      },
      onError: (error) => setRecorderError(error.message)
    });
    recorderRef.current = recorder;
    setRecorderError(null);
    setInterim("");
    setStage("requesting");
    try {
      await recorder.start();
      setStage("recording");
    } catch {
      setStage(recorder.status === "permission_denied" ? "unavailable" : "unavailable");
    }
  }, []);

  /**
   * Stop, then run the real pipeline: assess the capture, POST the audio to
   * `/api/voice/transcribe`, and feed the returned transcript to the parser.
   *
   * If transcription is unconfigured, the audio is **not** thrown away and no
   * transcript is invented — the user is told and the type-in path is offered.
   */
  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
    setStage("stopping");
    const result = await recorder.stop();
    recorderRef.current = null;
    setLevel(0);

    if (result === null) {
      setStage("unavailable");
      return;
    }
    if (!result.quality.usable) {
      setRecorderError(
        result.quality.reason === "silent"
          ? t("voice.captureSilent")
          : result.quality.reason === "too_short"
            ? t("voice.captureTooShort")
            : t("voice.captureTooLong")
      );
      setStage("unavailable");
      return;
    }

    setStage("transcribing");
    setTranscribeError(null);
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        language,
        durationMs: result.durationMs
      })
    });

    if (!response.ok) {
      // 503 not_configured is the expected answer here. Say so plainly.
      setTranscribeError(t("voice.transcribeFailedBody"));
      setStage("review");
      setMode("type");
      setMode("type");
      return;
    }
    const payload = (await response.json()) as { transcript?: string };
    const text = typeof payload.transcript === "string" ? payload.transcript : "";
    if (text.trim().length === 0) {
      setTranscribeError(t("voice.transcribeFailedBody"));
      setStage("review");
      setMode("type");
      setMode("type");
      return;
    }
    setTranscript(text);
    setStage("review");
  }, [language, t]);

  const submitForVerification = useCallback(async () => {
    if (!draft || !onRequestVerification) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await onRequestVerification(draft);
      if (!outcome.verified) {
        setSubmitError(t("voice.submitUnverifiedReason"));
        return;
      }
      // A genuine bank VERIFIED. The result — not the transcript — is what the
      // caller acts on, and it carries its own verificationId and provenance.
      // Nothing is written locally on the strength of what was said.
      onClose();
    } catch {
      setSubmitError(t("voice.submitUnverifiedReason"));
    } finally {
      setSubmitting(false);
    }
  }, [draft, onClose, onRequestVerification, t]);

  if (!isOpen) {
    return null;
  }

  const recording = stage === "recording";
  const busy = stage === "requesting" || stage === "stopping" || stage === "transcribing";
  const clipping = level > 0.97;
  const hasTypedText = typed.trim().length > 0;

  return (
    <div className="sened-voice fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm select-none">
      <div
        className={`sened-voice relative w-full max-w-md bg-coffee-900 border rounded-t-3xl sm:rounded-3xl p-6 text-parchment-50 shadow-2xl overflow-y-auto max-h-[92dvh] ${
          recording ? "sened-voice--recording border-terracotta-500/60" : "border-coffee-700/80"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sened-voice-title"
      >
        <button
          type="button"
          onClick={() => {
            recorderRef.current?.cancel();
            onClose();
          }}
          aria-label={t("voice.close")}
          className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center bg-coffee-800 text-parchment-200 hover:text-white active:scale-90 transition-all"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-5">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-terracotta-500/20 text-terracotta-400 border border-terracotta-500/30 text-xs font-bold mb-2">
            <Mic className="w-3.5 h-3.5" />
            {t("voice.badge")}
          </div>
          <h2 id="sened-voice-title" className="text-xl font-bold font-ethiopic text-parchment-50">
            {t("voice.title")}
          </h2>
          <p className="text-xs text-parchment-300 mt-0.5">{t("voice.subtitle")}</p>
        </div>

        {/* ── Real microphone: AnalyserNode bars, not CSS ping ─────────────── */}
        <div className="flex flex-col items-center justify-center py-5">
          <div className="relative flex items-center justify-center">
            {recording && (
              <>
                <span className="sened-voice-pulse" />
                <span className="sened-voice-pulse" />
                <span className="sened-voice-pulse" />
              </>
            )}
            <div
              className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center shadow-mic border-4 ${
                recording
                  ? "bg-terracotta-500 border-gold-400 text-white"
                  : busy
                    ? "bg-coffee-800 border-coffee-700 text-gold-400"
                    : "bg-coffee-800 border-coffee-700 text-gold-400"
              }`}
            >
              {busy ? <Loader2 className="w-9 h-9 animate-spin" /> : recording ? <Square className="w-7 h-7 fill-white" /> : <Mic className="w-9 h-9" />}
            </div>
          </div>

          <p className="text-xs font-semibold text-gold-400 mt-4 font-ethiopic" aria-live="polite">
            {stage === "requesting" && t("voice.permissionRequest")}
            {stage === "recording" && t("voice.recordingElapsed", { seconds: elapsedSeconds })}
            {stage === "stopping" && t("voice.transcribing")}
            {stage === "transcribing" && t("voice.transcribing")}
            {stage === "idle" && (support ? t("voice.page.tapToRecord") : t("voice.unsupportedTitle"))}
            {stage === "unavailable" && (recorderError ?? t("voice.unsupportedBody"))}
            {stage === "review" && null}
          </p>

          <div
            className={`sened-voice-waveform mt-4 ${recording ? "sened-voice-waveform--live" : "sened-voice-waveform--idle"} ${
              clipping ? "sened-voice-waveform--clipping" : ""
            }`}
            role="img"
            aria-label={t("voice.waveformLabel")}
            aria-live="off"
          >
            {bars.map((value, index) => (
              <span
                key={index}
                className="sened-voice-waveform__bar"
                style={{ height: `${Math.max(3, Math.round(value * 100))}%` }}
              />
            ))}
          </div>

          <div className="sened-voice-meter mt-3" role="img" aria-label={t("voice.a11y.levelPercent", { percent: Math.round(level * 100) })}>
            <span className="sened-voice-meter__fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          {clipping && (
            <p className="text-[10px] text-terracotta-400 mt-1" role="status">
              {t("voice.a11y.clipping")}
            </p>
          )}
        </div>

        {/* ── Controls ────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mb-4">
          {mode === "voice" ? (
            <button
              type="button"
              disabled={busy || !support}
              onClick={() => (recording ? void stopRecording() : void startRecording())}
              className={`flex-1 py-3 rounded-2xl font-bold font-ethiopic flex items-center justify-center gap-2 transition-all ${
                busy || !support
                  ? "bg-coffee-800 text-parchment-400 cursor-not-allowed opacity-60"
                  : recording
                    ? "bg-terracotta-500 text-white active:scale-95"
                    : "bg-gradient-to-r from-terracotta-500 to-gold-500 text-coffee-950 active:scale-95"
              }`}
            >
              {recording ? <Square className="w-4 h-4 fill-current" /> : <Mic className="w-4 h-4" />}
              {recording ? t("voice.stop") : t("voice.record")}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              const next = mode === "voice" ? "type" : "voice";
              setMode(next);
            }}
            className="py-3 px-4 rounded-2xl font-bold text-sm font-ethiopic flex items-center gap-2 bg-coffee-800 text-parchment-200 hover:bg-coffee-700 active:scale-95 transition-all"
          >
            {mode === "voice" ? <Type className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            {mode === "voice" ? t("voice.typeInstead") : t("voice.voiceInstead")}
          </button>
        </div>

        {!support && (
          <p className="sened-voice-issue sened-voice-issue--warning mb-4">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              {nativeRecognition ? t("voice.transcriptInterim") : t("voice.unsupportedBody")}
            </span>
          </p>
        )}

        {recorderError && (
          <p className="sened-voice-issue sened-voice-issue--blocking mb-4" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{recorderError}</span>
          </p>
        )}

        {transcribeError && (
          <p className="sened-voice-issue sened-voice-issue--warning mb-4" role="status">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{transcribeError}</span>
          </p>
        )}

        {/* ── Transcript: live interim, then the final text ───────────────── */}
        {mode === "voice" && (transcript || interim) && (
          <div className="p-3.5 rounded-2xl bg-coffee-950 border border-coffee-800 mb-4">
            <p className="text-[10px] uppercase tracking-wider text-parchment-400 mb-1">
              {t("voice.transcriptLabel")}
            </p>
            <p
              className={`text-sm font-medium font-ethiopic leading-relaxed sened-voice-interim ${
                transcript ? "sened-voice-interim--final" : ""
              }`}
            >
              {transcript || interim}
              {!transcript && recording && <span className="sened-voice-caret" />}
            </p>
          </div>
        )}

        {mode === "type" && (
          <div className="mb-4">
            <label htmlFor="sened-voice-typed" className="text-[10px] uppercase tracking-wider text-parchment-400">
              {t("voice.transcriptLabel")}
            </label>
            <textarea
              id="sened-voice-typed"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              rows={3}
              placeholder={t("voice.transcriptPlaceholder")}
              className="mt-1 w-full rounded-2xl bg-coffee-950 border border-coffee-800 p-3 text-sm font-ethiopic text-parchment-100 placeholder:text-parchment-400/60 focus:border-gold-500/60 focus:outline-none resize-y"
            />
          </div>
        )}

        {/* ── Extraction preview, always labelled PROVISIONAL ──────────────── */}
        {draft && <ExtractionPanel draft={draft} t={t} />}

        {/* ── Hand-off ────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <button
            type="button"
            disabled={!draft || draft.blocking || !onRequestVerification || submitting}
            onClick={() => void submitForVerification()}
            className={`w-full py-3.5 rounded-2xl font-bold font-ethiopic flex items-center justify-center gap-2 transition-all ${
              draft && !draft.blocking && onRequestVerification && !submitting
                ? "bg-gradient-to-r from-terracotta-500 to-gold-500 text-coffee-950 active:scale-95"
                : "bg-coffee-800 text-parchment-400 cursor-not-allowed opacity-60"
            }`}
          >
            {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
            {t("voice.submit")}
          </button>

          {!onRequestVerification && (
            <div className="sened-voice-issue sened-voice-issue--warning">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                <strong className="block">{t("voice.submitUnwiredTitle")}</strong>
                {t("voice.submitUnwiredBody")}
              </span>
            </div>
          )}
          {onRequestVerification && draft?.blocking && (
            <div className="sened-voice-issue sened-voice-issue--blocking">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{t("voice.submitUnverifiedReason")}</span>
            </div>
          )}
          {submitError && (
            <div className="sened-voice-issue sened-voice-issue--blocking" role="alert">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{submitError}</span>
            </div>
          )}

          <p className="text-[10px] text-center text-parchment-400 flex items-start justify-center gap-1">
            <ShieldAlert className="w-3 h-3 text-gold-400 shrink-0 mt-px" />
            {t("voice.provisionalNotice")}
          </p>
        </div>
      </div>
    </div>
  );
}

function ExtractionPanel({
  draft,
  t
}: {
  readonly draft: ProvisionalContribution;
  readonly t: ReturnType<typeof createTranslator>;
}) {
  const blockingIssues = draft.issues.filter((code) => VOICE_BLOCKING_ISSUE_CODES.has(code));
  const warningIssues = draft.issues.filter((code) => !VOICE_BLOCKING_ISSUE_CODES.has(code));

  const channelLabel = (): string => {
    if (draft.provider === "telebirr") return t("voice.channelTelebirr");
    if (draft.provider === "cbe") return t("voice.channelCbe");
    if (draft.provider === "awash") return t("voice.channelAwash");
    if (draft.rail === "cash") return t("voice.channelCash");
    if (draft.rail === "bank") return t("voice.channelBankUnnamed");
    return t("voice.channelNone");
  };

  const languageLabel = (): string => {
    if (draft.language === "am") return t("voice.languageAm");
    if (draft.language === "om") return t("voice.languageOm");
    if (draft.language === "mixed") return t("voice.languageMixed");
    return t("voice.languageUnknown");
  };

  return (
    <div className="p-3.5 rounded-2xl bg-coffee-800/60 border border-gold-500/30 mb-5 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-parchment-400">
          {t("voice.extractedTitle")}
        </span>
        <span className="sened-voice-provisional">
            {t("voice.provisionalBadge")}
        </span>
      </div>

      <div className="flex items-center justify-between text-parchment-300">
        <span>{t("voice.fieldMonth")}</span>
        <strong className="text-parchment-100">{draft.monthLabel ?? t("voice.fieldMonthMissing")}</strong>
      </div>
      <div className="flex items-center justify-between text-parchment-300">
        <span>{t("voice.fieldAmount")}</span>
        <strong className="text-emerald-400 font-sans text-sm font-bold">
          {draft.amount === null ? (
            <span className="text-parchment-400 font-normal">{t("voice.fieldAmountMissing")}</span>
          ) : (
            `${draft.amount.toLocaleString("en-US")} ${draft.currency}`
          )}
        </strong>
      </div>
      <div className="flex items-center justify-between text-parchment-300">
        <span>{t("voice.fieldChannel")}</span>
        <strong className="text-parchment-100">{channelLabel()}</strong>
      </div>
      <div className="flex items-center justify-between text-parchment-300">
        <span>{t("voice.fieldTxRef")}</span>
        <strong className="text-gold-400 font-mono">{draft.txRef ?? t("voice.fieldTxRefMissing")}</strong>
      </div>
      <div className="flex items-center justify-between text-parchment-300">
        <span>{t("voice.fieldLanguage")}</span>
        <strong className="text-parchment-100">{languageLabel()}</strong>
      </div>

      {blockingIssues.length > 0 && (
        <div className="space-y-1.5 pt-2">
          {blockingIssues.map((code) => (
            <p key={code} className="sened-voice-issue sened-voice-issue--blocking">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{t(ISSUE_KEYS[code])}</span>
            </p>
          ))}
        </div>
      )}

      {warningIssues.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {warningIssues.map((code) => (
            <p key={code} className="sened-voice-issue sened-voice-issue--warning">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{t(ISSUE_KEYS[code])}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
