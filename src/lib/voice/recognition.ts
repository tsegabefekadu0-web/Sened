"use client";

import type { VoiceLanguage } from "./types";

/**
 * Browser-native speech recognition (`SpeechRecognition` / `webkitSpeechRecognition`).
 *
 * This is a **real** transcription path, not a mock: on a phone with Chrome it
 * transcribes on-device with no credential at all. That is why it is
 * preferred over the Addis AI server route when the browser offers it.
 *
 * Where it is *not* available, `isSpeechRecognitionSupported()` returns
 * `false` and the caller shows an honest "not supported in this browser"
 * state. It never falls back to a fabricated transcript.
 *
 * Amharic (`am-ET`) support in the Web Speech API is browser-dependent; Oromo
 * has no shipped BCP-47 tag in any major engine yet, so `om` is offered with
 * an honest caveat rather than pretending to be well supported.
 */

export const RECOGNITION_LOCALE_TAGS: Readonly<Record<VoiceLanguage, string>> = {
  am: "am-ET",
  om: "om-ET"
};

export type RecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly length: number;
    readonly [index: number]: { readonly transcript: string; readonly confidence: number };
  }>;
};

export type RecognitionErrorEventLike = { readonly error: string; readonly message?: string };

interface SpeechRecognitionCtorLike {
  new (): SpeechRecognitionLike;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

function getCtor(): SpeechRecognitionCtorLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtorLike;
    webkitSpeechRecognition?: SpeechRecognitionCtorLike;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

export interface BrowserRecognizerCallbacks {
  /** Interim text, for live captions. Fires continuously. */
  readonly onInterim?: (text: string) => void;
  /** Final text for the current utterance. */
  readonly onFinal?: (text: string, confidence: number | null) => void;
  readonly onError?: (error: string) => void;
  readonly onEnd?: () => void;
}

export interface BrowserRecognizer {
  start(): void;
  stop(): void;
  abort(): void;
  readonly listening: boolean;
}

/**
 * Wrap `SpeechRecognition` in a promise-free, abortable object.
 *
 * `stop()` ends the session and flushes the final result; `abort()` discards
 * it. Both are needed: a treasurer who says "no, wrong month" must be able to
 * throw the utterance away.
 */
export function createBrowserRecognizer(
  language: VoiceLanguage,
  callbacks: BrowserRecognizerCallbacks = {}
): BrowserRecognizer {
  const Ctor = getCtor();
  if (Ctor === null) {
    throw new Error("Speech recognition is not available in this browser");
  }

  const recognition = new Ctor();
  recognition.lang = RECOGNITION_LOCALE_TAGS[language];
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let listening = false;

  recognition.onstart = () => {
    listening = true;
  };

  recognition.onresult = (event: RecognitionEventLike) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result?.[0];
      if (!alternative) {
        continue;
      }
      if (result.isFinal) {
        const confidence =
          typeof alternative.confidence === "number" && alternative.confidence > 0
            ? alternative.confidence
            : null;
        callbacks.onFinal?.(alternative.transcript, confidence);
      } else {
        callbacks.onInterim?.(alternative.transcript);
      }
    }
  };

  recognition.onerror = (event: RecognitionErrorEventLike) => {
    callbacks.onError?.(event.error);
  };

  recognition.onend = () => {
    listening = false;
    callbacks.onEnd?.();
  };

  return {
    start() {
      if (listening) {
        return;
      }
      recognition.start();
    },
    stop() {
      if (!listening) {
        return;
      }
      recognition.stop();
    },
    abort() {
      if (!listening) {
        return;
      }
      recognition.abort();
    },
    get listening() {
      return listening;
    }
  };
}

/** True when this browser advertises a voice for the language. */
export function hasVoiceForLanguage(language: VoiceLanguage): boolean {
  if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
    return false;
  }
  const prefix = language === "am" ? "am" : "om";
  return window.speechSynthesis.getVoices().some((voice) => voice.lang.toLowerCase().startsWith(prefix));
}
