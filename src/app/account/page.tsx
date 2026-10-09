"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Icon } from "@/components/ui/Icon";
import { ProfileAvatar } from "@/components/ui/ProfileAvatar";
import { Card, Screen } from "@/components/ui/primitives";
import { SlideSwitch } from "@/components/ui/SlideSwitch";
import { WovenRing } from "@/components/ui/Weave";
import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { useSession } from "@/lib/auth/useSession";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { useProfile } from "@/lib/ui/profile";
import { useTheme } from "@/lib/ui/theme";
import { useT } from "@/lib/ui/useT";

export default function AccountPage() {
  const { t, locale, setLocale } = useT();
  const router = useRouter();
  const session = useSession();
  const group = useActiveGroup();
  const [profile] = useProfile();
  const [theme, setTheme] = useTheme();
  const signedIn = session.status === "signed-in";
  const email = signedIn ? session.email : null;
  const name = profile.name || (email ? email.split("@")[0] : t("ui.account.guest"));
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";

  const rows: ReadonlyArray<readonly [string, string]> = [
    [t("ui.field.name"), name],
    [t("ui.field.phone"), profile.phone ? `+251 ${profile.phone}` : "—"],
    [t("ui.field.email"), email ?? "—"]
  ];

  const signOut = async () => {
    try {
      await getBrowserSupabase()?.auth.signOut();
    } finally {
      router.push("/welcome");
    }
  };

  const roleChip = (role: string | null) => {
    const col = role === "owner" || role === "treasurer";
    return (
      <span
        lang="am"
        className="inline-flex h-7 items-center whitespace-nowrap rounded-[14px] px-3 text-[13px] font-bold"
        style={col ? { background: "var(--chipcol-bg)", color: "var(--chipcol)" } : { background: "var(--hair2)", color: "var(--soft)" }}
      >
        {col ? (role === "owner" ? t("ui.role.owner") : t("ui.role.treasurer")) : t("ui.role.member")}
      </span>
    );
  };

  return (
    <Screen>
      <main className="flex grow flex-col">
        <AppHeader bottom={86} ribbon={40} title={t("ui.nav.account")} subtitle="Account">
          <div className="mt-1 flex flex-col items-center gap-2.5">
            <div style={{ filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.28))" }}>
              <ProfileAvatar initial={initial} photo={profile.photo} size={128} />
            </div>
            <div className="flex flex-col gap-0.5 text-center">
              <span lang="am" className="font-serif text-[26px] font-bold leading-[1.25]">
                {name}
              </span>
              {profile.phone ? <span className="font-display text-[15px] font-semibold opacity-90">+251 {profile.phone}</span> : null}
            </div>
            <Link href="/account/edit" aria-label={t("ui.account.editPhoto")} className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-[18px] text-[15px] font-bold text-[#1C1A17]">
              <Icon name="camera" size={20} />
              <span lang="am">{t("ui.account.editPhoto")}</span>
            </Link>
          </div>
        </AppHeader>

        {/* Phones: one column (the wrapper vanishes). Desktop: profile and settings left, communities right. */}
        <div className="contents lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <Card className="snd-rise overflow-hidden p-0 lg:col-start-1 lg:row-start-1" style={{ margin: "-32px 16px 0" }} aria-label={t("ui.nav.account")}>
          <ul className="m-0 list-none p-0">
            {rows.map(([k, v], i) => (
              <li key={k} style={{ borderTop: i ? "1px solid var(--hair2)" : undefined }}>
                <Link href="/account/edit" className="flex min-h-16 items-center gap-3 py-1.5 pl-[18px] pr-2.5">
                  <span className="flex min-w-0 grow flex-col gap-px">
                    <span lang="am" className="text-[13px] text-muted">
                      {k}
                    </span>
                    <span lang="am" className="text-[17px] font-bold [overflow-wrap:anywhere]">
                      {v}
                    </span>
                  </span>
                  <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-full text-muted">
                    <Icon name="pencil" size={20} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <section className="snd-rise flex flex-col gap-3.5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:!mt-[26px]" style={{ margin: "30px 16px 0", ["--i" as string]: 2 } as React.CSSProperties}>
          <h2 lang="am" className="mx-1 my-0 font-serif text-[25px] font-bold">
            {t("ui.account.communities")}
          </h2>
          <Link
            href="/community/new"
            className="flex h-[54px] items-center justify-center gap-2.5 rounded-[27px] bg-prim text-[17px] font-bold text-primt"
            style={{ boxShadow: "0 8px 16px -10px rgba(0,0,0,0.7)" }}
          >
            <Icon name="plus" size={22} />
            <span lang="am">{t("ui.account.create")}</span>
          </Link>
          {!signedIn ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="sample-communities">
              {[["የቦሌ ሰፈር እቁብ", false], ["የቦሌ ቀበሌ ፲፬ እድር", false], ["የቤተሰብ እቁብ", true]].map(([n, col]) => (
                <li key={String(n)}>
                  <Link href="/chat/sample" className="snd-cotton box-border flex min-h-[76px] items-center gap-3.5 rounded-[22px] border border-hair bg-card px-3.5 py-3">
                    <WovenRing size={52}>
                      <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-xl font-bold">{Array.from(String(n))[col ? 0 : 1]}</span>
                    </WovenRing>
                    <span className="flex min-w-0 grow flex-col gap-0.5">
                      <span lang="am" className="font-serif text-[17px] font-bold leading-[1.3]">{n}</span>
                      <span lang="am" className="text-sm text-muted">{t("ui.sample.chip")}</span>
                    </span>
                    {roleChip(col ? "treasurer" : "member")}
                  </Link>
                </li>
              ))}
            </ul>
          ) : signedIn && group.groups.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {group.groups.map((g, i) => (
                <li key={g.groupId} style={{ animation: "snd-rise 420ms var(--snd-emph) both", animationDelay: `${460 + i * 60}ms` }}>
                  <Link
                    href={`/chat/${g.groupId}`}
                    onClick={() => group.select(g.groupId)}
                    aria-current={group.activeGroupId === g.groupId ? "true" : undefined}
                    className="snd-cotton box-border flex min-h-[76px] items-center gap-3.5 rounded-[22px] border bg-card px-3.5 py-3"
                    style={{ borderColor: group.activeGroupId === g.groupId ? "var(--shop)" : "var(--hair)" }}
                  >
                    <WovenRing size={52}>
                      <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-xl font-bold">
                        {Array.from(g.name || "ሰ")[0]}
                      </span>
                    </WovenRing>
                    <span className="flex min-w-0 grow flex-col gap-0.5">
                      <span lang="am" className="font-serif text-[17px] font-bold leading-[1.3]">
                        {g.name || t("ui.home.noName")}
                      </span>
                      <span lang="am" className="text-sm text-muted">
                        {group.activeGroupId === g.groupId ? t("ui.account.active") : t("ui.account.tapToOpen")}
                      </span>
                    </span>
                    {roleChip(g.role)}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p lang="am" className="m-0 px-1 text-sm leading-[1.5] text-muted">
              {signedIn ? t("ui.account.noCommunities") : t("ui.account.signInForCommunities")}
            </p>
          )}
        </section>

        <section className="snd-rise lg:col-start-1 lg:row-start-2" style={{ margin: "30px 16px 0", ["--i" as string]: 4 } as React.CSSProperties}>
          <h2 lang="am" className="mx-1 mb-3.5 mt-0 font-serif text-[25px] font-bold">
            {t("ui.account.settings")}
          </h2>
          <div className="snd-cotton rounded-[22px] border border-hair bg-card">
            <div className="box-border flex min-h-[68px] flex-wrap items-center justify-between gap-x-2 gap-y-0" style={{ padding: "10px 12px 10px 18px" }}>
              <span lang="am" className="text-base font-bold">
                {t("ui.language")}
              </span>
              <SlideSwitch checked={locale === "en"} onChange={(on) => setLocale(on ? "en" : "am")} label={t("ui.language")} left="አማርኛ" right="English" />
            </div>
            <div className="mx-[18px] h-px bg-hair2" />
            <div className="box-border flex min-h-[68px] flex-wrap items-center justify-between gap-x-2 gap-y-0" style={{ padding: "10px 12px 10px 18px" }}>
              <span lang="am" className="text-base font-bold">
                {t("ui.account.look")}
              </span>
              <SlideSwitch
                checked={theme === "dark"}
                onChange={(on) => setTheme(on ? "dark" : "light")}
                label={t("ui.account.look")}
                left={
                  <>
                    <Icon name="sun" size={18} />
                    <span>{t("ui.account.light")}</span>
                  </>
                }
                right={
                  <>
                    <Icon name="moon" size={18} />
                    <span>{t("ui.account.dark")}</span>
                  </>
                }
              />
            </div>
          </div>
        </section>

        <div className="flex justify-center lg:col-span-2" style={{ margin: "22px 0 28px" }}>
          {signedIn ? (
            <button type="button" lang="am" onClick={() => void signOut()} className="h-12 rounded-3xl border-none bg-transparent px-6 text-base font-bold" style={{ color: "var(--dng)" }}>
              {t("ui.account.signOut")}
            </button>
          ) : (
            <Link href="/sign-in" className="flex h-12 items-center rounded-3xl bg-prim px-6 text-base font-bold text-primt">
              {t("ui.signIn.cta")}
            </Link>
          )}
        </div>
        </div>
      </main>
      <BottomNav />
    </Screen>
  );
}
