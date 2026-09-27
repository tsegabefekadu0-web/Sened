"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, Mic, ShieldCheck, Square } from "lucide-react";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { toBankVerificationIntent, type IntentOutcome } from "@/lib/voice/intent";
import { VoiceRecorder, isRecordingSupported } from "@/lib/voice/recorder";
import { isSpeechRecognitionSupported } from "@/lib/voice/recognition";
import {
  VOICE_BLOCKING_ISSUE_CODES,
  type ProvisionalContribution,
  type VoiceIssueCode,
  type VoiceLanguage
} from "@/lib/voice/types";
import type { VoiceCapability } from "@/lib/voice/schemas";

const BAR_COUNT = 40;
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

/** Ge'ez text as `\uXXXX` escapes: an editor that cannot round-trip the script
 *  must not be able to change what this page asserts. */
const SAMPLES = [
  {
    labelKey: "voice.page.sampleAmharic" as MessageKey,
    text:
      "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5,000 \u1265\u122d \u1262\u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201\u1363 \u1261\u1325\u1229 9BF42 \u1290\u12cd"
  },
  {
    labelKey: "voice.page.sampleOromo" as MessageKey,
    text: "sanaa equb shan dugum birr tellebirr dabbadee kutaa 9BF42 dha"
  },
  {
    labelKey: "voice.page.sampleNoRef" as MessageKey,
    text: "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1262\u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201"
  },
  {
    labelKey: "voice.page.sampleForeign" as MessageKey,
    text: "\u12a5\u1241\u1265 500 \u12f6\u120b\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1262\u1274\u120c\u1265\u122d \u1261\u1325\u1229 9BF42 \u1290\u12cd"
  },
  {
    labelKey: "voice.page.sampleAmbiguous" as MessageKey,
    text:
      "\u12a5\u1241\u1265 5,000 \u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd \u1295\u12f6\u1275\u1275 500 \u1265\u122d \u12a0\u1235\u1308\u127b\u121d"
  }
];

const BINDING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OCCURRED_AT = "2026-09-26T09:30:00.000Z";
const IDEMPOTENCY_KEY = "voice-workbench-1";

/**
 * Read a browser capability once the component has mounted.
 *
 * `isRecordingSupported()` and `isSpeechRecognitionSupported()` read
 * `navigator`, which does not exist while the server renders. Calling either
 * during render makes the server emit "this browser does not support recording"
 * and the client emit the opposite, which React reports as a hydration mismatch
 * (error #418) and then answers by discarding the server HTML entirely (#423).
 *
 * That is not a warning. The page loses its server-rendered content on every
 * load, and on a Sunday meeting behind a slow connection that is the difference
 * between a shell that paints instantly and one that does not.
 *
 * `false` is the first value on both sides, so the two renders agree. The cost is
 * a single frame in which a capable browser is told it is not; the alternative
 * is a hydration failure every time.
 *
 * `VoiceModal` already did this with an inline `typeof window` guard. The
 * workbench did not, and no test could see it: jsdom has no `navigator.mediaDevices`
 * either, so the server and the test client agreed with each other and both
 * disagreed with Chromium.
 */
function useBrowserCapability(check: () => boolean): boolean {
  const [supported, setSupported] = useState(false);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    setSupported(checkRef.current());
  }, []);
  return supported;
}

/**
 * The `/voice` workbench.
 *
 * Four panels, each proving one claim:
 *
 * 1. **Entity extraction** — the real parser, no credential, same code the
 *    mobile shell runs. Sample buttons are *inputs*, not canned outputs.
 * 2. **Microphone capture** — a real `getUserMedia` stream with a live
 *    `AnalyserNode`. Nothing is uploaded; the audio is discarded on stop.
 * 3. **Speech providers** — `GET /api/voice/capabilities`, reported verbatim.
 *    In this build both are `false`, and the page says so.
 * 4. **Hand-off** — runs `toBankVerificationIntent` for real and shows the
 *    exact body AGENT-1's route would receive, or every reason it is refused.
 *    It performs **no** network write: that is AGENT-1's integration step
 *    (`docs/requests/agent-2.md` R-2).
 */
