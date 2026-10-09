import { describe, expect, it, vi } from "vitest";

import type { SendResult } from "@/lib/chat/chatClient";
import { ChatOutbox, OUTBOX_STORAGE_KEY, type PendingMessage } from "@/lib/chat/outbox";

const GROUP = "g1";

function text(id: string, body = id): PendingMessage {
  return { id, groupId: GROUP, kind: "text", body, createdAt: "2026-10-09T09:00:00.000Z" };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v)
  };
}

describe("ChatOutbox", () => {
  it("delivers in order and empties on success", async () => {
    const box = new ChatOutbox(null);
    box.add(text("a"));
    box.add(text("b"));
    const order: string[] = [];
    const report = await box.flush(GROUP, async (m) => (order.push(m.id), { ok: true } as SendResult));
    expect(order).toEqual(["a", "b"]);
    expect(report.sent).toEqual(["a", "b"]);
    expect(box.list(GROUP)).toHaveLength(0);
  });

  it("stops at the first retryable failure and keeps the rest in order", async () => {
    const box = new ChatOutbox(null);
    box.add(text("a"));
    box.add(text("b"));
    box.add(text("c"));
    const deliver = vi.fn(async (m: PendingMessage): Promise<SendResult> => (m.id === "b" ? { ok: false, retryable: true, code: "network" } : { ok: true }));
    const report = await box.flush(GROUP, deliver);
    expect(report.sent).toEqual(["a"]);
    expect(report.kept).toEqual(["b", "c"]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(box.list(GROUP).map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("drops a message the server refuses for good and carries on", async () => {
    const box = new ChatOutbox(null);
    box.add(text("bad"));
    box.add(text("good"));
    const report = await box.flush(GROUP, async (m) => (m.id === "bad" ? { ok: false, retryable: false, code: "42501" } : { ok: true }));
    expect(report.dropped).toEqual(["bad"]);
    expect(report.sent).toEqual(["good"]);
    expect(box.list(GROUP)).toHaveLength(0);
  });

  it("does not add the same id twice, and shares one run between concurrent flushes", async () => {
    const box = new ChatOutbox(null);
    expect(box.add(text("a"))).toBe(true);
    expect(box.add(text("a"))).toBe(false);
    const deliver = vi.fn(async (): Promise<SendResult> => ({ ok: true }));
    await Promise.all([box.flush(GROUP, deliver), box.flush(GROUP, deliver)]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps text across a reload but never persists voice audio", () => {
    const storage = memoryStorage();
    const box = new ChatOutbox(storage);
    box.add(text("a", "salam"));
    box.add({ id: "v", groupId: GROUP, kind: "voice", voiceData: "data:audio/webm;base64,AAAA", voiceSeconds: 3, createdAt: "2026-10-09T09:00:00.000Z" });
    const raw = storage.getItem(OUTBOX_STORAGE_KEY) ?? "";
    expect(raw).toContain("salam");
    expect(raw).not.toContain("AAAA");
    const reloaded = new ChatOutbox(storage);
    expect(reloaded.list(GROUP).map((m) => m.id)).toEqual(["a"]);
  });

  it("ignores corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem(OUTBOX_STORAGE_KEY, "{not json");
    expect(new ChatOutbox(storage).list(GROUP)).toEqual([]);
  });
});
