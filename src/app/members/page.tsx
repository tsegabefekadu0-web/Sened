"use client";

import React, { useMemo, useState } from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { BasketRing, type RingKind } from "@/components/ui/BasketRing";
import { BottomNav } from "@/components/ui/BottomNav";
import { CommunityNotice, SampleChip } from "@/components/ui/Notices";
import { Button, Card, CountUp, Screen, StatusPill } from "@/components/ui/primitives";
import { WeaveSwatch, WovenAvatar } from "@/components/ui/Weave";
import { buildJoinUrl, createInviteLink } from "@/lib/ledger/clientInvites";
import { geez } from "@/lib/ui/geez";
import { formatBirr, useCommunity } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";

export default function MembersPage() {
  const { t, locale } = useT();
  const c = useCommunity();
  const loading = c.mode === "loading";
  const order: RingKind[] = useMemo(
    () => (c.members.length ? c.members.map((m) => (m.status === "paid" ? "paid" : m.status === "draft" ? "draft" : "due") as RingKind).sort((a, b) => ({ paid: 0, draft: 1, due: 2 })[a] - ({ paid: 0, draft: 1, due: 2 })[b]) : Array.from({ length: 8 }, () => "due" as RingKind)),
    [c.members]
  );
  const paid = order.filter((k) => k === "paid").length;
  const target = c.cycle?.pot ?? 0;
  const roleLabel = (role: string, isMe: boolean) =>
    isMe ? t("ui.role.you") : role === "treasurer" ? t("ui.role.treasurer") : role === "owner" ? t("ui.role.owner") : t("ui.role.member");
  const canInvite = c.mode === "live" && (c.role === "owner" || c.role === "treasurer") && c.groupId !== null;
  const [link, setLink] = useState<string | null>(null);

  const makeLink = async (): Promise<boolean> => {
    if (!c.groupId) return false;
    const res = await createInviteLink({ groupId: c.groupId, expiresInHours: 72, maxUses: 10 });
    if (res.status !== "created") return false;
    setLink(buildJoinUrl(window.location.origin, res.token));
    return true;
  };

  return (
    <Screen loading={loading}>
      <AppHeader title={t("ui.members.title")} subtitle={c.cycle ? `Members · ዙር ${geez(c.cycle.round)}` : "Members"} bottom={86} ribbon={44}>
        <SampleChip mode={c.mode} />
      </AppHeader>
      <CommunityNotice mode={c.mode} />

      <Card className="snd-rise flex items-center justify-between gap-3 p-5" style={{ margin: "-34px 16px 0" }} aria-label={t("ui.members.total")}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span lang="am" className="text-base font-semibold text-soft">
            {t("ui.members.roundTotal")}
          </span>
          <CountUp to={c.pot} className="font-display text-[32px] font-extrabold leading-[1.1]" style={{ letterSpacing: "-0.02em" }} />
          {target > 0 ? (
            <span className="flex items-baseline gap-1.5">
              <span className="font-display text-lg font-semibold text-muted">/ {formatBirr(target)}</span>
              <span lang="am" className="font-serif text-lg font-bold">
                {t("ui.birr")}
              </span>
            </span>
          ) : (
            <span lang="am" className="font-serif text-lg font-bold">
              {t("ui.birr")}
            </span>
          )}
        </div>
        <div className="relative shrink-0" style={{ width: 132, height: 132 }}>
          <BasketRing order={order} size={132} label={t("ui.members.ringLabel", { paid, total: order.length })} centerTop={`${paid}/${order.length}`} centerBottom="" />
        </div>
      </Card>

      <figure className="snd-rise m-0 flex flex-col gap-2 p-0" style={{ margin: "26px 24px 0", ["--i" as string]: 4 } as React.CSSProperties}>
        <WeaveSwatch className="!w-14" />
        <blockquote lang="am" className="m-0 font-serif text-[22px] font-bold leading-[1.45]">
          «{t("ui.proverb")}»
        </blockquote>
        <figcaption className="font-display text-sm font-medium text-muted">{t("ui.proverbGloss")}</figcaption>
      </figure>

      <Card className="overflow-hidden p-0" style={{ margin: "22px 16px 0", boxShadow: "none" }}>
        <ul className="m-0 list-none p-0">
          {c.members.length === 0 ? (
            <li className="flex justify-center px-4 py-[30px] text-base text-muted">
              <span lang="am">{t("ui.members.empty")}</span>
            </li>
          ) : (
            c.members.map((m, i) => (
              <li
                key={m.id}
                className="box-border flex min-h-[72px] items-center gap-3 px-4 py-3"
                style={{ borderBottom: i === c.members.length - 1 ? undefined : "1px solid var(--hair2)", animation: "snd-rise 420ms var(--snd-emph) both", animationDelay: `${i * 40 + 160}ms` }}
              >
                <span style={{ animation: "snd-spin 900ms var(--snd-emph) both", animationDelay: `${200 + i * 40}ms` }}>
                  <WovenAvatar initial={m.initial} size={52} fontSize={19} />
                </span>
                <span className="flex min-w-0 grow flex-col gap-px">
                  <span lang="am" className="font-serif text-[17px] font-bold leading-[1.3]">
                    {m.name}
                  </span>
                  <span lang="am" className="text-[13px] text-muted">
                    {roleLabel(m.role, m.isMe)}
                  </span>
                </span>
                <StatusPill kind={m.status} label={t(`ui.status.${m.status}` as "ui.status.paid")} />
              </li>
            ))
          )}
        </ul>
      </Card>

      {canInvite ? (
        <Card className="flex flex-col gap-3 p-5" style={{ margin: "22px 16px 0" }}>
          <span lang="am" className="font-serif text-lg font-bold">
            {t("ui.members.invite")}
          </span>
          {link ? (
            <input
              readOnly
              aria-label={t("ui.members.inviteLink")}
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="h-12 w-full rounded-xl border border-hair bg-field px-3 text-sm text-ink"
            />
          ) : (
            <p lang="am" className="m-0 text-sm leading-[1.5] text-muted">
              {t("ui.members.inviteHint")}
            </p>
          )}
          <Button onPress={makeLink} variant="ghost" successLabel={t("ui.done")} errorLabel={t("ui.tryAgain")}>
            {t("ui.members.inviteCreate")}
          </Button>
        </Card>
      ) : null}
      <div style={{ height: 28 }} />
      <BottomNav active="home" />
    </Screen>
  );
}
