"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";

import { BottomNav } from "@/components/ui/BottomNav";
import { Icon } from "@/components/ui/Icon";
import { Button, CountUp, Screen, StatusPill } from "@/components/ui/primitives";
import { TibebRibbon } from "@/components/ui/Weave";
import { useSession } from "@/lib/auth/useSession";
import { requestBankVerification } from "@/lib/voice/clientVerify";
import { clearVoiceHandoff, readVoiceHandoff, type VoiceHandoff } from "@/lib/voice/handoff";
import { monthLabelForLocale } from "@/lib/voice/months";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { saveProvisionalVoiceNote } from "@/lib/voice/recordLocal";
import type { MessageKey } from "@/lib/i18n";
import { useCommunity } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";

/**
 * Draft: what was understood, as a receipt. Nothing here is verified; "save"
 * either sends it for the bank check (signed in) or keeps it on this device.
 */
export default function DraftPage() {
  const { t, locale } = useT();
  const session = useSession();
  const c = useCommunity();
  const [handoff, setHandoff] = useState<VoiceHandoff | null | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signedIn = session.status === "signed-in";

  useEffect(() => setHandoff(readVoiceHandoff()), []);
  const draft = useMemo(() => (handoff ? parseContributionUtterance(handoff.utterance) : null), [handoff]);
  const me = c.members.find((m) => m.isMe);

  const save = async (): Promise<boolean> => {
    if (!draft || draft.blocking) {
      setProblem(t("voice.submitUnverifiedReason"));
      return false;
    }
    setProblem(null);
    try {
      if (signedIn) {
        const outcome = await requestBankVerification(draft);
        if (!outcome.verified) {
          setProblem(t((outcome.notice ?? "voice.submitUnverifiedReason") as MessageKey));
          return false;
        }
      } else {
        await saveProvisionalVoiceNote(draft, { transcriptSource: handoff?.source ?? "asr" });
      }
    } catch {
      setProblem(t("voice.recordLocallyFailed"));
      return false;
    }
    clearVoiceHandoff();
    setSaved(true);
    return true;
  };

  const month = draft ? (monthLabelForLocale(draft.month, locale) ?? t("voice.fieldMonthMissing")) : "";
  const channel = !draft
    ? ""
    : draft.provider
      ? t(`ui.channel.${draft.provider}` as "ui.channel.telebirr")
      : draft.rail === "cash"
        ? t("ui.channel.cash")
        : draft.rail === "bank"
          ? t("ui.channel.bank")
          : t("voice.channelNone");

  return (
    <Screen className="snd-narrow">
      <main className="flex grow flex-col">
      <header className="relative flex items-center gap-2 overflow-hidden text-white" style={{ background: "var(--shop)", padding: "10px 14px 96px 8px", borderRadius: "0 0 28px 28px" }}>
        <Link href="/voice" aria-label={t("ui.back")} className="flex h-11 w-11 items-center justify-center rounded-full text-white">
          <Icon name="back" size={22} />
        </Link>
        <div className="flex min-w-0 grow flex-col">
          <h1 lang="am" className="m-0 font-serif text-[19px] font-bold leading-[1.2]">
            {t("ui.draft.title")}
          </h1>
          <span className="font-display text-[13px] font-semibold opacity-90">Your contribution</span>
        </div>
        <TibebRibbon style={{ bottom: 52 }} />
      </header>

      {handoff === null || (handoff !== undefined && !draft) ? (
        <p lang="am" role="status" className="snd-cotton mx-4 rounded-[22px] border border-hair bg-card p-5 text-base leading-[1.5] text-soft" style={{ marginTop: -42 }}>
          {t("ui.draft.nothing")}
        </p>
      ) : (
        <section aria-label={t("ui.draft.receipt")} className="snd-cotton snd-rise relative overflow-hidden rounded-[22px] border border-hair bg-card" style={{ margin: "-42px 16px 0", boxShadow: "var(--lift)" }}>
          <TibebRibbon vertical />
          <div className="flex flex-col gap-3.5" style={{ padding: "22px 20px 20px 42px" }}>
            <div className="flex items-center justify-between">
              <span lang="am" className="font-serif text-[17px] font-bold text-soft">
                {me?.name ?? t("ui.you")}
              </span>
              <StatusPill kind={saved ? "saved" : "draft"} label={saved ? t("ui.status.saved") : t("ui.status.draft")} />
            </div>
            <span className="flex items-baseline gap-2">
              {draft?.amount != null ? (
                <CountUp to={draft.amount} className="font-display text-[32px] font-extrabold leading-[1.1]" style={{ letterSpacing: "-0.02em" }} />
              ) : (
                <span className="font-display text-[32px] font-extrabold leading-[1.1]">—</span>
              )}
              <span lang="am" className="font-serif text-xl font-bold">
                {t("ui.birr")}
              </span>
            </span>
          </div>
          <div aria-hidden="true" className="relative h-0 border-t-2 border-dashed border-hair" style={{ margin: "0 14px 0 36px" }} />
          <dl className="m-0 flex flex-col" style={{ padding: "4px 20px 10px 42px" }}>
            {(
              [
                [t("voice.fieldMonth"), month, false],
                [t("voice.fieldChannel"), channel, false],
                [t("voice.fieldTxRef"), draft?.txRef ?? t("voice.fieldTxRefMissing"), true]
              ] as const
            ).map(([label, value, mono], i) => (
              <div key={label} className="flex min-h-[44px] items-center justify-between gap-3" style={{ borderTop: i ? "1px solid var(--hair2)" : undefined }}>
                <dt lang="am" className="text-[15px] text-muted">
                  {label}
                </dt>
                <dd lang="am" className={`m-0 ${mono ? "font-display text-[19px] font-extrabold" : "font-serif text-[17px] font-bold"}`} style={mono ? { letterSpacing: "0.04em" } : undefined}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <p lang="am" className="mt-[18px] flex items-center justify-center gap-2.5 text-[15px] leading-[1.5] text-soft" style={{ margin: "18px 28px 0" }}>
        <span className="flex" style={{ color: "var(--shop)" }}>
          <Icon name="shield" size={22} />
        </span>
        {t("ui.draft.bankNote")}
      </p>

      {problem ? (
        <p lang="am" role="alert" className="mx-4 mt-4 text-center text-sm font-bold" style={{ color: "var(--dng)" }}>
          {problem}
        </p>
      ) : null}

      <div className="flex flex-col gap-3" style={{ margin: "26px 16px 0" }}>
        {saved ? (
          <Link href="/ledger" className="flex h-[54px] items-center justify-center rounded-[27px] bg-prim text-[17px] font-bold text-primt">
            {t("ui.nav.ledger")}
          </Link>
        ) : (
          <>
            <Button onPress={save} disabled={!draft} successLabel={t("ui.status.saved")} errorLabel={t("ui.tryAgain")}>
              {t("ui.draft.save")}
            </Button>
            <Link href="/voice" className="flex h-[54px] items-center justify-center rounded-[27px] border-[1.5px] border-prim bg-card text-[17px] font-bold text-ink">
              {t("ui.draft.fix")}
            </Link>
          </>
        )}
      </div>
      <div style={{ height: 36 }} />
      </main>
      <BottomNav railOnly active="home" />
    </Screen>
  );
}
