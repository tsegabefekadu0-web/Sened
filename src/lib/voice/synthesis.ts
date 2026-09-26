"use client";

import { DEFAULT_TTS_SPEED, TTS_SPEEDS, type TtsSpeed } from "./tts";
import type { VoiceLanguage } from "./types";

/**
 * `speechSynthesis` playback with **real** play, pause and speed control
 * (ROADMAP §3.2 requires all three; the previous `AudioDigestModal` had none
 * of them and a waveform computed from `Math.sin`).
 *
 * Two honesty rules:
 *
 * 1. Progress comes from the `boundary`/`end` events of the real utterance,
 *    not from a timer that assumes a duration. A slow phone reading Amharic at
 *    0.75× does not take the same time as a laptop at 2×, and a fake progress
 *    bar would say otherwise.
 * 2. If the browser has no voice for the language, `canSpeak()` is `false` and
 *    the caller must show the text and say why there is no audio. It does not
 *    substitute a beep, a progress animation, or a timer.
 */

export type PlaybackStatus = "idle" | "speaking" | "paused" | "finished" | "unsupported" | "failed";

export interface SpeechPlaybackCallbacks {
  readonly onStatus?: (status: PlaybackStatus) => void;
  /** 0–1 through the utterance. Coarse — `speechSynthesis` exposes no clock. */
  readonly onProgress?: (progress: number) => void;
  /** A word boundary was reached; pass the character index for a caret. */
  readonly onBoundary?: (charIndex: number) => void;
  readonly onError?: (message: string) => void;
}

const LANG_PREFIX: Readonly<Record<VoiceLanguage, string>> = { am: "am", om: "om" };

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

/** The best available voice for a language, or `null` if none is installed. */
export function findVoice(language: VoiceLanguage): SpeechSynthesisVoice | null {
  if (!isSpeechSynthesisSupported()) {
    return null;
  }
  const prefix = LANG_PREFIX[language];
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(`${prefix}-`)) ??
    null
  );
}

export function canSpeak(language: VoiceLanguage): boolean {
  return isSpeechSynthesisSupported() && findVoice(language) !== null;
}

export interface SpeechPlayer {
  play(text: string, language: VoiceLanguage, speed?: TtsSpeed): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setSpeed(speed: TtsSpeed): void;
  readonly status: PlaybackStatus;
  readonly speed: TtsSpeed;
  /** The text currently loaded, for the caption panel. */
  readonly text: string;
}

/**
 * A single-utterance player. Creating a second one cancels the first —
 * `speechSynthesis` is a global singleton, and two voices talking over each
 * other in a treasurer's ear is worse than none.
 */
export function createSpeechPlayer(callbacks: SpeechPlaybackCallbacks = {}): SpeechPlayer {
  let status: PlaybackStatus = "idle";
  let speed: TtsSpeed = DEFAULT_TTS_SPEED;
  let text = "";
  let language: VoiceLanguage = "am";
  let utterance: SpeechSynthesisUtterance | null = null;
  let boundaryCount = 0;

  const setStatus = (next: PlaybackStatus): void => {
    if (status !== next) {
      status = next;
      callbacks.onStatus?.(next);
    }
  };

  const stop = (): void => {
    if (!isSpeechSynthesisSupported()) {
      return;
    }
    window.speechSynthesis.cancel();
    utterance = null;
    boundaryCount = 0;
    setStatus("idle");
  };

  return {
    play(nextText, requestedLanguage, requested) {
      if (!isSpeechSynthesisSupported()) {
        setStatus("unsupported");
        callbacks.onError?.("This browser has no speech engine.");
        return;
      }
      const trimmed = nextText.trim();
      if (trimmed.length === 0) {
        return;
      }
      const voice = findVoice(language);
      if (voice === null) {
        // No voice pack: the caption stays on screen, the audio stays absent.
        text = trimmed;
        setStatus("unsupported");
        callbacks.onError?.(
          "No installed voice speaks this language. The report is shown as text only."
        );
        return;
      }

      stop();
      text = trimmed;
      language = requestedLanguage;
      speed = requested ?? speed;
      boundaryCount = 0;

      const next = new SpeechSynthesisUtterance(trimmed);
      next.voice = voice;
      next.lang = voice.lang;
      next.rate = speed;
      next.pitch = 1;
      next.onboundary = (event: SpeechSynthesisEvent) => {
        boundaryCount += 1;
        callbacks.onBoundary?.(event.charIndex);
        // `boundary` is per-utterance, so this is a word counter in disguise.
        const words = Math.max(1, trimmed.split(/\s+/).length);
        callbacks.onProgress?.(Math.min(1, boundaryCount / words));
      };
      next.onend = () => {
        utterance = null;
        callbacks.onProgress?.(1);
        setStatus("finished");
      };
      next.onerror = (event: SpeechSynthesisErrorEvent) => {
        utterance = null;
        setStatus("failed");
        callbacks.onError?.(event.error ?? "Playback failed");
      };

      utterance = next;
      setStatus("speaking");
      window.speechSynthesis.speak(next);
    },
    pause() {
      if (!isSpeechSynthesisSupported() || status !== "speaking") {
        return;
      }
      window.speechSynthesis.pause();
      setStatus("paused");
    },
    resume() {
      if (!isSpeechSynthesisSupported() || status !== "paused") {
        return;
      }
      window.speechSynthesis.resume();
      setStatus("speaking");
    },
    stop,
    setSpeed(next) {
      speed = next;
      if (utterance !== null) {
        // `rate` is latched at speak time in several engines, so the only
        // reliable way to change speed mid-utterance is to re-speak.
        const restart = utterance.text;
        stop();
        this.play(restart, language, next);
      }
    },
    get status() {
      return status;
    },
    get speed() {
      return speed;
    },
    get text() {
      return text;
    }
  };
}

export { TTS_SPEEDS };
export type { TtsSpeed };
