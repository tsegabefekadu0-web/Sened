import { getSenedDatabase, isOfflineStorageAvailable } from "@/lib/db";
import { saveSpokenNote } from "@/lib/db/notes";
import type { PaymentChannel, SpokenNoteLocale } from "@/lib/db/types";
import type { ProvisionalContribution } from "@/lib/voice/types";

/** No session means no group to read, so a note made before sign-in is kept under this one. */
export const LOCAL_GROUP_ID = "local-unprovisioned-group";

/** The parser's provider names map onto the offline store's rails one-for-one. */
const CHANNEL_FOR_PROVIDER: Readonly<Record<string, PaymentChannel>> = {
  telebirr: "telebirr",
  cbe: "cbe-birr",
  awash: "bank-transfer"
};

/**
 * The parser reports a detection, which can be "mixed" or "unknown". The store
 * wants one concrete locale, so an ambiguous detection is recorded as `am`:
 * this is a Ge'ez-primary product and the honest default is the language the
 * note is expected to be in, not a guess at what was said.
 */
const SPOKEN_NOTE_LOCALE_FOR: Readonly<Record<string, SpokenNoteLocale>> = {
  am: "am",
  om: "om",
  en: "en",
  mixed: "am",
  unknown: "am"
};

/**
 * Keep a spoken contribution on this device as a provisional note.
 *
 * It is not a verification and never touches the pot balance. The origin is
 * stated by the caller, never inferred: a note labelled `asr` that was really
 * typed would be a false claim about how a treasurer worked. Throws when the
 * write fails, so the caller can say so instead of reporting success.
 */
export async function saveProvisionalVoiceNote(
  draft: ProvisionalContribution,
  origin: { readonly transcriptSource: "human-typed" | "asr" }
): Promise<{ readonly id: string }> {
  if (!isOfflineStorageAvailable()) {
    throw new Error("offline-storage-unavailable");
  }
  const note = await saveSpokenNote(getSenedDatabase(), {
    groupId: LOCAL_GROUP_ID,
    locale: SPOKEN_NOTE_LOCALE_FOR[draft.language] ?? "am",
    transcript: draft.utterance,
    transcriptSource: origin.transcriptSource,
    amountEtb: draft.amountWire,
    channel: draft.provider ? CHANNEL_FOR_PROVIDER[draft.provider] ?? null : null,
    occurredAt: new Date().toISOString()
  });
  return { id: note.id };
}
