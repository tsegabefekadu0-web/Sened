"use client";

import Link from "next/link";
import React, { useState } from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { Icon } from "@/components/ui/Icon";
import { Button, Card, Screen } from "@/components/ui/primitives";
import { SlideSwitch } from "@/components/ui/SlideSwitch";
import { WovenAvatar } from "@/components/ui/Weave";
import { authedFetch } from "@/lib/auth/authedFetch";
import { useSession } from "@/lib/auth/useSession";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import type { CreatedCommunity } from "@/lib/community/types";
import { geez } from "@/lib/ui/geez";
import { useT } from "@/lib/ui/useT";

const FIELD =
  "box-border h-[52px] w-full rounded-2xl border-[1.5px] border-[var(--chipb)] bg-field px-4 text-[17px] text-ink placeholder:text-muted";
const AMOUNTS = [500, 1000, 2000, 5000];
const DRAFT_KEY = "sened.communityDraft.v1";

/**
 * Create a community in three steps: details, contribution settings, review & invite link.
 * When signed in, creates the group on the server with owner permissions, chart of
 * accounts, and an invite link. Offline or unconfigured, preserves the plan locally.
 */
export default function CreateCommunityPage() {
  const { t, locale } = useT();
  const session = useSession();
  const activeGroup = useActiveGroup();

  const [step, setStep] = useState(1);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"equb" | "iddir">("equb");
  const [amount, setAmount] = useState(5000);
  const [weekly, setWeekly] = useState(false);
  const [members, setMembers] = useState(8);
  const [done, setDone] = useState(false);
  const [created, setCreated] = useState<CreatedCommunity | null>(null);
  const [copied, setCopied] = useState(false);

  const label = locale === "am" ? `${geez(step)} ከ ፫` : `${step} / 3`;

  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(n);
  };

  const create = async (): Promise<boolean> => {
    if (session.status === "signed-in") {
      try {
        const res = await authedFetch("/api/community", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            amount,
            frequency: weekly ? "weekly" : "monthly",
            members
          })
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { community?: CreatedCommunity } | null;
          if (body?.community) {
            setCreated(body.community);
            activeGroup.reload(body.community.groupId);
            setDone(true);
            return true;
          }
        }
      } catch {
        // Fall back to draft
      }
    }

    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ name: name.trim(), kind, amount, weekly, members, at: new Date().toISOString() })
      );
    } catch {
      return false;
    }
    setDone(true);
    return true;
  };

  const copyInvite = async () => {
    const url = created?.invite?.joinUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2400);
    } catch {
      // ignore clipboard error
    }
  };

  const stepAnim = { animation: `${dir > 0 ? "snd-slide-r" : "snd-slide-l"} 320ms var(--snd-emph) both` };
  const display = name.trim() || t("ui.create.namePlaceholder");

  const kindCard = (k: "equb" | "iddir") => {
    const on = kind === k;
    return (
      <button
        key={k}
        type="button"
        lang="am"
        aria-pressed={on}
        onClick={() => setKind(k)}
        className="flex cursor-pointer flex-col items-start gap-2 rounded-[18px] text-left text-ink"
        style={{
          padding: on ? 13 : 14,
          background: on ? "color-mix(in srgb, var(--shop) 12%, transparent)" : "var(--card)",
          border: on ? "2px solid var(--shop)" : "1.5px solid var(--chipb)"
        }}
      >
        <span aria-hidden="true" className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-hair2" style={{ color: "var(--shop)" }}>
          <Icon name={k === "equb" ? "draw" : "users"} size={28} />
        </span>
        <span className="font-serif text-xl font-bold leading-[1.2]">{t(k === "equb" ? "ui.kind.equb" : "ui.kind.iddir")}</span>
        <span className="text-sm leading-[1.4] text-muted">{t(k === "equb" ? "ui.kind.equbHint" : "ui.kind.iddirHint")}</span>
      </button>
    );
  };

  return (
    <Screen>
      <main className="flex grow flex-col">
        <AppHeader
          back="/account"
          backLabel={t("ui.back")}
          title={t("ui.create.title")}
          subtitle="Create community"
          bottom={96}
          ribbon={52}
          right={<span lang="am" className="font-serif text-[17px] font-bold">{label}</span>}
        />
        <Card className="snd-rise flex flex-col gap-5" style={{ margin: "-44px 16px 0", padding: "20px 18px 22px" }}>
          <div role="img" aria-label={label} className="flex gap-2">
            {[1, 2, 3].map((i) => (
              <span
                key={i}
                className={`h-2.5 flex-1 rounded-[5px] ${step >= i ? "snd-weave-tex" : "bg-hair2"}`}
                style={step >= i ? { backgroundSize: "6px 6px", boxShadow: "0 2px 3px -1px rgba(0,0,0,0.35)" } : undefined}
              />
            ))}
          </div>

          {step === 1 ? (
            <div className="flex flex-col gap-[18px]" style={stepAnim}>
              <label className="flex flex-col gap-1.5">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("ui.create.name")}
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("ui.create.namePlaceholder")}
                  className={FIELD}
                  maxLength={60}
                />
              </label>
              <div className="flex flex-col gap-2">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("ui.create.kind")}
                </span>
                <div className="grid grid-cols-2 gap-3">
                  {kindCard("equb")}
                  {kindCard("iddir")}
                </div>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-[18px]" style={stepAnim}>
              <div className="flex flex-col gap-2">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("ui.create.amount")}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="font-display text-[32px] font-extrabold leading-[1.1]" style={{ letterSpacing: "-0.02em" }}>
                    {amount.toLocaleString("en-US")}
                  </span>
                  <span lang="am" className="font-serif text-xl font-bold">
                    {t("ui.birr")}
                  </span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {AMOUNTS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={amount === v}
                      onClick={() => setAmount(v)}
                      className="h-11 cursor-pointer rounded-[22px] px-[18px] font-display text-base font-extrabold"
                      style={
                        amount === v
                          ? { border: "none", background: "var(--prim)", color: "var(--primt)", animation: "snd-pop 280ms var(--snd-spring) both" }
                          : { border: "1.5px solid var(--chipb)", background: "var(--card)", color: "var(--ink)" }
                      }
                    >
                      {v.toLocaleString("en-US")}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("ui.create.frequency")}
                </span>
                <div className="flex justify-center">
                  <SlideSwitch
                    checked={weekly}
                    onChange={setWeekly}
                    label={t("ui.create.frequency")}
                    left={t("ui.create.monthly")}
                    right={t("ui.create.weekly")}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("ui.create.members")}
                </span>
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    aria-label={t("ui.fewer")}
                    onClick={() => setMembers((m) => Math.max(2, m - 1))}
                    className="h-[52px] w-[52px] cursor-pointer rounded-full border-[1.5px] border-[var(--chipb)] bg-card p-0 text-2xl font-bold text-ink"
                  >
                    −
                  </button>
                  <span className="font-display text-[32px] font-extrabold" style={{ letterSpacing: "-0.02em" }}>
                    {members}
                  </span>
                  <button
                    type="button"
                    aria-label={t("ui.more")}
                    onClick={() => setMembers((m) => Math.min(30, m + 1))}
                    className="h-[52px] w-[52px] cursor-pointer rounded-full border-[1.5px] border-[var(--chipb)] bg-card p-0 text-2xl font-bold text-ink"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-hair2 px-4 py-3.5">
                <span lang="am" className="text-[15px] text-soft">
                  {t("ui.create.pot")}
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-display text-[22px] font-extrabold" style={{ letterSpacing: "-0.02em" }}>
                    {(amount * members).toLocaleString("en-US")}
                  </span>
                  <span lang="am" className="font-serif text-[15px] font-bold">
                    {t("ui.birr")}
                  </span>
                </span>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-[18px]" style={stepAnim}>
              <div className="flex items-center gap-3.5 rounded-[22px] border border-hair bg-hair2 px-4 py-3.5">
                <WovenAvatar initial={Array.from(display)[0] ?? "ማ"} size={60} fontSize={22} />
                <span className="flex min-w-0 grow flex-col gap-0.5">
                  <span lang="am" className="font-serif text-lg font-bold leading-[1.3]">
                    {display}
                  </span>
                  <span lang="am" className="text-sm text-muted">
                    {t(kind === "equb" ? "ui.kind.equb" : "ui.kind.iddir")} · {members} {t("ui.members.count")}
                  </span>
                  <span lang="am" className="text-sm text-muted">
                    {amount.toLocaleString("en-US")} {t("ui.birr")} · {weekly ? t("ui.create.weekly") : t("ui.create.monthly")}
                  </span>
                </span>
                <span lang="am" className="inline-flex h-7 items-center rounded-[14px] px-3 text-[13px] font-bold" style={{ background: "var(--chipcol-bg)", color: "var(--chipcol)" }}>
                  {t("ui.role.owner")}
                </span>
              </div>

              {created?.invite?.joinUrl ? (
                <div className="flex flex-col gap-2 rounded-2xl border border-[var(--chipb)] bg-hair2 p-3.5">
                  <span lang="am" className="text-xs font-bold text-soft">
                    {locale === "am" ? "የመጋበዣ ሊንክ" : "Invite link"}
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={created.invite.joinUrl}
                      aria-label="Invite link"
                      className="h-10 min-w-0 grow rounded-xl border border-[var(--hair2)] bg-card px-3 font-mono text-xs text-ink"
                    />
                    <button
                      type="button"
                      onClick={copyInvite}
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-prim px-3.5 text-xs font-bold text-primt"
                    >
                      {copied ? (
                        <Icon name="check" size={14} />
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                      <span>{copied ? (locale === "am" ? "ተቀድቷል" : "Copied!") : (locale === "am" ? "ቅዳ" : "Copy")}</span>
                    </button>
                  </div>
                </div>
              ) : null}

              <p lang="am" className="m-0 text-sm leading-[1.5] text-muted" data-testid="create-note">
                {done
                  ? created
                    ? (locale === "am" ? "ማህበረሰብዎ ተፈጥሯል! የመጋበዣ ሊንኩን ለአባላት ያጋሩ።" : "Your community is created! Share the invite link with members.")
                    : t("ui.create.localDone")
                  : t("ui.create.localNote")}
              </p>
            </div>
          ) : null}
        </Card>

        <div className="flex flex-col gap-2" style={{ margin: "22px 16px 0" }}>
          {done ? (
            <Link href="/home" className="flex h-[54px] items-center justify-center rounded-[27px] bg-prim text-[17px] font-bold text-primt">
              {locale === "am" ? "ወደ ማህበረሰብ ሂድ" : "Go to community"}
            </Link>
          ) : step < 3 ? (
            <Button onPress={() => go(step + 1)} disabled={step === 1 && name.trim() === ""}>
              {t("ui.next")}
            </Button>
          ) : (
            <Button onPress={create} successLabel={t("ui.create.created")} errorLabel={t("ui.tryAgain")}>
              {t("ui.create.create")}
            </Button>
          )}
          {step > 1 && !done ? (
            <button type="button" lang="am" onClick={() => go(step - 1)} className="min-h-12 border-none bg-transparent text-base font-bold text-soft">
              {t("ui.back")}
            </button>
          ) : null}
        </div>
        <div style={{ height: 24 }} />
      </main>
    </Screen>
  );
}
