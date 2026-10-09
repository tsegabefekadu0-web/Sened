import type { ChatItem } from "@/lib/ui/chatStore";
import { ETHIOPIC_MONTHS, geez, toEthiopic } from "@/lib/ui/geez";

import type { ChatReactionRow, ChatRow, ReactionKind } from "./chatClient";
import type { PendingMessage } from "./outbox";

/** Turns stored chat rows into the items the conversation screen draws. */

export type Translate = (key: "ui.chat.sys.contribution" | "ui.chat.sys.contributionNamed" | "ui.chat.sys.draw" | "ui.chat.sys.drawNamed", vars?: Record<string, string | number>) => string;

export interface BuildInput {
  readonly messages: readonly ChatRow[];
  readonly reactions: readonly ChatReactionRow[];
  readonly pending: readonly PendingMessage[];
  readonly userId: string | null;
  /** A member's display name, or null when not known. */
  readonly nameOf: (userId: string) => string | null;
  readonly isTreasurer: (userId: string) => boolean;
  /** Ledger rows by entry id, to put a name and amount on a contribution line. */
  readonly ledgerRows: ReadonlyMap<string, { readonly name: string; readonly amount: number }>;
  /** Signed URLs for voice notes, by storage path. */
  readonly voiceUrls: ReadonlyMap<string, string>;
  readonly t: Translate;
  readonly formatBirr: (amount: number) => string;
}

export interface BuiltChannel {
  readonly items: ChatItem[];
  /** `<messageId>:<kind>` for each reaction the signed-in member has set. */
  readonly reacted: Set<string>;
}

export function clockLabel(date: Date): string {
  return `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function dayKey(date: Date): string {
  const e = toEthiopic(date);
  return `${e.year}-${e.month}-${e.day}`;
}

export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toLocaleUpperCase() : "?";
}

function systemItem(row: ChatRow, input: BuildInput): ChatItem | null {
  const meta = row.meta ?? {};
  const event = typeof meta.event === "string" ? meta.event : "";
  if (event === "contribution") {
    const entryId = typeof meta.entry_id === "string" ? meta.entry_id : "";
    const known = input.ledgerRows.get(entryId);
    const text = known
      ? input.t("ui.chat.sys.contributionNamed", { name: known.name, amount: input.formatBirr(known.amount) })
      : input.t("ui.chat.sys.contribution");
    return { kind: "sys", id: row.id, icon: "book", text, href: "/ledger" };
  }
  if (event === "draw") {
    const winner = typeof meta.winner_member_id === "string" ? input.nameOf(meta.winner_member_id) : null;
    const payout = typeof meta.payout_amount === "string" ? Number(meta.payout_amount) : NaN;
    const text =
      winner && Number.isFinite(payout)
        ? input.t("ui.chat.sys.drawNamed", { name: winner, amount: input.formatBirr(payout) })
        : input.t("ui.chat.sys.draw", { round: typeof meta.round === "number" ? meta.round : "" });
    return { kind: "sys", id: row.id, icon: "draw", text, href: "/draw" };
  }
  if (row.body) {
    return { kind: "sys", id: row.id, icon: "book", text: row.body, href: "/ledger" };
  }
  return null;
}

export function buildChannel(input: BuildInput): BuiltChannel {
  const items: ChatItem[] = [];
  const reacted = new Set<string>();
  const others = new Map<string, { ack: number; smile: number }>();
  for (const r of input.reactions) {
    if (input.userId !== null && r.user_id === input.userId) {
      reacted.add(`${r.message_id}:${r.reaction}`);
      continue;
    }
    const entry = others.get(r.message_id) ?? { ack: 0, smile: 0 };
    entry[r.reaction as ReactionKind] += 1;
    others.set(r.message_id, entry);
  }

  const byId = new Map(input.messages.map((m) => [m.id, m]));
  const seen = new Set(input.messages.map((m) => m.id));
  let lastDay = "";

  const pushDay = (date: Date, id: string) => {
    const key = dayKey(date);
    if (key === lastDay) return;
    lastDay = key;
    const e = toEthiopic(date);
    items.push({ kind: "day", id: `day-${id}`, label: `${ETHIOPIC_MONTHS[e.month] ?? ""} ${geez(e.day)}` });
  };

  const quoteOf = (replyTo: string | null | undefined) => {
    if (!replyTo) return undefined;
    const parent = byId.get(replyTo);
    if (!parent) return undefined;
    const name = parent.author_id ? (input.nameOf(parent.author_id) ?? "") : "";
    const text = parent.body ?? "";
    const clipped = Array.from(text).length > 60 ? `${Array.from(text).slice(0, 60).join("")}…` : text;
    return { name, text: clipped };
  };

  for (const row of input.messages) {
    const date = new Date(row.created_at);
    const valid = !Number.isNaN(date.getTime());
    if (row.kind === "system" || row.kind === "ledger_ref") {
      const item = systemItem(row, input);
      if (item) {
        if (valid) pushDay(date, row.id);
        items.push(item);
      }
      continue;
    }
    if (valid) pushDay(date, row.id);
    const mine = input.userId !== null && row.author_id === input.userId;
    const name = row.author_id ? (input.nameOf(row.author_id) ?? "") : "";
    const counts = others.get(row.id);
    const react: { ack?: number; smile?: number } = {};
    for (const kind of ["ack", "smile"] as const) {
      if ((counts && counts[kind] > 0) || reacted.has(`${row.id}:${kind}`)) react[kind] = counts?.[kind] ?? 0;
    }
    const voiceSrc = row.voice_path ? input.voiceUrls.get(row.voice_path) : undefined;
    items.push({
      kind: "msg",
      id: row.id,
      mine,
      who: mine ? "" : name,
      initial: mine ? "" : initialOf(name),
      badge: !mine && row.author_id !== null && input.isTreasurer(row.author_id) ? true : undefined,
      text: row.kind === "voice" ? undefined : (row.body ?? undefined),
      quote: quoteOf(row.reply_to),
      voice:
        row.kind === "voice"
          ? { dur: durationLabel(row.voice_seconds ?? 0), transcript: "", src: voiceSrc }
          : undefined,
      time: valid ? clockLabel(date) : "",
      react: Object.keys(react).length > 0 ? react : undefined
    });
  }

  for (const p of input.pending) {
    if (seen.has(p.id)) continue;
    const date = new Date(p.createdAt);
    pushDay(date, p.id);
    items.push({
      kind: "msg",
      id: p.id,
      mine: true,
      who: "",
      initial: "",
      text: p.kind === "text" ? p.body : undefined,
      quote: quoteOf(p.replyTo),
      voice: p.kind === "voice" ? { dur: durationLabel(p.voiceSeconds ?? 0), transcript: "", src: p.voiceData } : undefined,
      time: clockLabel(date),
      sending: true
    });
  }

  return { items, reacted };
}
