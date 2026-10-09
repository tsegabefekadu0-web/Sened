import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Community chat, talking to Supabase directly under the member's own JWT.
 *
 * Row Level Security is the boundary (see `20261016100000_chat_backend.sql`):
 * only active members of a group read or write its chat, an author can only
 * insert as themselves, `system` / `ledger_ref` lines are written by database
 * triggers, and `chat_messages` has no update or delete. Nothing here is
 * trusted by the database; it only shapes requests and responses.
 */

export const VOICE_BUCKET = "chat-voice";
export const MAX_BODY_LENGTH = 2000;
export const HISTORY_LIMIT = 200;

export type ChatKind = "text" | "voice" | "system" | "ledger_ref" | "invite";
export type ReactionKind = "ack" | "smile";

export interface ChatRow {
  readonly id: string;
  readonly group_id: string;
  readonly author_id: string | null;
  readonly kind: ChatKind;
  readonly body: string | null;
  readonly voice_path: string | null;
  readonly voice_seconds: number | null;
  readonly reply_to: string | null;
  readonly meta: Record<string, unknown> | null;
  readonly created_at: string;
}

export interface ChatReactionRow {
  readonly message_id: string;
  readonly user_id: string;
  readonly reaction: ReactionKind;
}

export interface ChatRsvpRow {
  readonly message_id: string;
  readonly user_id: string;
  readonly response: "yes" | "no";
}

export interface ChatSnapshot {
  readonly messages: readonly ChatRow[];
  readonly reactions: readonly ChatReactionRow[];
  readonly rsvps: readonly ChatRsvpRow[];
}

export type SendResult =
  | { readonly ok: true }
  /** `retryable` means a later attempt can succeed (offline, throttled, server down). */
  | { readonly ok: false; readonly retryable: boolean; readonly code: string };

const MESSAGE_COLUMNS = "id, group_id, author_id, kind, body, voice_path, voice_seconds, reply_to, meta, created_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** The latest messages of a group, oldest first, with their reactions and RSVPs. */
export async function loadHistory(client: SupabaseClient, groupId: string, limit = HISTORY_LIMIT): Promise<ChatSnapshot | null> {
  try {
    const { data, error } = await client
      .from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("group_id", groupId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error || !data) return null;
    const messages = [...(data as ChatRow[])].reverse();
    const extras = await loadExtras(client, groupId);
    return { messages, reactions: extras.reactions, rsvps: extras.rsvps };
  } catch {
    return null;
  }
}

/** Reactions and RSVPs of a group. A failure reads as "none yet" so messages still show. */
export async function loadExtras(
  client: SupabaseClient,
  groupId: string
): Promise<{ reactions: readonly ChatReactionRow[]; rsvps: readonly ChatRsvpRow[] }> {
  try {
    const [reactions, rsvps] = await Promise.all([
      client.from("chat_reactions").select("message_id, user_id, reaction").eq("group_id", groupId),
      client.from("chat_rsvps").select("message_id, user_id, response").eq("group_id", groupId)
    ]);
    return {
      reactions: (reactions.data as ChatReactionRow[] | null) ?? [],
      rsvps: (rsvps.data as ChatRsvpRow[] | null) ?? []
    };
  } catch {
    return { reactions: [], rsvps: [] };
  }
}

