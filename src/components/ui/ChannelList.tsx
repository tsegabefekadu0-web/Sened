"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { WovenRing } from "@/components/ui/Weave";
import { useSession } from "@/lib/auth/useSession";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { SAMPLE_CHANNEL_ID, previewFor, useChatPreviews } from "@/lib/ui/chatStore";
import { useCommunity } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";

interface Row {
  readonly id: string;
  readonly name: string;
  readonly preview: string;
  readonly time: string;
  readonly unread: number;
  readonly pinned: boolean;
}

const SAMPLE_ROWS: readonly Row[] = [
  { id: SAMPLE_CHANNEL_ID, name: "የቦሌ ሰፈር እቁብ", preview: "ወ/ሮ ጽጌ ከ: ቡና ጠጡ፤ የዕጣ ቀን ስብሰባ", time: "4:10", unread: 3, pinned: true },
  { id: SAMPLE_CHANNEL_ID, name: "የቤተሰብ እቁብ", preview: "ወ/ሮ ሰላም ገ: የዚህ ወር ድርሻ ተከፍሏል።", time: "", unread: 0, pinned: false },
  { id: SAMPLE_CHANNEL_ID, name: "የቦሌ ቀበሌ ፲፬ እድር", preview: "አቶ ገዛኸኝ ሰ: የእድር ስብሰባ እሁድ ጠዋት ይሆናል።", time: "", unread: 1, pinned: true }
];

/**
 * The search box and the list of chats. On a phone it is the whole Chats screen;
 * on desktop it is the left column beside the open conversation (`activeId` marks it).
 */
export function ChannelList({ activeId }: { readonly activeId?: string }) {
  const { t } = useT();
  const session = useSession();
  const group = useActiveGroup();
  const c = useCommunity();
  const [q, setQ] = useState("");
  const signedIn = session.status === "signed-in";
  useChatPreviews(group.groups.map((g) => g.groupId), signedIn);

  const rows: Row[] = useMemo(() => {
    if (!signedIn) return [...SAMPLE_ROWS];
    return group.groups.map((g) => {
      const p = previewFor(g.groupId, c, t("ui.chat.noMessages"));
      return { id: g.groupId, name: g.name || t("ui.home.noName"), preview: p.text, time: p.time, unread: 0, pinned: g.groupId === group.activeGroupId };
    });
  }, [signedIn, group.groups, group.activeGroupId, c, t]);
  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="contents lg:flex lg:flex-col">
      <label className="snd-rise relative block" style={{ margin: "-26px 16px 0" }}>
        <span aria-hidden="true" className="absolute flex text-muted" style={{ left: 16, top: 15 }}>
          <Icon name="search" size={22} />
        </span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("ui.chat.search")}
          aria-label={t("ui.chat.search")}
          className="box-border h-[54px] w-full rounded-[27px] border-[1.5px] border-hair bg-field pl-12 pr-4 text-[17px] text-ink"
          style={{ boxShadow: "var(--lift)" }}
        />
      </label>
      <section className="snd-cotton overflow-hidden rounded-[22px] border border-hair bg-card" style={{ margin: "18px 16px 0" }}>
        <ul className="m-0 list-none p-0">
          {shown.length === 0 ? (
            <li className="px-4 py-[30px] text-center text-base text-muted">
              <span lang="am">{signedIn && rows.length === 0 ? t("ui.chat.noGroups") : t("ui.ledger.empty")}</span>
            </li>
          ) : (
            shown.map((r, i) => (
              <li key={`${r.id}-${i}`} aria-current={activeId !== undefined && r.id === activeId && shown.findIndex((x) => x.id === activeId) === i ? "true" : undefined} className="snd-chrow" style={{ borderTop: i ? "1px solid var(--hair2)" : undefined, animation: "snd-rise 420ms var(--snd-emph) both", animationDelay: `${i * 40 + 160}ms` }}>
                <Link href={`/chat/${r.id}`} className="box-border flex min-h-[84px] items-center gap-3.5 px-4 py-3.5">
                  <WovenRing size={56}>
                    <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-[22px] font-bold">
                      {Array.from(r.name)[0]}
                    </span>
                  </WovenRing>
                  <span className="flex min-w-0 grow flex-col gap-[3px]">
                    <span lang="am" className="truncate font-serif text-[17px] font-bold leading-[1.3]">
                      {r.name}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {r.pinned ? (
                        <span className="flex shrink-0" style={{ color: "var(--shop)" }}>
                          <Icon name="pin" size={16} />
                        </span>
                      ) : null}
                      <span lang="am" className="truncate text-sm text-muted">
                        {r.preview}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <span lang="am" className="text-[13px] text-muted">
                      {r.time}
                    </span>
                    {r.unread ? (
                      <span className="box-border flex h-6 min-w-6 items-center justify-center rounded-xl px-[7px] text-[13px] font-extrabold text-white" style={{ background: "var(--shop)" }}>
                        {r.unread}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
