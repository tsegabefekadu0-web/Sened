import { SyncError } from "./contract";

/**
 * Browser-side SHA-256 over a note's content.
 *
 * Uses WebCrypto only. `node:crypto` is deliberately not imported: these modules
 * ship to the treasurer's phone, and a Node builtin in the client graph is a
 * build error at best.
 *
 * `crypto.subtle` is undefined outside a secure context. Rather than silently
 * storing an unhashed note — which would look like a passing integrity check —
 * this throws `CRYPTO_UNAVAILABLE` and the caller stores `contentHash: null`,
 * which the console renders as an honest "not available on this connection".
 */
export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SyncError(
      "CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable here, so this note cannot be integrity-hashed"
    );
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `true` when WebCrypto hashing is possible in this runtime. */
export function isContentHashingAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === "function";
}

/**
 * Canonical, stable serialization of a note's substantive content.
 *
 * Only the fields that carry meaning are included — `createdAt` and `outboxId`
 * are excluded so that re-saving a note does not invalidate its hash.
 */
export function serializeSpokenNoteContent(input: {
  readonly id: string;
  readonly groupId: string;
  readonly memberId: string | null;
  readonly locale: string;
  readonly transcript: string;
  readonly transcriptSource: string;
  readonly amountEtb: string | null;
  readonly channel: string | null;
  readonly occurredAt: string;
  readonly durationMs: number | null;
}): string {
  return JSON.stringify([
    input.id,
    input.groupId,
    input.memberId ?? "",
    input.locale,
    input.transcript,
    input.transcriptSource,
    input.amountEtb ?? "",
    input.channel ?? "",
    input.occurredAt,
    input.durationMs === null ? "" : String(input.durationMs)
  ]);
}
