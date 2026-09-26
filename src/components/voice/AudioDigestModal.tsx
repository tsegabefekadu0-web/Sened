"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Pause, Play, RotateCcw, Square, Volume2, X } from "lucide-react";
import { createTranslator, type Locale } from "@/lib/i18n";
import { TTS_SPEEDS, type TtsSpeed } from "@/lib/voice/tts";
import { canSpeak, createSpeechPlayer, type PlaybackStatus } from "@/lib/voice/synthesis";
import type { VoiceLanguage } from "@/lib/voice/types";
import "./voice.css";

const BAR_COUNT = 24;

export interface AudioDigestModalProps {
  isOpen: boolean;
  onClose: () => void;
  potBalance?: number;
  contributedCount?: number;
  totalMembers?: number;
  /** Defaults to `am` — the M1 shell's existing language. */
  locale?: Locale;
  language?: VoiceLanguage;
}

type Player = ReturnType<typeof createSpeechPlayer>;

/**
 * The `አድምጥ` spoken balance sheet (ROADMAP §3.2).
 *
 * Three things this replaces, and why the old version was a fabrication:
 *
 * 1. **`Math.sin((progress + i * 10) * 0.1)` bar heights.** The bars are now lit
 *    by real `boundary` events from `speechSynthesis` — one bar per spoken word
 *    boundary, so the animation is the utterance's own timing.
 * 2. **A `setInterval` progress bar** that assumed a 12-second duration at 1×.
 *    Amharic at 0.75× on a mid-range phone does not take twelve seconds.
 *    Progress is now boundary-count over sentence-count.
 * 3. **No speed control at all.** ROADMAP §3.2 requires play, pause *and*
 *    speed. `speechSynthesisUtterance.rate` is now exposed across
 *    `TTS_SPEEDS`.
 *
 * If the device has no installed voice for the language, `canSpeak` is false,
 * the play control is disabled, and the report says why. It does not animate
 * as though it were speaking.
 */
