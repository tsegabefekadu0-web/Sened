"use client";

import { useCallback, useEffect, useState } from "react";

import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { useSession } from "@/lib/auth/useSession";
import { isUuid, loadLatest } from "@/lib/chat/chatClient";
import { clockLabel } from "@/lib/chat/items";
import { getChatPreview, setChatPreview, subscribeChatPreviews } from "@/lib/chat/preview";
import { useLiveChannel } from "@/lib/chat/useLiveChannel";

import type { CommunityView } from "./useCommunity";
import { ETHIOPIC_MONTHS, geez, toEthiopic } from "./geez";
import { useT } from "./useT";

/**
 * Community chat. A real group's conversation is live: `useLiveChannel`
 * (src/lib/chat) loads it from Supabase, follows it over Realtime and sends
 * through an offline-tolerant outbox. The sample channel (`/chat/sample`, and
 * everything signed out) stays an in-memory, clearly labelled demonstration.
 */

export interface Reactions {
  readonly ack: number;
  readonly smile: number;
}

export type ChatItem =
  | { readonly kind: "day"; readonly id: string; readonly label: string }
  | { readonly kind: "sys"; readonly id: string; readonly icon: "book" | "draw"; readonly text: string; readonly href: string }
  | {
      readonly kind: "msg";
      readonly id: string;
      readonly mine: boolean;
      readonly who: string;
      readonly initial: string;
      readonly badge?: boolean;
      readonly text?: string;
      readonly quote?: { readonly name: string; readonly text: string };
      readonly voice?: { readonly dur: string; readonly transcript: string; readonly src?: string };
      readonly coffee?: boolean;
      readonly time: string;
      readonly sending?: boolean;
      readonly react?: { readonly ack?: number; readonly smile?: number };
    };

const store = new Map<string, ChatItem[]>();
const mineReacted = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const SAMPLE_CHANNEL_ID = "sample";

function sampleItems(): ChatItem[] {
  return [
    { kind: "day", id: "d1", label: "ነሐሴ ፴" },
    { kind: "sys", id: "s1", icon: "draw", text: "ዕጣ ወጣ: ወ/ሮ ጽጌ ከ · 40,000 ብር", href: "/draw" },
    { kind: "msg", id: "m1", mine: false, who: "ወ/ሮ ፋጡማ አ", initial: "ፋ", text: "እንኳን ደስ አለሽ ጽጌ! በሰላም ይግባሽ።", time: "4:02", react: { smile: 4 } },
    { kind: "msg", id: "m2", mine: false, who: "ወ/ሮ ጽጌ ከ", initial: "ጽ", text: "አመሰግናለሁ ጎረቤቶቼ! ቡናው ለእኔ ነው።", time: "4:05", react: { smile: 5 } },
    { kind: "day", id: "d2", label: "መስከረም ፲፭" },
    { kind: "msg", id: "m3", mine: false, who: "ወ/ሮ ፋጡማ አ", initial: "ፋ", text: "እንደምን አደራችሁ ጎረቤቶች!", time: "8:10" },
    { kind: "msg", id: "m4", mine: false, who: "አቶ ዮሐንስ መ", initial: "ዮ", text: "እንደምን አደርሽ ፋጡማ፤ ደህና ነን።", time: "8:12" },
    { kind: "sys", id: "s2", icon: "book", text: "ወ/ሮ አልማዝ ተ 5,000 ብር ከፍለዋል · ተረጋግጧል", href: "/ledger" },
    { kind: "msg", id: "m5", mine: false, who: "አቶ ታደሰ ወ", initial: "ታ", badge: true, text: "የመስከረም ድርሻ ያልከፈላችሁ እባካችሁ እስከ ወሩ መጨረሻ ይክፈሉ። አመሰግናለሁ።", time: "9:30", react: { ack: 3 } },
    { kind: "msg", id: "m6", mine: false, who: "ወ/ሮ ሙሉ በ", initial: "ሙ", voice: { dur: "0:12", transcript: "ዛሬ በቴሌብር አስገባለሁ።" }, time: "9:41" },
    { kind: "msg", id: "m7", mine: true, who: "", initial: "", quote: { name: "አቶ ታደሰ ወ", text: "የመስከረም ድርሻ ያልከፈላችሁ እባካችሁ…" }, text: "ተረድቻለሁ፣ ዛሬ ማታ በቴሌብር አስገባለሁ።", time: "9:48" },
    { kind: "msg", id: "m8", mine: false, who: "ወ/ሮ ጽጌ ከ", initial: "ጽ", coffee: true, time: "10:20" }
  ];
}

