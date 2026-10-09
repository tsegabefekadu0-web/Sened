"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getBrowserSupabase } from "@/lib/auth/browserClient";
import type { ChatItem } from "@/lib/ui/chatStore";
import type { CommunityView } from "@/lib/ui/useCommunity";
import { formatBirr } from "@/lib/ui/useCommunity";

import {
  addReaction,
  dataUrlToBlob,
  loadExtras,
  loadHistory,
  newMessageId,
  removeReaction,
  sendMessage,
  setRsvp as writeRsvp,
  signVoice,
  subscribeToGroup,
  uploadVoice,
  type ChatReactionRow,
  type ChatRow,
  type ChatRsvpRow,
  type ReactionKind,
  type SendResult
} from "./chatClient";
import { buildChannel, type Translate } from "./items";
import { getChatOutbox, type PendingMessage } from "./outbox";
import { setChatPreview } from "./preview";

const RETRY_MS = 15_000;

export interface LiveChannel {
  readonly items: ChatItem[];
  readonly reacted: Set<string>;
  readonly send: (text: string, replyTo?: string | null) => void;
  readonly sendVoice: (src: string, seconds: number) => void;
  readonly toggleReaction: (id: string, which: ReactionKind) => void;
  /** The signed-in member's answer on a message, by message id. */
  readonly rsvps: ReadonlyMap<string, "yes" | "no">;
  readonly answerRsvp: (messageId: string, response: "yes" | "no") => void;
  readonly loaded: boolean;
  /** Set when a message was refused for good (not merely waiting for a connection). */
  readonly sendFailed: boolean;
}

function mergeMessage(list: readonly ChatRow[], row: ChatRow): readonly ChatRow[] {
  if (list.some((m) => m.id === row.id)) return list;
  const next = [...list, row];
  next.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  return next;
}