export function VoiceWorkbench() {
  const [locale, setLocale] = useState<Locale>("en");
  const [language, setLanguage] = useState<VoiceLanguage>("am");
  const t = useMemo(() => createTranslator(locale), [locale]);

  const [text, setText] = useState<string>(SAMPLES[0].text);
  const [capability, setCapability] = useState<VoiceCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const recognitionSupported = useBrowserCapability(isSpeechRecognitionSupported);

  const draft = useMemo(
    () => (text.trim().length > 0 ? parseContributionUtterance(text) : null),
    [text]
  );

  const outcome: IntentOutcome | null = useMemo(() => {
    if (!draft) {
      return null;
    }
    return toBankVerificationIntent({
      draft,
      bankAccountBindingId: BINDING_ID,
      occurredAt: OCCURRED_AT,
      idempotencyKey: IDEMPOTENCY_KEY
    });
  }, [draft]);

  const loadCapabilities = useCallback(async () => {
    setCapabilityError(null);
    try {
      const response = await fetch("/api/voice/capabilities", { cache: "no-store" });
      if (!response.ok) {
        setCapabilityError(`HTTP ${response.status}`);
        return;
      }
      setCapability((await response.json()) as VoiceCapability);
    } catch {
      setCapabilityError("unreachable");
    }
  }, []);

  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  return (
    <main className="sened-voice-page">
      <div className="sened-voice-page__inner">
        <header className="sened-voice-page__header">
          <div>
            <span className="sened-voice-page__eyebrow">
              <Mic size={13} />
              M3 · Zero-trust voice pipeline
            </span>
            <h1 className="sened-voice-page__title">{t("voice.page.heading")}</h1>
            <p className="sened-voice-page__lede">{t("voice.page.description")}</p>
          </div>
          <div className="sened-voice-switch" role="group" aria-label="Language">
            {(["en", "am"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="sened-voice-switch__option"
                aria-pressed={option === locale}
                onClick={() => setLocale(option)}
              >
                {option === "en" ? "English" : "አማርኛ"}
              </button>
            ))}
          </div>
        </header>

        <p className="sened-voice-page__notice">
          <ShieldCheck size={16} className="shrink-0 mt-0.5" />
          <span>{t("voice.page.noFakesNotice")}</span>
        </p>

        <div className="sened-voice-page__grid">
          {/* ── 1. Entity extraction ────────────────────────────────────── */}
          <section className="sened-voice-card">
            <h2 className="sened-voice-card__title">{t("voice.page.parseHeading")}</h2>
            <p className="sened-voice-card__description">{t("voice.page.parseDescription")}</p>

            <div className="sened-voice-field">
              <label className="sened-voice-field__label" htmlFor="voice-sentence">
                {t("voice.transcriptLabel")}
              </label>
              <textarea
                id="voice-sentence"
                className="sened-voice-textarea"
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>

            <div className="sened-voice-samples">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.labelKey}
                  type="button"
                  className="sened-voice-samples__button"
                  onClick={() => setText(sample.text)}
                >
                  {t(sample.labelKey)}
                </button>
              ))}
            </div>

            {draft && <DraftTable draft={draft} t={t} />}
            {draft && <IssueList draft={draft} t={t} />}
          </section>

          {/* ── 2. Microphone capture ───────────────────────────────────── */}
          <RecorderCard language={language} onLanguageChange={setLanguage} t={t} />

          {/* ── 3. Speech providers ─────────────────────────────────────── */}
          <section className="sened-voice-card">
            <h2 className="sened-voice-card__title">{t("voice.page.providersHeading")}</h2>
            <p className="sened-voice-card__description">{t("voice.page.providersDescription")}</p>

            {capabilityError && (
              <p className="sened-voice-issues__item" data-blocking="true">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>/api/voice/capabilities — {capabilityError}</span>
              </p>
            )}

            {capability && (
              <dl className="sened-voice-kv">
                <dt>{t("voice.page.providersStt")}</dt>
                <dd>
                  <span
                    className="sened-voice-status"
                    data-tone={capability.sttConfigured ? "ok" : "off"}
                  >
                    {capability.sttConfigured
                      ? t("voice.page.configured")
                      : t("voice.page.notConfigured")}
                  </span>{" "}
                  <code>{capability.sttProvider}</code>
                </dd>
                <dt>{t("voice.page.providersTts")}</dt>
                <dd>
                  <span
                    className="sened-voice-status"
                    data-tone={capability.ttsConfigured ? "ok" : "off"}
                  >
                    {capability.ttsConfigured
                      ? t("voice.page.configured")
                      : t("voice.page.notConfigured")}
                  </span>{" "}
                  <code>{capability.ttsProvider}</code>
                </dd>
              </dl>
            )}

            <button type="button" className="sened-voice-button" onClick={() => void loadCapabilities()}>
              <Info size={13} className="inline mr-1" />
              {t("voice.retry")}
            </button>

            <p className="sened-voice-card__description">
              {recognitionSupported
                ? "This browser exposes the Web Speech API, so on-device transcription is available with no credential."
                : "This browser does not expose the Web Speech API."}
            </p>
          </section>

          {/* ── 4. Hand-off to bank verification ─────────────────────────── */}
          <section className="sened-voice-card">
            <h2 className="sened-voice-card__title">{t("voice.page.intentHeading")}</h2>
            <p className="sened-voice-card__description">{t("voice.page.intentDescription")}</p>

            {outcome === null && <p className="sened-voice-card__description">—</p>}

            {outcome !== null && !outcome.ok && (
              <>
                <p className="sened-voice-issues__item" data-blocking="true">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>{t("voice.rejectionTitle")}</span>
                </p>
                <ul className="sened-voice-issues">
                  {outcome.rejections.map((rejection) => (
                    <li key={`${rejection.code}-${rejection.field}`} className="sened-voice-issues__item" data-blocking="true">
                      <span>
                        <code>{rejection.code}</code> — {rejection.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {outcome !== null && outcome.ok && (
              <>
                <p className="sened-voice-issues__item" data-blocking="false">
                  <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                  <span>
                    <code>status</code> = {draft?.status} · <code>verified</code> = {String(draft?.verified)}
                  </span>
                </p>
                <pre className="sened-voice-pre">{JSON.stringify(outcome.body, null, 2)}</pre>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function DraftTable({
  draft,
  t
}: {
  readonly draft: ProvisionalContribution;
  readonly t: ReturnType<typeof createTranslator>;
}) {
  const languageLabel =
    draft.language === "am"
      ? t("voice.languageAm")
      : draft.language === "om"
        ? t("voice.languageOm")
        : draft.language === "mixed"
          ? t("voice.languageMixed")
          : t("voice.languageUnknown");

  const channelLabel = (() => {
    if (draft.provider === "telebirr") return t("voice.channelTelebirr");
    if (draft.provider === "cbe") return t("voice.channelCbe");
    if (draft.provider === "awash") return t("voice.channelAwash");
    if (draft.rail === "cash") return t("voice.channelCash");
    if (draft.rail === "bank") return t("voice.channelBankUnnamed");
    return t("voice.channelNone");
  })();

  const rows: readonly (readonly [string, string, boolean])[] = [
    ["status", draft.status, false],
    ["verified", String(draft.verified), false],
    [
      t("voice.fieldAmount"),
      draft.amount === null ? "—" : `${draft.amount.toLocaleString("en-US")} ${draft.currency} (${draft.amountWire ?? "—"})`,
      draft.amount === null
    ],
    [t("voice.fieldMonth"), draft.monthLabel ?? "—", draft.month === null],
    [t("voice.fieldChannel"), channelLabel, draft.provider === null],
    [t("voice.fieldTxRef"), draft.txRef ?? "—", draft.txRef === null],
    [t("voice.fieldLanguage"), languageLabel, false]
  ];

  return (
    <dl className="sened-voice-kv">
      {rows.map(([label, value, empty]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd data-empty={empty}>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function IssueList({
  draft,
  t
}: {
  readonly draft: ProvisionalContribution;
  readonly t: ReturnType<typeof createTranslator>;
}) {
  if (draft.issues.length === 0) {
    return (
      <p className="sened-voice-issues__item" data-blocking="false">
        <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
        <span>
          <code>issues</code> = []
        </span>
      </p>
    );
  }
  return (
    <ul className="sened-voice-issues">
      {draft.issues.map((code) => {
        const blocking = VOICE_BLOCKING_ISSUE_CODES.has(code);
        return (
          <li key={code} className="sened-voice-issues__item" data-blocking={blocking}>
            {blocking ? (
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            ) : (
              <Info size={14} className="shrink-0 mt-0.5" />
            )}
            <span>
              <code>{code}</code> — {t(ISSUE_KEYS[code])}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RecorderCard({
  language,
  onLanguageChange,
  t
}: {
  readonly language: VoiceLanguage;
  readonly onLanguageChange: (next: VoiceLanguage) => void;
  readonly t: ReturnType<typeof createTranslator>;
}) {
  const [bars, setBars] = useState<number[]>(() => new Array<number>(BAR_COUNT).fill(0));
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<"idle" | "recording" | "busy" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);

  const supported = useBrowserCapability(isRecordingSupported);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
    },
    []
  );

  const start = async (): Promise<void> => {
    recorderRef.current?.cancel();
    const recorder = new VoiceRecorder({
      barCount: BAR_COUNT,
      onBars: (next) => setBars([...next]),
      onLevel: (next) => setLevel(next),
      onError: (error) => {
        setMessage(error.message);
        setStatus("error");
      }
    });
    recorderRef.current = recorder;
    setMessage(null);
    setStatus("busy");
    try {
      await recorder.start();
      setStatus("recording");
    } catch {
      setStatus("error");
    }
  };

  const stop = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
    setStatus("busy");
    const result = await recorder.stop();
    recorderRef.current = null;
    setLevel(0);
    if (result === null) {
      setMessage("no audio was produced");
      setStatus("error");
      return;
    }
    setMessage(
      `${result.mimeType} · ${(result.durationMs / 1000).toFixed(1)}s · ` +
        `${(result.audioBase64.length / 1024).toFixed(0)} KiB base64 · usable=${result.quality.usable} ` +
        `(${(result.quality.peakDbfs === Number.NEGATIVE_INFINITY ? "-inf" : result.quality.peakDbfs.toFixed(1))} dBFS)`
    );
    setStatus("idle");
  };

  return (
    <section className="sened-voice-card">
      <h2 className="sened-voice-card__title">{t("voice.page.recordHeading")}</h2>
      <p className="sened-voice-card__description">{t("voice.page.recordDescription")}</p>

      <div className="sened-voice-samples" role="group" aria-label="Language">
        {(["am", "om"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="sened-voice-samples__button"
            aria-pressed={option === language}
            onClick={() => onLanguageChange(option)}
          >
            {option === "am" ? t("voice.languageAm") : t("voice.languageOm")}
          </button>
        ))}
      </div>

      <div
        className={`sened-voice-waveform ${status === "recording" ? "" : "sened-voice-waveform--idle"}`}
        role="img"
        aria-label={t("voice.waveformLabel")}
      >
        {bars.map((value, index) => (
          <span
            key={index}
            className="sened-voice-waveform__bar"
            style={{ height: `${Math.max(3, Math.round(value * 100))}%` }}
          />
        ))}
      </div>

      <div className="sened-voice-meters">
        <span>{t("voice.a11y.levelPercent", { percent: Math.round(level * 100) })}</span>
        <div
          className="sened-voice-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          aria-label={t("voice.a11y.levelPercent", { percent: Math.round(level * 100) })}
        >
          <span className="sened-voice-meter__fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
      </div>

      <div className="sened-voice-samples">
        <button
          type="button"
          className="sened-voice-button sened-voice-button--primary"
          disabled={!supported || status === "recording" || status === "busy"}
          onClick={() => void start()}
        >
          {status === "busy" ? <Loader2 size={14} className="inline mr-1 animate-spin" /> : <Mic size={14} className="inline mr-1" />}
          {t("voice.record")}
        </button>
        <button
          type="button"
          className="sened-voice-button sened-voice-button--danger"
          disabled={status !== "recording"}
          onClick={() => void stop()}
        >
          <Square size={13} className="inline mr-1 fill-current" />
          {t("voice.stop")}
        </button>
      </div>

      {!supported && (
        <p className="sened-voice-issues__item" data-blocking="true">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{t("voice.unsupportedBody")}</span>
        </p>
      )}

      {message && (
        <p className="sened-voice-issues__item" data-blocking={status === "error"}>
          {status === "error" ? (
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          ) : (
            <Info size={14} className="shrink-0 mt-0.5" />
          )}
          <span>{message}</span>
        </p>
      )}
    </section>
  );
}
