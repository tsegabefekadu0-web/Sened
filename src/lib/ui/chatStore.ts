"use client";

import { useCallback, useEffect, useState } from "react";

import { formatBirr, type CommunityView } from "./useCommunity";
import { ETHIOPIC_MONTHS, geez, toEthiopic } from "./geez";

/**
 * Community chat. TODO(backend): there is no chat table or route yet. Messages
 * live in memory for the open page (module-level, so they survive navigating
 * between the list and a channel, and are gone on reload). The sample channel is
 * a labelled demonstration; a real group's channel starts with system lines
 * drawn from its own ledger.
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

function liveItems(c: CommunityView): ChatItem[] {
  const rows = c.rows.filter((r) => r.kind !== "void").slice(-5);
  const out: ChatItem[] = [];
  let lastMonth = -1;
  for (const r of rows) {
    if (r.month !== lastMonth) {
      lastMonth = r.month;
      out.push({ kind: "day", id: `day-${r.month}`, label: ETHIOPIC_MONTHS[r.month] ?? "" });
    }
    out.push({ kind: "sys", id: `sys-${r.id}`, icon: "book", text: `${r.name} · ${formatBirr(r.amount)}`, href: "/ledger" });
  }
  return out;
}

export function timeNow(): string {
  const d = new Date();
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The items of one channel plus the actions on them. */
export function useChannel(channelId: string, c: CommunityView) {
  const [, tick] = useState(0);
  const sample = channelId === SAMPLE_CHANNEL_ID || c.mode === "sample";
  const key = sample ? SAMPLE_CHANNEL_ID : channelId;

  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  // Seed once; a live channel is seeded when its ledger has loaded.
  useEffect(() => {
    if (store.has(key)) return;
    if (sample) store.set(key, sampleItems());
    else if (c.mode === "live" || c.mode === "empty") store.set(key, liveItems(c));
    emit();
  }, [key, sample, c]);

  const items = store.get(key) ?? [];
  const reacted = mineReacted.get(key) ?? new Set<string>();

  const push = useCallback(
    (item: ChatItem) => {
      store.set(key, [...(store.get(key) ?? []), item]);
      emit();
    },
    [key]
  );

  const send = useCallback(
    (text: string) => {
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
    [key, push]
  );

  const sendVoice = useCallback(
    (src: string, seconds: number) => {
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
    [push]
  );

  const toggleReaction = useCallback(
    (id: string, which: "ack" | "smile") => {
      const set = new Set(mineReacted.get(key) ?? []);
      const k = `${id}:${which}`;
      if (set.has(k)) set.delete(k);
      else set.add(k);
      mineReacted.set(key, set);
      emit();
    },
    [key]
  );

  return { items, reacted, send, sendVoice, toggleReaction, sample };
}

/** Last line for the chat list. */
export function previewFor(channelId: string, c: CommunityView, fallback: string): { text: string; time: string } {
  const key = channelId === SAMPLE_CHANNEL_ID || c.mode === "sample" ? SAMPLE_CHANNEL_ID : channelId;
  const items = store.get(key);
  const last = items ? [...items].reverse().find((i) => i.kind === "msg" || i.kind === "sys") : undefined;
  if (last?.kind === "msg") return { text: `${last.who ? `${last.who}: ` : ""}${last.text ?? (last.voice ? "…" : "")}`, time: last.time };
  if (last?.kind === "sys") return { text: last.text, time: "" };
  return { text: fallback, time: "" };
}

export function dayLabel(date: Date): string {
  const e = toEthiopic(date);
  return `${ETHIOPIC_MONTHS[e.month]} ${geez(e.day)}`;
}
