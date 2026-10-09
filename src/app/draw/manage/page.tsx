"use client";

import Link from "next/link";
import React from "react";

import { LiveDraw } from "@/components/draw-console/LiveDraw";
import { AppHeader } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Card, Screen } from "@/components/ui/primitives";
import { useSession } from "@/lib/auth/useSession";
import { canRunTreasurerSteps } from "@/lib/draw/clientDraw";
import { useCommunity } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";

/**
 * `/draw/manage`: the draw console. Treasurers and owners get every step (open a
 * round, seal, commit, reveal, collateral, contribution gate, cancel, payout);
 * a plain member sees only what a member does (seal their name, release their
 * number). The role comes from the server and the API checks it again.
 */
export default function ManageDrawPage() {
  const { t, locale } = useT();
  const session = useSession();
  const c = useCommunity();
  const treasurer = canRunTreasurerSteps(c.role);
  const signedIn = session.status === "signed-in";
  const loading = session.status === "loading" || (signedIn && c.mode === "loading");

  return (
    <Screen loading={loading}>
      <main className="flex grow flex-col">
        <AppHeader back="/draw" backLabel={t("ui.back")} title={treasurer ? t("ui.manage.title") : t("ui.manage.memberTitle")} subtitle="Draw" bottom={72} ribbon={32} />
        <div className="flex flex-col gap-4" style={{ margin: "-34px 16px 0" }}>
          {!signedIn && !loading ? (
            <Card className="flex flex-col gap-3 p-5" data-testid="manage-refusal">
              <p lang="am" role="alert" className="m-0 text-base leading-[1.5]">
                {t("ui.manage.signInNeeded")}
              </p>
              <Link href="/sign-in" className="flex h-12 items-center justify-center rounded-3xl bg-prim text-base font-bold text-primt">
                {t("ui.signIn.cta")}
              </Link>
            </Card>
          ) : null}
          {signedIn && (c.mode === "no-group" || c.mode === "choose-group") ? (
            <Card className="flex flex-col gap-3 p-5" data-testid="manage-refusal">
              <p lang="am" role="alert" className="m-0 text-base leading-[1.5]">
                {t("ui.manage.noCommunity")}
              </p>
              <Link href="/account" className="flex h-12 items-center justify-center rounded-3xl bg-prim text-base font-bold text-primt">
                {t("ui.nav.account")}
              </Link>
            </Card>
          ) : null}
          {session.status === "signed-in" && c.mode !== "no-group" && c.mode !== "choose-group" && c.mode !== "loading" ? (
            <>
              <Card className="p-5" data-testid={treasurer ? "manage-treasurer" : "manage-member"}>
                <p lang="am" className="m-0 text-sm leading-[1.5] text-soft">
                  {treasurer ? t("ui.manage.treasurerNote") : t("ui.manage.memberNote")}
                </p>
              </Card>
              <div className="overflow-hidden rounded-[22px]">
                <LiveDraw locale={locale} accessToken={session.accessToken} />
              </div>
            </>
          ) : null}
        </div>
        <div style={{ height: 28 }} />
      </main>
      <BottomNav active="home" />
    </Screen>
  );
}