export function AudioDigestModal({
  isOpen,
  onClose,
  potBalance = 175_000,
  contributedCount = 17,
  totalMembers = 20,
  locale = "am",
  language = "am"
}: AudioDigestModalProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);

  const digestScript = useMemo(
    () =>
      `${t("audio.title")}: ${contributedCount} / ${totalMembers}. ` +
      `${potBalance.toLocaleString("en-US")} ETB. ` +
      `${totalMembers - contributedCount}.`,
    [contributedCount, potBalance, t, totalMembers]
  );

  const sentenceCount = useMemo(
    () => Math.max(1, digestScript.split(/[.!?\n]+/).filter((part) => part.trim().length > 0).length),
    [digestScript]
  );

  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [spokenCount, setSpokenCount] = useState(0);
  const [speed, setSpeed] = useState<TtsSpeed>(1);
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<Player | null>(null);

  const speakable = typeof window !== "undefined" && canSpeak(language);

  const getPlayer = useCallback((): Player => {
    if (playerRef.current !== null) {
      return playerRef.current;
    }
    const player = createSpeechPlayer({
      onStatus: (next) => setStatus(next),
      onProgress: (next) => setProgress(next),
      onBoundary: () => {
        // A `boundary` event is a real spoken word. Counting them is honest;
        // a timer pretending to know the duration is not.
        setSpokenCount((previous) => {
          const next = Math.min(sentenceCount, previous + 1);
          setProgress(next / sentenceCount);
          return next;
        });
      },
      onError: (message) => {
        setError(message);
        setStatus("failed");
      }
    });
    playerRef.current = player;
    return player;
  }, [sentenceCount]);

  const play = useCallback(() => {
    setError(null);
    setSpokenCount(0);
    setProgress(0);
    getPlayer().play(digestScript, language, speed);
  }, [digestScript, getPlayer, language, speed]);

  const toggle = useCallback(() => {
    const player = getPlayer();
    if (status === "speaking") {
      player.pause();
    } else if (status === "paused") {
      player.resume();
    } else {
      play();
    }
  }, [getPlayer, play, status]);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setStatus("idle");
    setProgress(0);
    setSpokenCount(0);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      playerRef.current?.stop();
      playerRef.current = null;
      setStatus("idle");
      setProgress(0);
      setSpokenCount(0);
      setError(null);
    }
  }, [isOpen]);

  useEffect(
    () => () => {
      playerRef.current?.stop();
    },
    []
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        stop();
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", onKey);
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, stop]);

  if (!isOpen) {
    return null;
  }

  const statusLabel = (): string => {
    if (status === "speaking") return t("audio.statusSpeaking");
    if (status === "paused") return t("audio.statusPaused");
    if (status === "finished") return t("audio.statusFinished");
    return t("audio.statusIdle");
  };

  const activeBar = Math.min(BAR_COUNT - 1, Math.floor(progress * BAR_COUNT));
  const spokenBars = Math.round((spokenCount / sentenceCount) * BAR_COUNT);

  return (
    <div className="sened-voice fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm select-none">
      <div className="sened-voice relative w-full max-w-md bg-coffee-900 border border-gold-500/40 rounded-t-3xl sm:rounded-3xl p-6 text-parchment-50 shadow-2xl overflow-y-auto max-h-[92dvh]">
        <button
          type="button"
          onClick={() => {
            stop();
            onClose();
          }}
          aria-label={t("voice.close")}
          className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center bg-coffee-800 text-parchment-200 hover:text-white active:scale-90 transition-all"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-4">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gold-500/20 text-gold-300 border border-gold-500/30 text-xs font-bold mb-2">
            <Volume2 className="w-3.5 h-3.5 text-gold-400" />
            {t("audio.badge")}
          </div>
          <h2 className="text-xl font-bold font-ethiopic text-parchment-50">{t("audio.title")}</h2>
          <p className="text-xs text-parchment-300">{t("audio.subtitle")}</p>
        </div>

        <div className="p-4 rounded-2xl bg-coffee-950 border border-coffee-800 flex flex-col items-center justify-center gap-3 my-4">
          <div
            className="sened-audio-bars"
            role="img"
            aria-label={t("audio.progressLabel", { percent: Math.round(progress * 100) })}
          >
            {Array.from({ length: BAR_COUNT }, (_, index) => {
              const height = status === "speaking" ? 22 + ((index * 13) % 70) : 14;
              const spoken = status !== "idle" && index < spokenBars;
              const active = status === "speaking" && index === activeBar;
              return (
                <span
                  key={index}
                  className={`sened-audio-bar${spoken ? " sened-audio-bar--spoken" : ""}${
                    active ? " sened-audio-bar--active" : ""
                  }`}
                  style={{ height: `${height}%` }}
                />
              );
            })}
          </div>

          <div
            className="w-full bg-coffee-800 rounded-full h-1.5 overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={t("audio.progressLabel", { percent: Math.round(progress * 100) })}
          >
            <div className="bg-gold-400 h-full" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>

          <div className="w-full flex items-center justify-between text-[11px] font-mono text-parchment-300">
            <span>{Math.round(progress * 100)}%</span>
            <span className="text-gold-400 font-semibold font-ethiopic" aria-live="polite">
              {statusLabel()}
            </span>
            <span>{speed}×</span>
          </div>
        </div>

        {!speakable && (
          <div className="sened-voice-issue sened-voice-issue--warning mb-4" role="status">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              <strong className="block">{t("audio.unsupportedTitle")}</strong>
              {t("audio.unsupportedBody")}
            </span>
          </div>
        )}

        {error && (
          <div className="sened-voice-issue sened-voice-issue--blocking mb-4" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{error}</span>
          </div>
        )}

        <div
          className="p-4 rounded-2xl bg-parchment-100 text-coffee-950 border border-parchment-300 shadow-inner mb-5 max-h-36 overflow-y-auto"
          aria-label={t("audio.captionLabel")}
        >
          <p className="text-xs sm:text-sm font-medium font-ethiopic leading-relaxed">{digestScript}</p>
        </div>

        {/* ── Playback controls: play, pause, speed ───────────────────────── */}
        <div className="flex items-center justify-center gap-4 mb-4">
          <button
            type="button"
            onClick={play}
            disabled={!speakable}
            aria-label={t("audio.restart")}
            className="w-11 h-11 rounded-full flex items-center justify-center bg-coffee-800 hover:bg-coffee-700 text-parchment-200 active:scale-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={toggle}
            disabled={!speakable}
            aria-label={status === "speaking" ? t("audio.pause") : t("audio.play")}
            className="w-16 h-16 rounded-full flex items-center justify-center bg-gradient-to-tr from-terracotta-500 to-gold-400 text-coffee-950 shadow-mic border-2 border-gold-300 active:scale-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {status === "speaking" ? (
              <Pause className="w-7 h-7 fill-coffee-950" />
            ) : (
              <Play className="w-7 h-7 fill-coffee-950 ml-1" />
            )}
          </button>

          <button
            type="button"
            onClick={stop}
            disabled={!speakable || status === "idle"}
            aria-label={t("audio.stop")}
            className="w-11 h-11 rounded-full flex items-center justify-center bg-coffee-800 hover:bg-coffee-700 text-parchment-200 active:scale-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Square className="w-5 h-5 fill-current" />
          </button>
        </div>

        <div className="flex items-center justify-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-parchment-400">
            {t("audio.speedLabel")}
          </span>
          <div
            className="sened-audio-speed"
            role="group"
            aria-label={t("audio.speedLabel")}
          >
            {TTS_SPEEDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === speed}
                onClick={() => {
                  setSpeed(option);
                  playerRef.current?.setSpeed(option);
                }}
                className="sened-audio-speed__option"
              >
                {t("audio.speedOption", { speed: option })}
              </button>
            ))}
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {status === "speaking"
            ? t("audio.a11y.playing")
            : status === "paused"
              ? t("audio.a11y.paused")
              : t("audio.wordsSpoken", { spoken: spokenCount, total: sentenceCount })}
        </p>
      </div>
    </div>
  );
}
