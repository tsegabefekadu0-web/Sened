"use client";

import React, { useMemo } from "react";
import { Languages, Mic } from "lucide-react";

import { ScreenFrame } from "@/components/shell/ScreenFrame";
import { VoiceCapture } from "@/components/voice/VoiceCapture";
import { useSession } from "@/lib/auth/useSession";
import { useAppLocale } from "@/lib/appLocale";
import { createTranslator } from "@/lib/i18n";
import { requestBankVerification } from "@/lib/voice/clientVerify";
import { saveProvisionalVoiceNote } from "@/lib/voice/recordLocal";

/**
 * `/voice` for everyone: record a contribution by voice. One big button, what
 * was understood in large type, and a plain note that the bank check makes it
 * final. The developer workbench lives at `/voice?debug=1`.
 */
export function VoiceScreen() {
  const [locale, setLocale] = useAppLocale("am");
  const t = useMemo(() => createTranslator(locale), [locale]);
  const session = useSession();
  const signedIn = session.status === "signed-in";

  return (
    <ScreenFrame
      locale={locale}
      onToggleLocale={() => setLocale((value) => (value === "am" ? "en" : "am"))}
      title={t("voice.simple.title")}
    >
      <div className="space-y-6 px-4 py-5">
        <VoiceCapture
          locale={locale}
          onRequestVerification={signedIn ? requestBankVerification : undefined}
          onRecordLocally={signedIn ? undefined : async (draft, origin) => void (await saveProvisionalVoiceNote(draft, origin))}
        />

        <section aria-labelledby="voice-helpers-title" className="rounded-2xl border border-[#D9C8B5] bg-white px-4 py-4">
          <h2 id="voice-helpers-title" className="font-ethiopic text-[20px] font-bold text-[#2A1D17]">
            {t("voice.helpers.title")}
          </h2>
          <ul className="mt-3 space-y-3">
            <li className="flex items-start gap-3 font-ethiopic text-[18px] leading-[1.6] text-[#3A2C22]">
              <Mic className="mt-1 h-6 w-6 shrink-0 text-[#A9411D]" aria-hidden="true" />
              <span>{t("voice.helpers.amharic")}</span>
            </li>
            <li className="flex items-start gap-3 font-ethiopic text-[18px] leading-[1.6] text-[#3A2C22]">
              <Languages className="mt-1 h-6 w-6 shrink-0 text-[#A9411D]" aria-hidden="true" />
              <span>{t("voice.helpers.english")}</span>
            </li>
          </ul>
        </section>
      </div>
    </ScreenFrame>
  );
}
