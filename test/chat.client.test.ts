import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  addReaction,
  classifyWriteError,
  dataUrlToBlob,
  isUuid,
  loadHistory,
  removeReaction,
  sendMessage,
  setRsvp,
  uploadVoice,
  voiceExtension
} from "@/lib/chat/chatClient";

const GROUP = "00000000-0000-4000-8000-0000000000aa";

function fake(result: { error: { code?: string; message?: string } | null; data?: unknown } = { error: null }) {
  const calls: Array<{ table: string; op: string; arg?: unknown }> = [];
  const chain = (table: string, op: string, arg?: unknown) => {
    calls.push({ table, op, arg });
    const node: Record<string, unknown> = {
      eq: () => node,
      order: () => node,
      limit: () => Promise.resolve({ data: result.data ?? [], error: result.error }),
      then: (resolve: (v: unknown) => unknown) => resolve(result)
    };
    return node;
  };
  const client = {
    from: (table: string) => ({
      insert: (row: unknown) => chain(table, "insert", row),
      upsert: (row: unknown) => chain(table, "upsert", row),
      delete: () => chain(table, "delete"),
      select: () => chain(table, "select")
    })
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("classifyWriteError", () => {
  it("treats no error and a duplicate id as success (idempotent send)", () => {
    expect(classifyWriteError(null)).toEqual({ ok: true });
    expect(classifyWriteError({ code: "23505" })).toEqual({ ok: true });
  });
  it("retries network faults, throttles and 5xx, but not a refusal by RLS or a check", () => {
    expect(classifyWriteError({ message: "TypeError: Failed to fetch" })).toMatchObject({ ok: false, retryable: true });
    expect(classifyWriteError({ code: "54000", message: "chat_rate_limited" })).toMatchObject({ ok: false, retryable: true, code: "rate_limited" });
    expect(classifyWriteError({ code: "500" })).toMatchObject({ ok: false, retryable: true });
    expect(classifyWriteError({ code: "42501" })).toMatchObject({ ok: false, retryable: false });
    expect(classifyWriteError({ code: "23514" })).toMatchObject({ ok: false, retryable: false });
  });
});

describe("chat writes", () => {
  it("sends a text message with the sender's id and never an author_id", async () => {
    const { client, calls } = fake();
    const result = await sendMessage(client, { id: "m1", groupId: GROUP, kind: "text", body: "selam", replyTo: "p1" });
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ table: "chat_messages", op: "insert", arg: { id: "m1", group_id: GROUP, kind: "text", body: "selam", reply_to: "p1" } });
    expect(calls[0].arg).not.toHaveProperty("author_id");
  });

  it("caps an over-long body at 2000 characters", async () => {
    const { client, calls } = fake();
    await sendMessage(client, { id: "m1", groupId: GROUP, kind: "text", body: "x".repeat(2500) });
    expect(((calls[0].arg as { body: string }).body).length).toBe(2000);
  });

  it("reports a rejected insert as not retryable and a thrown fetch as retryable", async () => {
    const { client } = fake({ error: { code: "42501", message: "rls" } });
    expect(await sendMessage(client, { id: "m", groupId: GROUP, kind: "text", body: "x" })).toMatchObject({ ok: false, retryable: false });
    const throwing = { from: () => ({ insert: () => { throw new Error("offline"); } }) } as unknown as SupabaseClient;
    expect(await sendMessage(throwing, { id: "m", groupId: GROUP, kind: "text", body: "x" })).toMatchObject({ ok: false, retryable: true });
  });

  it("adds and removes reactions and upserts an RSVP on the member's own row", async () => {
    const { client, calls } = fake();
    await addReaction(client, GROUP, "m1", "ack");
    await removeReaction(client, "u1", "m1", "ack");
    await setRsvp(client, GROUP, "m1", "yes");
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual(["chat_reactions:insert", "chat_reactions:delete", "chat_rsvps:upsert"]);
    expect(calls[0].arg).not.toHaveProperty("user_id");
    expect(calls[2].arg).not.toHaveProperty("user_id");
  });
});

describe("loadHistory", () => {
  it("returns messages oldest first", async () => {
    const rows = [
      { id: "b", created_at: "2026-10-09T10:00:00Z" },
      { id: "a", created_at: "2026-10-09T09:00:00Z" }
    ];
    const { client } = fake({ error: null, data: rows });
    const snap = await loadHistory(client, GROUP);
    expect(snap?.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("returns null when the read fails", async () => {
    const { client } = fake({ error: { code: "500" }, data: null });
    expect(await loadHistory(client, GROUP)).toBeNull();
  });
});

describe("voice upload", () => {
  it("decodes a data URL and picks an extension from the type", () => {
    const blob = dataUrlToBlob("data:audio/webm;codecs=opus;base64,AAEC");
    expect(blob?.type).toBe("audio/webm");
    expect(blob?.size).toBe(3);
    expect(dataUrlToBlob("not a data url")).toBeNull();
    expect(voiceExtension("audio/ogg")).toBe("ogg");
    expect(voiceExtension("audio/mp4")).toBe("m4a");
    expect(voiceExtension("audio/webm")).toBe("webm");
  });

  it("uploads under the group's folder in the private bucket", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ upload }));
    const client = { storage: { from } } as unknown as SupabaseClient;
    const result = await uploadVoice(client, GROUP, "m1", new Blob(["x"], { type: "audio/webm;codecs=opus" }));
    expect(result).toEqual({ ok: true, path: `${GROUP}/m1.webm` });
    expect(from).toHaveBeenCalledWith("chat-voice");
    expect(upload).toHaveBeenCalledWith(`${GROUP}/m1.webm`, expect.any(Blob), { contentType: "audio/webm", upsert: true });
  });

  it("does not retry an upload the bucket refuses", async () => {
    const upload = vi.fn().mockResolvedValue({ error: { statusCode: "403", message: "denied" } });
    const client = { storage: { from: () => ({ upload }) } } as unknown as SupabaseClient;
    expect(await uploadVoice(client, GROUP, "m1", new Blob(["x"], { type: "audio/webm" }))).toMatchObject({ ok: false, retryable: false });
  });
});

describe("isUuid", () => {
  it("accepts uuids and rejects the sample channel", () => {
    expect(isUuid(GROUP)).toBe(true);
    expect(isUuid("sample")).toBe(false);
  });
});
