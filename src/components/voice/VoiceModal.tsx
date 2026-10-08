"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";

import { VoiceCapture } from "@/components/voice/VoiceCapture";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import type { ProvisionalContribution, VoiceLanguage } from "@/lib/voice/types";

export interface BankVerificationOutcome {
  /** Only a real `VERIFIED` state from AGENT-1's route may say `true`. */
  readonly verified: boolean;
  readonly verificationId?: string;
  /** Why it was not verified, in the caller's words; defaults to the generic reason. */
  readonly notice?: MessageKey;
}

export interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Hands a sound draft to `/api/bank-verifications`. Nothing may reach the
   * ledger from speech; only a real `VERIFIED` result may, and that arrives
   * through the verifier's response.
   */
  onRequestVerification?: (draft: ProvisionalContribution) => Promise<BankVerificationOutcome>;
  /**
   * Records the extraction on this device as a provisional note: not a
   * verification, not a ledger entry, and not presented as either.
   */
  onRecordLocally?: (
    draft: ProvisionalContribution,
    origin: { readonly transcriptSource: "human-typed" | "asr" }
  ) => void | Promise<void>;
  /** Defaults to `am` so the M1 shell's existing Amharic copy is unchanged. */
  locale?: Locale;
  language?: VoiceLanguage;
  /** Text handed over for review (the English assistant uses it); nothing is recorded until the person taps. */
  initialTyped?: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * The record-by-voice sheet on the home screen: a big close button, then the
 * same capture screen the /voice page shows. Focus moves in when it opens, is
 * kept inside while it is open, and goes back to the button that opened it.
 */
export function VoiceModal({
  isOpen,
  onClose,
  onRequestVerification,
  onRecordLocally,
  locale = "am",
  language = "am",
  initialTyped
}: VoiceModalProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Back to the button that opened this sheet, not the top of the page.
      if (opener && opener.isConnected) {
        opener.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex select-none items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sened-voice-title"
        className="relative flex max-h-[94dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border-t-4 border-[#C89736] bg-[#FAF6F0] shadow-2xl sm:rounded-3xl sm:border-4"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 bg-[#2A1D17] px-4 py-2 text-[#F3E6D3]">
          <h2 id="sened-voice-title" className="font-ethiopic text-[22px] font-bold leading-snug">
            {t("voice.title")}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={() => onClose()}
            aria-label={t("voice.close")}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#F3E6D3] text-[#2A1D17] active:scale-95 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
          >
            <X className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <VoiceCapture
            locale={locale}
            language={language}
            initialTyped={initialTyped}
            onRequestVerification={onRequestVerification}
            onRecordLocally={onRecordLocally}
            onDone={() => onClose()}
          />
        </div>
      </div>
    </div>
  );
}