/** A real group's conversation: history, Realtime, and a send queue that survives being offline. */
export function useLiveChannel(
  groupId: string,
  enabled: boolean,
  userId: string | null,
  c: CommunityView,
  t: Translate
): LiveChannel {
  const [messages, setMessages] = useState<readonly ChatRow[]>([]);
  const [reactions, setReactions] = useState<readonly ChatReactionRow[]>([]);
  const [rsvpRows, setRsvpRows] = useState<readonly ChatRsvpRow[]>([]);
  const [voiceUrls, setVoiceUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [version, bump] = useState(0);
  const signing = useRef(new Set<string>());
  const outbox = getChatOutbox();

  const client = enabled ? getBrowserSupabase() : null;

  useEffect(() => outbox.subscribe(() => bump((n) => n + 1)), [outbox]);

  const deliver = useCallback(
    async (m: PendingMessage): Promise<SendResult> => {
      if (!client) return { ok: false, retryable: true, code: "unconfigured" };
      if (m.kind === "text") {
        return sendMessage(client, { id: m.id, groupId: m.groupId, kind: "text", body: m.body, replyTo: m.replyTo });
      }
      const blob = m.voiceData ? dataUrlToBlob(m.voiceData) : null;
      if (!blob) return { ok: false, retryable: false, code: "no_audio" };
      const up = await uploadVoice(client, m.groupId, m.id, blob);
      if (!up.ok) return { ok: false, retryable: up.retryable, code: up.code };
      return sendMessage(client, {
        id: m.id,
        groupId: m.groupId,
        kind: "voice",
        voicePath: up.path,
        voiceSeconds: m.voiceSeconds,
        replyTo: m.replyTo
      });
    },
    [client]
  );

  const flush = useCallback(async () => {
    if (!client) return;
    const report = await outbox.flush(groupId, deliver);
    if (report.dropped.length > 0) setSendFailed(true);
  }, [client, outbox, groupId, deliver]);

  // History, Realtime, and the retry triggers for one group.
  useEffect(() => {
    if (!client || !enabled) return;
    let active = true;
    setLoaded(false);
    setMessages([]);
    setReactions([]);
    setRsvpRows([]);
    void loadHistory(client, groupId).then((snap) => {
      if (!active) return;
      if (snap) {
        setMessages(snap.messages);
        setReactions(snap.reactions);
        setRsvpRows(snap.rsvps);
      }
      setLoaded(true);
      void flush();
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToGroup(client, groupId, {
      onMessage: (row) => {
        if (active) setMessages((list) => mergeMessage(list, row));
      },
      onExtrasChanged: () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void loadExtras(client, groupId).then((x) => {
            if (!active) return;
            setReactions(x.reactions);
            setRsvpRows(x.rsvps);
          });
        }, 150);
      }
    });
    const onOnline = () => {
      void flush();
      void loadHistory(client, groupId).then((snap) => {
        if (active && snap) {
          setMessages((list) => snap.messages.reduce(mergeMessage, list));
          setReactions(snap.reactions);
          setRsvpRows(snap.rsvps);
        }
      });
    };
    window.addEventListener("online", onOnline);
    const interval = setInterval(() => void flush(), RETRY_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      unsubscribe();
    };
  }, [client, enabled, groupId, flush]);

  // Signed URLs for voice notes as they appear.
  useEffect(() => {
    if (!client) return;
    for (const m of messages) {
      const path = m.voice_path;
      if (!path || voiceUrls.has(path) || signing.current.has(path)) continue;
      signing.current.add(path);
      void signVoice(client, path).then((url) => {
        signing.current.delete(path);
        if (url) setVoiceUrls((prev) => new Map(prev).set(path, url));
      });
    }
  }, [client, messages, voiceUrls]);

  const members = c.groupId === groupId ? c.members : [];
  const ledgerRows = useMemo(() => {
    const map = new Map<string, { name: string; amount: number }>();
    if (c.groupId === groupId) for (const r of c.rows) map.set(r.id, { name: r.name, amount: r.amount });
    return map;
  }, [c.groupId, c.rows, groupId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pending = useMemo(() => outbox.list(groupId), [outbox, groupId, version]);
  const built = useMemo(
    () =>
      buildChannel({
        messages,
        reactions,
        pending,
        userId,
        nameOf: (id) => members.find((m) => m.id === id)?.name ?? null,
        isTreasurer: (id) => members.find((m) => m.id === id)?.role === "treasurer",
        ledgerRows,
        voiceUrls,
        t,
        formatBirr
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, reactions, pending, userId, c.members, c.groupId, groupId, ledgerRows, voiceUrls, t]
  );

  // Keep the chat list's last line current for the open conversation.
  useEffect(() => {
    const last = [...built.items].reverse().find((i) => i.kind === "msg" || i.kind === "sys");
    if (!last) return;
    if (last.kind === "msg") setChatPreview(groupId, { text: `${last.who ? `${last.who}: ` : ""}${last.text ?? (last.voice ? "…" : "")}`, time: last.time });
    else if (last.kind === "sys") setChatPreview(groupId, { text: last.text, time: "" });
  }, [built.items, groupId]);

  const enqueue = useCallback(
    (m: Omit<PendingMessage, "id" | "groupId" | "createdAt">) => {
      setSendFailed(false);
      outbox.add({ ...m, id: newMessageId(), groupId, createdAt: new Date().toISOString() });
      void flush();
    },
    [outbox, groupId, flush]
  );

  const send = useCallback(
    (text: string, replyTo?: string | null) => {
      const body = text.trim();
      if (!body) return;
      enqueue({ kind: "text", body, replyTo: replyTo ?? null });
    },
    [enqueue]
  );

  const sendVoice = useCallback(
    (src: string, seconds: number) => enqueue({ kind: "voice", voiceData: src, voiceSeconds: Math.max(1, Math.min(600, Math.round(seconds))) }),
    [enqueue]
  );

  const toggleReaction = useCallback(
    (messageId: string, which: ReactionKind) => {
      if (!client || !userId) return;
      const has = reactions.some((r) => r.message_id === messageId && r.user_id === userId && r.reaction === which);
      const refresh = () => void loadExtras(client, groupId).then((x) => (setReactions(x.reactions), setRsvpRows(x.rsvps)));
      if (has) {
        setReactions((list) => list.filter((r) => !(r.message_id === messageId && r.user_id === userId && r.reaction === which)));
        void removeReaction(client, userId, messageId, which).then((r) => (r.ok ? undefined : refresh()));
      } else {
        setReactions((list) => [...list, { message_id: messageId, user_id: userId, reaction: which }]);
        void addReaction(client, groupId, messageId, which).then((r) => (r.ok ? undefined : refresh()));
      }
    },
    [client, userId, reactions, groupId]
  );

  const rsvps = useMemo(() => {
    const map = new Map<string, "yes" | "no">();
    for (const r of rsvpRows) if (userId !== null && r.user_id === userId) map.set(r.message_id, r.response);
    return map;
  }, [rsvpRows, userId]);

  const answerRsvp = useCallback(
    (messageId: string, response: "yes" | "no") => {
      if (!client || !userId) return;
      setRsvpRows((list) => [...list.filter((r) => !(r.message_id === messageId && r.user_id === userId)), { message_id: messageId, user_id: userId, response }]);
      void writeRsvp(client, groupId, messageId, response).then((r) => {
        if (!r.ok) void loadExtras(client, groupId).then((x) => setRsvpRows(x.rsvps));
      });
    },
    [client, userId, groupId]
  );

  return { items: built.items, reacted: built.reacted, send, sendVoice, toggleReaction, rsvps, answerRsvp, loaded, sendFailed };
}