export function timeNow(): string {
  const d = new Date();
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const key = SAMPLE_CHANNEL_ID;
const NO_ITEMS: ChatItem[] = [];
const NO_REACTED = new Set<string>();

/** The items of one channel plus the actions on them. */
export function useChannel(channelId: string, c: CommunityView) {
  const { t } = useT();
  const session = useSession();
  const [, tick] = useState(0);
  const signedIn = session.status === "signed-in";
  const sample = channelId === SAMPLE_CHANNEL_ID || (session.status !== "loading" && !signedIn);
  const liveEnabled = signedIn && !sample && isUuid(channelId);
  const live = useLiveChannel(channelId, liveEnabled, signedIn ? (session.userId ?? null) : null, c, t);

  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  // The sample is seeded once, in memory.
  useEffect(() => {
    if (!sample || store.has(SAMPLE_CHANNEL_ID)) return;
    store.set(SAMPLE_CHANNEL_ID, sampleItems());
    emit();
  }, [sample]);

  const items = sample ? (store.get(key) ?? NO_ITEMS) : liveEnabled ? live.items : NO_ITEMS;
  const reacted = sample ? (mineReacted.get(key) ?? NO_REACTED) : liveEnabled ? live.reacted : NO_REACTED;

  const push = useCallback((item: ChatItem) => {
    store.set(key, [...(store.get(key) ?? []), item]);
    emit();
  }, []);

  const send = useCallback(
    (text: string) => {
      if (liveEnabled) return live.send(text);
      const trimmed = text.trim();
      if (!trimmed) return;
      const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      push({ kind: "msg", id, mine: true, who: "", initial: "", text: trimmed, time: timeNow(), sending: true });
      setTimeout(() => {
        store.set(
          key,
          (store.get(key) ?? []).map((m) => (m.kind === "msg" && m.id === id ? { ...m, sending: false } : m))
        );
        emit();
      }, 700);
    },
    [liveEnabled, live, push]
  );

  const sendVoice = useCallback(
    (src: string, seconds: number) => {
      if (liveEnabled) return live.sendVoice(src, seconds);
      push({
        kind: "msg",
        id: `local-${Date.now()}`,
        mine: true,
        who: "",
        initial: "",
        voice: { dur: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, transcript: "", src },
        time: timeNow()
      });
    },
    [liveEnabled, live, push]
  );

  const toggleReaction = useCallback(
    (id: string, which: "ack" | "smile") => {
      if (liveEnabled) return live.toggleReaction(id, which);
      const set = new Set(mineReacted.get(key) ?? []);
      const k = `${id}:${which}`;
      if (set.has(k)) set.delete(k);
      else set.add(k);
      mineReacted.set(key, set);
      emit();
    },
    [liveEnabled, live]
  );

  return {
    items,
    reacted,
    send,
    sendVoice,
    toggleReaction,
    sample,
    live: liveEnabled,
    loaded: liveEnabled ? live.loaded : true,
    sendFailed: liveEnabled && live.sendFailed,
    rsvps: live.rsvps,
    answerRsvp: live.answerRsvp
  };
}

/** Fills the chat list's last lines for groups whose conversation is not open. */
export function useChatPreviews(groupIds: readonly string[], enabled: boolean) {
  const [, tick] = useState(0);
  const joined = groupIds.join(",");
  useEffect(() => subscribeChatPreviews(() => tick((n) => n + 1)), []);
  useEffect(() => {
    const client = enabled ? getBrowserSupabase() : null;
    if (!client) return;
    let active = true;
    for (const id of joined ? joined.split(",") : []) {
      if (!isUuid(id) || getChatPreview(id)) continue;
      void loadLatest(client, id).then((row) => {
        if (!active || !row) return;
        const text = row.kind === "voice" ? "…" : (row.body ?? "");
        if (text) setChatPreview(id, { text, time: clockLabel(new Date(row.created_at)) });
      });
    }
    return () => {
      active = false;
    };
  }, [joined, enabled]);
}

/** Last line for the chat list. */
export function previewFor(channelId: string, c: CommunityView, fallback: string): { text: string; time: string } {
  if (channelId === SAMPLE_CHANNEL_ID || c.mode === "sample") {
    const items = store.get(SAMPLE_CHANNEL_ID);
    const last = items ? [...items].reverse().find((i) => i.kind === "msg" || i.kind === "sys") : undefined;
    if (last?.kind === "msg") return { text: `${last.who ? `${last.who}: ` : ""}${last.text ?? (last.voice ? "…" : "")}`, time: last.time };
    if (last?.kind === "sys") return { text: last.text, time: "" };
    return { text: fallback, time: "" };
  }
  return getChatPreview(channelId) ?? { text: fallback, time: "" };
}

export function dayLabel(date: Date): string {
  const e = toEthiopic(date);
  return `${ETHIOPIC_MONTHS[e.month]} ${geez(e.day)}`;
}
