import { formatEtbAmount } from "@/lib/ledger/money";
import { sha256Hex, serializeSpokenNoteContent } from "@/lib/offline/hash";
import { isTerminalOfflineSyncState, SyncError } from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import { newLocalId } from "./ids";
import type { SenedDatabase } from "./schema";
import {
  PAYMENT_CHANNELS,
  SPOKEN_NOTE_LOCALES,
  TRANSCRIPT_SOURCES,
  type PaymentChannel,
  type SpokenNoteLocale,
  type SpokenNoteRow,
  type TranscriptSource
} from "./types";

const MAX_TRANSCRIPT_LENGTH = 4_000;
const MAX_AUDIO_BYTES = 25_165_824;

export interface SaveSpokenNoteInput {
  readonly id?: string;
  readonly groupId: string;
  readonly memberId?: string | null;
  readonly locale?: SpokenNoteLocale;
  readonly transcript: string;
  /**
   * Defaults to `human-typed`. A note is only ever `asr` when a real
   * speech-to-text engine produced the text, and the caller has to say so
   * explicitly — there is no path that guesses.
   */
  readonly transcriptSource?: TranscriptSource;
  readonly amountEtb?: string | null;
  readonly channel?: PaymentChannel | null;
  readonly occurredAt?: string;
  readonly durationMs?: number | null;
  readonly audioMimeType?: string | null;
  readonly audioByteLength?: number | null;
  readonly now?: Date;
}

function requireText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be text`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} is not a recognised value`);
  }
  return value as T;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = requireText(value, field, max);
  return text.length === 0 ? null : text;
}

function optionalAmount(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    return formatEtbAmount(String(value));
  } catch (error) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", "amountEtb is not a valid ETB amount", { cause: error });
  }
}

function optionalCount(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be a whole number no greater than ${max}`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

/**
 * Store a spoken note on this device.
 *
 * The audio blob itself is never persisted here. A 25 MB base64 string in
 * IndexedDB is how a treasurer loses a Sunday's work to a quota error, so the
 * row keeps the *metadata* (mime type, byte length, duration) and the caller
 * owns blob storage. `audioByteLength` is still recorded so the console can
 * tell the truth about what was captured.
 */
export async function saveSpokenNote(
  db: SenedDatabase,
  input: SaveSpokenNoteInput
): Promise<SpokenNoteRow> {
  const now = (input.now ?? new Date());
  const id = input.id ?? newLocalId();
  const groupId = requireText(input.groupId, "groupId", 64);
  const transcript = requireText(input.transcript, "transcript", MAX_TRANSCRIPT_LENGTH, true);
  const locale = requireEnum(input.locale, SPOKEN_NOTE_LOCALES, "locale", "am");
  const transcriptSource = requireEnum(
    input.transcriptSource,
    TRANSCRIPT_SOURCES,
    "transcriptSource",
    "human-typed"
  );
  const channel =
    input.channel === undefined || input.channel === null
      ? null
      : requireEnum(input.channel, PAYMENT_CHANNELS, "channel", "cash");
  const occurredAt = requireIsoTimestamp(input.occurredAt ?? now.toISOString(), "occurredAt");
  const durationMs = optionalCount(input.durationMs, "durationMs", 6 * 60 * 60 * 1000);
  const audioByteLength = optionalCount(input.audioByteLength, "audioByteLength", MAX_AUDIO_BYTES);

  const content = serializeSpokenNoteContent({
    id,
    groupId,
    memberId: input.memberId ?? null,
    locale,
    transcript,
    transcriptSource,
    amountEtb: optionalAmount(input.amountEtb),
    channel,
    occurredAt,
    durationMs
  });

  let contentHash: string | null;
  try {
    contentHash = await sha256Hex(content);
  } catch (error) {
    if (!(error instanceof SyncError) || error.code !== "CRYPTO_UNAVAILABLE") {
      throw error;
    }
    // Fail closed: record the note with an explicit "no hash" rather than
    // inventing one or dropping the treasurer's work.
    contentHash = null;
  }

  const timestamp = now.toISOString();
  const row: SpokenNoteRow = {
    id,
    groupId,
    memberId: input.memberId ?? null,
    locale,
    transcript,
    transcriptSource,
    amountEtb: optionalAmount(input.amountEtb),
    channel,
    occurredAt,
    durationMs,
    audioMimeType: optionalText(input.audioMimeType, "audioMimeType", 128),
    audioByteLength,
    contentHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    outboxId: null
  };

  try {
    await db.spokenNotes.put(row);
    return row;
  } catch (error) {
    throw mapStorageError(error, "Saving a spoken note");
  }
}

export async function getSpokenNote(db: SenedDatabase, id: string): Promise<SpokenNoteRow | undefined> {
  return db.spokenNotes.get(id);
}

export async function listSpokenNotes(
  db: SenedDatabase,
  groupId: string,
  options: { readonly limit?: number } = {}
): Promise<SpokenNoteRow[]> {
  const rows = await db.spokenNotes.where("groupId").equals(groupId).reverse().sortBy("occurredAt");
  const limit = options.limit ?? rows.length;
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Delete a note.
 *
 * Refused while the note is still in flight. Removing a queued mutation would
 * either drop a contribution the treasurer believed was recorded, or — if the
 * request was already on the wire — resurrect it on the next pull. Both are
 * worse than a visible row with a "retry" button.
 */
export async function deleteSpokenNote(
  db: SenedDatabase,
  id: string,
  options: { readonly outboxStateOf?: (note: SpokenNoteRow) => OfflineSyncStateLike | undefined } = {}
): Promise<void> {
  const note = await db.spokenNotes.get(id);
  if (!note) {
    throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Spoken note was not found on this device");
  }
  const state = options.outboxStateOf?.(note);
  if (state && !isTerminalOfflineSyncState(state)) {
    throw new SyncError(
      "SYNC_PROTECTED_ROW",
      "This note is still waiting to sync. Wait for it to settle before deleting it."
    );
  }
  await db.spokenNotes.delete(id);
}

type OfflineSyncStateLike = Parameters<typeof isTerminalOfflineSyncState>[0];
