"use client";

import React from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { ChannelList } from "@/components/ui/ChannelList";
import { SampleChip } from "@/components/ui/Notices";
import { Screen } from "@/components/ui/primitives";
import { WovenRing } from "@/components/ui/Weave";
import { useSession } from "@/lib/auth/useSession";
import { useT } from "@/lib/ui/useT";

export default function ChatsPage() {
  const { t } = useT();
  const session = useSession();
  const signedIn = session.status === "signed-in";

  return (
    <Screen loading={session.status === "loading"}>
      <main className="flex grow flex-col">
        <AppHeader title={t("ui.nav.chat")} subtitle="Community chat" bottom={62} ribbon={40}>
          <SampleChip mode={signedIn ? "live" : "sample"} />
        </AppHeader>
        {/* Desktop: the list on the left, a place for the open conversation on the right. */}
        <div className="contents lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start lg:gap-x-8">
          <ChannelList />
          <section aria-label={t("ui.nav.chat")} className="snd-cotton hidden flex-col items-center justify-center gap-4 rounded-[22px] border border-hair bg-card text-center lg:flex" style={{ margin: "18px 16px 0", minHeight: 360, padding: 32, boxShadow: "var(--lift)" }}>
            <WovenRing size={72}>
              <span aria-hidden="true" lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-[30px] font-bold">
                ሰ
              </span>
            </WovenRing>
            <p lang="am" className="m-0 max-w-[300px] font-serif text-xl font-bold leading-[1.4]">
              {t("ui.chat.pick")}
            </p>
          </section>
        </div>
        <div style={{ height: 28 }} />
      </main>
      <BottomNav />
    </Screen>
  );
}
