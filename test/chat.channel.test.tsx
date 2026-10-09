import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const GROUP = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const h = vi.hoisted(() => ({
  session: { status: "signed-in", accessToken: "t", email: "a@b.c", userId: "00000000-0000-4000-8000-000000000001" } as unknown,
  history: [] as unknown[],
  inserted: [] as unknown[],
  insertError: null as null | { code?: string; message?: string },
  realtime: null as null | ((p: { new: unknown }) => void),
  removed: 0
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => h.session }));
vi.mock("@/lib/auth/browserClient", () => {
  const client = {
    from: (table: string) => ({
      select: () => {
        const node: Record<string, unknown> = {
          eq: () => node,
          order: () => node,
          limit: () => Promise.resolve({ data: table === "chat_messages" ? h.history : [], error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
        };
        return node;
      },
      insert: (row: unknown) => {
        h.inserted.push({ table, row });
        return Promise.resolve({ error: h.insertError });
      }
    }),
    channel: () => {
      const ch = {
        on: (_t: string, cfg: { table: string }, cb: (p: { new: unknown }) => void) => {
          if (cfg.table === "chat_messages") h.realtime = cb;
          return ch;
        },
        subscribe: () => ch
      };
      return ch;
    },
    removeChannel: () => {
      h.removed += 1;
    },
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: { message: "x" } }) }) }
  };
  return { getBrowserSupabase: () => client, getAccessToken: async () => "t" };
});

import { SAMPLE_CHANNEL_ID, useChannel } from "@/lib/ui/chatStore";
import type { CommunityView } from "@/lib/ui/useCommunity";

const community = {
  mode: "live",
  groupId: GROUP,
  groupName: "Equb",
  role: "member",
  members: [{ id: OTHER, name: "Fatuma", initial: "F", role: "member", isMe: false, status: "paid" }],
  rows: [],
  pot: 0,
  cycle: null,
  userId: ME,
  email: null,
  accessToken: "t",
  reload: () => undefined
} as unknown as CommunityView;

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    group_id: GROUP,
    author_id: OTHER,
    kind: "text",
    body: `hello ${id}`,
    voice_path: null,
    voice_seconds: null,
    reply_to: null,
    meta: null,
    created_at: "2026-10-09T08:10:00.000Z",
    ...over
  };
}

beforeEach(() => {
  h.session = { status: "signed-in", accessToken: "t", email: "a@b.c", userId: ME };
  h.history = [];
  h.inserted = [];
  h.insertError = null;
  h.realtime = null;
  h.removed = 0;
  window.localStorage.clear();
});

describe("useChannel", () => {
  it("keeps the sample channel in memory without touching the database when signed out", async () => {
    h.session = { status: "signed-out" };
    const { result } = renderHook(() => useChannel(SAMPLE_CHANNEL_ID, { ...community, mode: "sample" } as CommunityView));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(5));
    expect(result.current.sample).toBe(true);
    act(() => result.current.send("a demo line"));
    expect(result.current.items.some((i) => i.kind === "msg" && i.text === "a demo line")).toBe(true);
    expect(h.inserted).toHaveLength(0);
  });

  it("loads a real group's history and appends a message that arrives over Realtime", async () => {
    h.history = [row("m2", { created_at: "2026-10-09T08:12:00.000Z" }), row("m1")];
    const { result } = renderHook(() => useChannel(GROUP, community));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.sample).toBe(false);
    const texts = () => result.current.items.filter((i) => i.kind === "msg").map((i) => (i.kind === "msg" ? i.text : ""));
    expect(texts()).toEqual(["hello m1", "hello m2"]);
    expect(result.current.items.find((i) => i.kind === "msg")).toMatchObject({ who: "Fatuma" });

    act(() => h.realtime?.({ new: row("m3", { created_at: "2026-10-09T08:13:00.000Z" }) }));
    expect(texts()).toEqual(["hello m1", "hello m2", "hello m3"]);
    // The same row delivered twice is shown once.
    act(() => h.realtime?.({ new: row("m3") }));
    expect(texts()).toHaveLength(3);
  });

  it("sends through the outbox: shown as sending, inserted as the member, then cleared on success", async () => {
    const { result } = renderHook(() => useChannel(GROUP, community));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.send("  salam  "));
    await waitFor(() => expect(h.inserted).toHaveLength(1));
    const sent = h.inserted[0] as { table: string; row: Record<string, unknown> };
    expect(sent.table).toBe("chat_messages");
    expect(sent.row).toMatchObject({ group_id: GROUP, kind: "text", body: "salam" });
    expect(sent.row).not.toHaveProperty("author_id");
    await waitFor(() => expect(window.localStorage.getItem("sened.chat.outbox.v1")).toBeNull());
  });

  it("keeps a message that could not be sent while offline, still shown as sending", async () => {
    h.insertError = { message: "Failed to fetch" };
    const { result } = renderHook(() => useChannel(GROUP, community));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.send("later"));
    await waitFor(() => expect(h.inserted).toHaveLength(1));
    const pending = result.current.items.filter((i) => i.kind === "msg" && i.sending);
    expect(pending).toHaveLength(1);
    expect(window.localStorage.getItem("sened.chat.outbox.v1")).toContain("later");
    expect(result.current.sendFailed).toBe(false);
  });

  it("tears the Realtime channel down on unmount", async () => {
    const { result, unmount } = renderHook(() => useChannel(GROUP, community));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    unmount();
    expect(h.removed).toBe(1);
  });
});
