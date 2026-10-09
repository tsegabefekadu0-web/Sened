"use client";

import React from "react";

import { AppHeader, LanguageSwitch } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Icon } from "@/components/ui/Icon";
import { Button, Card, Screen, StatusPill, type PillKind } from "@/components/ui/primitives";
import type { MessageKey } from "@/lib/i18n";
import { useOfflineQueue, type QueueMessage, type QueueStatus } from "@/lib/offline/useOfflineQueue";
import { useT } from "@/lib/ui/useT";

const PILL: Record<QueueStatus, PillKind> = { saved: "saved", waiting: "draft", retry: "draft", sent: "paid", problem: "due" };

/** `/offline`: what is saved on this phone and waiting to be sent, each with its state in words. */
export default function OfflinePage() {
  const { t, locale } = useT();
  const q = useOfflineQueue();

  const text = (m: QueueMessage | null): string | null => {
    if (m === null) return null;
    if (typeof m === "object") return t("offline.sync.drained", { sent: m.drained.sent, total: m.drained.total });
    const key: Record<Exclude<QueueMessage, { drained: unknown }>, MessageKey> = {
      needsToken: "offline.sync.needsToken",
      groupNone: "offline.group.none",
      groupChoose: "offline.group.choose",
      groupReadOnly: "offline.group.readOnly",
      notConfigured: "offline.sync.notConfigured",
      nothingQueued: "offline.sync.nothingQueued",
      storageFull: "offline.storage.full",
      failed: "ui.tryAgain"
    };
    return t(key[m]);
  };
  const msg = text(q.message);
  const birr = (a: string) => (locale === "am" ? `${a} ${t("voice.currencyEtb")}` : `${a} ETB`);

  return (
    <Screen loading={q.loading} className="snd-narrow">
      <main className="flex grow flex-col">
        <AppHeader title={t("offline.simple.title")} subtitle="Saved offline" bottom={72} ribbon={32} right={<LanguageSwitch />} />
        <Card className="snd-rise flex flex-col gap-4 p-5" style={{ margin: "-34px 16px 0" }}>
          <p lang="am" className="m-0 text-base leading-[1.6] text-soft">
            {t("offline.simple.intro")}
          </p>
          {q.online === false ? (
            <p lang="am" className="m-0 rounded-2xl px-4 py-3 text-base font-bold leading-[1.5]" style={{ background: "var(--chipcol-bg)", color: "var(--chipcol)" }}>
              {t("offline.simple.noInternet")}
            </p>
          ) : null}
          {q.storage ? (
            <Button onPress={q.drain} disabled={!q.canSend || q.busy} icon="send" successLabel={t("ui.done")} errorLabel={t("ui.tryAgain")}>
              {t("offline.simple.send")}
            </Button>
          ) : (
            <p role="alert" lang="am" className="m-0 text-base font-bold" style={{ color: "var(--dng)" }}>
              {t("offline.storage.unavailable")}
            </p>
          )}
          {msg ? (
            <p role="status" lang="am" className="m-0 text-base font-bold leading-[1.5]">
              {msg}
            </p>
          ) : null}
        </Card>

        <section className="mx-4 mt-5" aria-label={t("offline.simple.title")}>
          {q.items.length === 0 ? (
            <div className="snd-cotton flex flex-col items-center gap-3 rounded-[22px] border border-dashed border-[var(--chipb)] bg-card px-5 py-8 text-center">
              <span style={{ color: "var(--shop)" }}>
                <Icon name="check" size={36} />
              </span>
              <p lang="am" className="m-0 text-base font-bold leading-[1.6]">
                {t("offline.simple.empty")}
              </p>
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {q.items.map((item) => (
                <li key={item.id} className="snd-cotton rounded-[22px] border border-hair bg-card px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span lang="am" className="font-serif text-lg font-bold">
                      {item.kind === "note" ? t("offline.simple.note") : t("offline.simple.entry")}
                    </span>
                    {item.amount ? <span className="font-display text-lg font-extrabold">{birr(item.amount)}</span> : null}
                  </div>
                  {item.text ? (
                    <p lang="am" className="mb-0 mt-1 text-base leading-[1.5] [overflow-wrap:anywhere]">
                      {item.text}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <StatusPill kind={PILL[item.status]} label={t(`offline.simple.status.${item.status}` as MessageKey)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div style={{ height: 28 }} />
      </main>
      <BottomNav active={null} />
    </Screen>
  );
}