/** The newest message of a group, for the chat list preview. */
export async function loadLatest(client: SupabaseClient, groupId: string): Promise<ChatRow | null> {
  try {
    const { data, error } = await client
      .from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("group_id", groupId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as ChatRow;
  } catch {
    return null;
  }
}

interface ErrorLike {
  readonly code?: string;
  readonly message?: string;
}

/**
 * A failed write is retried only when it says nothing about the payload: no
 * server code at all (the network), a throttle, or a 5xx. A duplicate id means an
 * earlier attempt already landed, which is success for an idempotent send.
 */
export function classifyWriteError(error: ErrorLike | null | undefined): SendResult {
  if (!error) return { ok: true };
  const code = error.code ?? "";
  if (code === "23505") return { ok: true };
  if (code === "54000" || /rate_limited/.test(error.message ?? "")) return { ok: false, retryable: true, code: "rate_limited" };
  if (code === "" || /fetch|network|timeout|offline/i.test(error.message ?? "")) return { ok: false, retryable: true, code: "network" };
  if (/^5/.test(code) || code === "PGRST000" || code === "PGRST001" || code === "PGRST002") return { ok: false, retryable: true, code };
  return { ok: false, retryable: false, code };
}

async function guard(run: () => PromiseLike<{ error: ErrorLike | null }>): Promise<SendResult> {
  try {
    const result = await run();
    return classifyWriteError(result.error);
  } catch {
    return { ok: false, retryable: true, code: "network" };
  }
}

export interface OutgoingMessage {
  /** Chosen by the sender so a retry cannot post twice. */
  readonly id: string;
  readonly groupId: string;
  readonly kind: "text" | "voice";
  readonly body?: string;
  readonly replyTo?: string | null;
  readonly voicePath?: string;
  readonly voiceSeconds?: number;
}

export function sendMessage(client: SupabaseClient, m: OutgoingMessage): Promise<SendResult> {
  const row: Record<string, unknown> = { id: m.id, group_id: m.groupId, kind: m.kind };
  if (m.body !== undefined) row.body = m.body.slice(0, MAX_BODY_LENGTH);
  if (m.replyTo) row.reply_to = m.replyTo;
  if (m.voicePath) row.voice_path = m.voicePath;
  if (m.voiceSeconds !== undefined) row.voice_seconds = m.voiceSeconds;
  return guard(() => client.from("chat_messages").insert(row));
}

export function addReaction(client: SupabaseClient, groupId: string, messageId: string, reaction: ReactionKind): Promise<SendResult> {
  return guard(() => client.from("chat_reactions").insert({ message_id: messageId, group_id: groupId, reaction }));
}

export function removeReaction(client: SupabaseClient, userId: string, messageId: string, reaction: ReactionKind): Promise<SendResult> {
  return guard(() =>
    client.from("chat_reactions").delete().eq("message_id", messageId).eq("user_id", userId).eq("reaction", reaction)
  );
}

export function setRsvp(client: SupabaseClient, groupId: string, messageId: string, response: "yes" | "no"): Promise<SendResult> {
  return guard(() =>
    client
      .from("chat_rsvps")
      .upsert(
        { message_id: messageId, group_id: groupId, response, updated_at: new Date().toISOString() },
        { onConflict: "message_id,user_id" }
      )
  );
}

/** `data:audio/webm;base64,...` to a Blob, or null if it is not a data URL. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return null;
  }
}

export function voiceExtension(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

/** Uploads a voice note under the group's folder and returns its storage path. */
export async function uploadVoice(
  client: SupabaseClient,
  groupId: string,
  messageId: string,
  blob: Blob
): Promise<{ ok: true; path: string } | { ok: false; retryable: boolean; code: string }> {
  const baseType = blob.type.split(";")[0] || "audio/webm";
  const path = `${groupId}/${messageId}.${voiceExtension(baseType)}`;
  try {
    const { error } = await client.storage.from(VOICE_BUCKET).upload(path, blob, { contentType: baseType, upsert: true });
    if (!error) return { ok: true, path };
    const status = Number((error as unknown as { statusCode?: string | number }).statusCode);
    const permanent = status === 400 || status === 403 || status === 413;
    return { ok: false, retryable: !permanent, code: String(Number.isNaN(status) ? "upload" : status) };
  } catch {
    return { ok: false, retryable: true, code: "network" };
  }
}

export async function signVoice(client: SupabaseClient, path: string): Promise<string | null> {
  try {
    const { data, error } = await client.storage.from(VOICE_BUCKET).createSignedUrl(path, 3600);
    return error || !data ? null : data.signedUrl;
  } catch {
    return null;
  }
}

export interface ChatSubscriptionHandlers {
  readonly onMessage: (row: ChatRow) => void;
  /** A reaction or RSVP changed; refetch them. */
  readonly onExtrasChanged: () => void;
  readonly onStatus?: (status: string) => void;
}

/** One Realtime channel per group. Returns the function that tears it down. */
export function subscribeToGroup(client: SupabaseClient, groupId: string, handlers: ChatSubscriptionHandlers): () => void {
  const filter = `group_id=eq.${groupId}`;
  const channel = client
    .channel(`chat:${groupId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter }, (payload) => {
      const row = payload.new as ChatRow | undefined;
      if (row && row.id) handlers.onMessage(row);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_reactions", filter }, () => handlers.onExtrasChanged())
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_rsvps", filter }, () => handlers.onExtrasChanged())
    .subscribe((status) => handlers.onStatus?.(status));
  return () => {
    void client.removeChannel(channel);
  };
}
