import type { SendResult } from "./chatClient";

/**
 * Messages written but not yet accepted by the server.
 *
 * A message is added here first and shown at once as "sending"; it leaves when
 * the server accepts it (a replay of the same id also counts, since the id is
 * chosen by the sender) or refuses it for good. Text survives a reload through
 * `storage`; a voice note's audio is kept in memory only (it can be large), so a
 * voice note that was never delivered is lost on reload rather than half-kept.
 */

export interface PendingMessage {
  readonly id: string;
  readonly groupId: string;
  readonly kind: "text" | "voice";
  readonly body?: string;
  readonly replyTo?: string | null;
  readonly voiceSeconds?: number;
  /** The recorded audio as a data URL. Never persisted. */
  readonly voiceData?: string;
  readonly createdAt: string;
}

export const OUTBOX_STORAGE_KEY = "sened.chat.outbox.v1";
const MAX_PENDING = 200;

export interface FlushReport {
  readonly sent: readonly string[];
  readonly dropped: readonly string[];
  readonly kept: readonly string[];
}

export class ChatOutbox {
  private items: PendingMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private flushing: Promise<FlushReport> | null = null;

  constructor(private readonly storage: Storage | null = null, private readonly key: string = OUTBOX_STORAGE_KEY) {
    this.items = this.read();
  }

  private read(): PendingMessage[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (v): v is PendingMessage =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as PendingMessage).id === "string" &&
          typeof (v as PendingMessage).groupId === "string" &&
          (v as PendingMessage).kind === "text" &&
          typeof (v as PendingMessage).body === "string"
      );
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const durable = this.items.filter((m) => m.kind === "text");
      if (durable.length === 0) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify(durable));
    } catch {
      // Storage full or blocked: the in-memory queue still works.
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  list(groupId: string): readonly PendingMessage[] {
    return this.items.filter((m) => m.groupId === groupId);
  }

  add(message: PendingMessage): boolean {
    if (this.items.length >= MAX_PENDING || this.items.some((m) => m.id === message.id)) return false;
    this.items = [...this.items, message];
    this.persist();
    this.emit();
    return true;
  }

  remove(id: string): void {
    const next = this.items.filter((m) => m.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
    this.emit();
  }

  /**
   * Tries every waiting message of the group once, oldest first, and stops at the
   * first retryable failure so order is kept. Concurrent calls share one run.
   */
  flush(groupId: string, deliver: (message: PendingMessage) => Promise<SendResult>): Promise<FlushReport> {
    if (this.flushing) return this.flushing;
    const run = async (): Promise<FlushReport> => {
      const sent: string[] = [];
      const dropped: string[] = [];
      const kept: string[] = [];
      const waiting = this.list(groupId);
      for (let i = 0; i < waiting.length; i += 1) {
        const message = waiting[i];
        const result = await deliver(message);
        if (result.ok) {
          sent.push(message.id);
          this.remove(message.id);
        } else if (result.retryable) {
          kept.push(...waiting.slice(i).map((m) => m.id));
          break;
        } else {
          dropped.push(message.id);
          this.remove(message.id);
        }
      }
      return { sent, dropped, kept };
    };
    this.flushing = run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
}

let shared: ChatOutbox | null = null;

/** The app-wide outbox, backed by `localStorage` where there is one. */
export function getChatOutbox(): ChatOutbox {
  if (!shared) {
    let storage: Storage | null = null;
    try {
      storage = typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      storage = null;
    }
    shared = new ChatOutbox(storage);
  }
  return shared;
}
