import { describe, expect, it } from "vitest";

import type { ChatReactionRow, ChatRow } from "@/lib/chat/chatClient";
import { buildChannel, durationLabel, type BuildInput } from "@/lib/chat/items";
import { createTranslator } from "@/lib/i18n";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-0000000000aa";

function row(partial: Partial<ChatRow> & { id: string }): ChatRow {
  return {
    group_id: GROUP,
    author_id: OTHER,
    kind: "text",
    body: "selam",
    voice_path: null,
    voice_seconds: null,
    reply_to: null,
    meta: null,
    created_at: "2026-10-09T08:10:00.000Z",
    ...partial
  };
}

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    messages: [],
    reactions: [],
    pending: [],
    userId: ME,
    nameOf: (id) => (id === OTHER ? "Fatuma" : null),
    isTreasurer: (id) => id === OTHER,
    ledgerRows: new Map(),
    voiceUrls: new Map(),
    t: createTranslator("en"),
    formatBirr: (n) => String(n),
    ...over
  };
}

describe("buildChannel", () => {
  it("marks my own messages as mine and others with a name, initial and treasurer badge", () => {
    const { items } = buildChannel(input({ messages: [row({ id: "a" }), row({ id: "b", author_id: ME, body: "hi" })] }));
    const msgs = items.filter((i) => i.kind === "msg");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ mine: false, who: "Fatuma", initial: "F", badge: true, text: "selam" });
    expect(msgs[1]).toMatchObject({ mine: true, who: "", text: "hi" });
  });

  it("puts one day separator before messages of the same day", () => {
    const { items } = buildChannel(input({ messages: [row({ id: "a" }), row({ id: "b", created_at: "2026-10-09T08:11:00.000Z" })] }));
    expect(items.filter((i) => i.kind === "day")).toHaveLength(1);
  });

  it("renders a contribution line with the name and amount when the ledger row is known, generic otherwise", () => {
    const known = row({ id: "s1", author_id: null, kind: "ledger_ref", body: null, meta: { event: "contribution", entry_id: "e1" } });
    const unknown = row({ id: "s2", author_id: null, kind: "ledger_ref", body: null, meta: { event: "contribution", entry_id: "e2" } });
    const { items } = buildChannel(input({ messages: [known, unknown], ledgerRows: new Map([["e1", { name: "Almaz", amount: 5000 }]]) }));
    const sys = items.filter((i) => i.kind === "sys");
    expect(sys[0]).toMatchObject({ icon: "book", href: "/ledger", text: "Almaz paid 5000 Birr · confirmed" });
    expect(sys[1]).toMatchObject({ text: "A contribution was confirmed" });
  });

  it("renders a draw line linking to the draw, with the winner when known", () => {
    const r = row({ id: "d1", author_id: null, kind: "system", body: null, meta: { event: "draw", round: 3, winner_member_id: OTHER, payout_amount: "40000.00" } });
    const { items } = buildChannel(input({ messages: [r] }));
    expect(items.find((i) => i.kind === "sys")).toMatchObject({ icon: "draw", href: "/draw", text: "Draw result: Fatuma · 40000 Birr" });
  });

  it("counts other people's reactions and treats mine as pressed on top of the count", () => {
    const reactions: ChatReactionRow[] = [
      { message_id: "a", user_id: OTHER, reaction: "ack" },
      { message_id: "a", user_id: ME, reaction: "ack" },
      { message_id: "b", user_id: ME, reaction: "smile" }
    ];
    const { items, reacted } = buildChannel(input({ messages: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })], reactions }));
    const msgs = items.filter((i) => i.kind === "msg");
    expect(msgs[0]).toMatchObject({ react: { ack: 1 } });
    expect(msgs[1]).toMatchObject({ react: { smile: 0 } });
    expect(msgs[2]).toMatchObject({ react: undefined });
    expect(reacted.has("a:ack")).toBe(true);
    expect(reacted.has("b:smile")).toBe(true);
  });

  it("quotes the message being replied to, and gives a voice note its length and signed url", () => {
    const parent = row({ id: "p", body: "Please pay by month end" });
    const reply = row({ id: "r", author_id: ME, reply_to: "p", body: "ok" });
    const voice = row({ id: "v", kind: "voice", body: null, voice_path: `${GROUP}/v.webm`, voice_seconds: 75 });
    const { items } = buildChannel(input({ messages: [parent, reply, voice], voiceUrls: new Map([[`${GROUP}/v.webm`, "https://signed"]]) }));
    const msgs = items.filter((i) => i.kind === "msg");
    expect(msgs[1]).toMatchObject({ quote: { name: "Fatuma", text: "Please pay by month end" } });
    expect(msgs[2]).toMatchObject({ voice: { dur: "1:15", src: "https://signed" }, text: undefined });
  });

  it("shows queued messages as sending and drops one the server already returned", () => {
    const pending = [
      { id: "q1", groupId: GROUP, kind: "text" as const, body: "later", createdAt: "2026-10-09T09:00:00.000Z" },
      { id: "a", groupId: GROUP, kind: "text" as const, body: "dup", createdAt: "2026-10-09T09:00:00.000Z" }
    ];
    const { items } = buildChannel(input({ messages: [row({ id: "a" })], pending }));
    const msgs = items.filter((i) => i.kind === "msg");
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ id: "q1", mine: true, sending: true, text: "later" });
  });

  it("formats durations", () => {
    expect(durationLabel(0)).toBe("0:00");
    expect(durationLabel(9)).toBe("0:09");
    expect(durationLabel(600)).toBe("10:00");
  });
});
