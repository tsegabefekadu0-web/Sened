import { isUuid } from "@/lib/ledger/rules";
import { checkContributionNote, isContributionChannel } from "@/lib/ledger/paymentChannel";
import { SyncError } from "@/lib/offline/contract";
import type { DraftAttribution } from "./types";

/**
 * Payer attribution on an offline draft (ROADMAP 4.2).
 *
 * The same shape and limits as `ledgerEntryAttributionSchema` on the server
 * (`memberUserId` uuid; optional `cycleId` uuid; optional `round` 1..1000 that
 * needs its cycle). Checked here so a device never queues something the server
 * will refuse for its shape; whether the member and cycle belong to the group is
 * the database's call when the draft syncs.
 *
 * `channel` (telebirr | cbe | awash | cash | other) and `note` (plain text, trimmed,
 * 1..280 characters, no control characters) are optional and arrive with schema
 * version 3. A draft that names neither is exactly the shape it always had; a blank
 * note is "no note"; `null` is "none".
 */

export const ATTRIBUTION_MAX_ROUND = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A well-formed attribution, or a `SyncError("INVALID_DRAFT")`. `null`/`undefined` mean "no payer". */
export function normalizeDraftAttribution(value: unknown): DraftAttribution | null {
  if (value === undefined || value === null) {
    return null;
  }
  const invalid = (message: string) => new SyncError("INVALID_DRAFT", `Draft attribution rejected: ${message}`);
  if (!isRecord(value)) {
    throw invalid("it must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "memberUserId" && key !== "cycleId" && key !== "round" && key !== "channel" && key !== "note") {
      throw invalid(`unknown field ${key}`);
    }
  }
  const { memberUserId, cycleId, round, channel, note } = value;
  if (typeof memberUserId !== "string" || !isUuid(memberUserId)) {
    throw invalid("memberUserId must be a UUID");
  }
  if (cycleId !== undefined && (typeof cycleId !== "string" || !isUuid(cycleId))) {
    throw invalid("cycleId must be a UUID");
  }
  if (round !== undefined) {
    if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1 || round > ATTRIBUTION_MAX_ROUND) {
      throw invalid(`round must be a whole number from 1 to ${ATTRIBUTION_MAX_ROUND}`);
    }
    if (cycleId === undefined) {
      throw invalid("a round needs its cycle");
    }
  }
  if (channel !== undefined && channel !== null && !isContributionChannel(channel)) {
    throw invalid("channel must be telebirr, cbe, awash, cash or other");
  }
  let cleanNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string") {
      throw invalid("note must be text");
    }
    if (note.trim().length > 0) {
      const checked = checkContributionNote(note);
      if (!checked.ok) {
        throw invalid(
          checked.problem === "too-long" ? "note is longer than 280 characters" : "note must be plain text without control characters"
        );
      }
      cleanNote = checked.note;
    }
  }
  return {
    memberUserId: memberUserId.toLowerCase(),
    ...(cycleId === undefined ? {} : { cycleId: (cycleId as string).toLowerCase() }),
    ...(round === undefined ? {} : { round: round as number }),
    ...(channel === undefined || channel === null ? {} : { channel }),
    ...(cleanNote === null ? {} : { note: cleanNote })
  };
}

/** The outbox payload of a ledger draft: the request, plus `attribution` only when there is one. */
export function draftPayload<T extends object>(request: T, attribution: DraftAttribution | null | undefined): T | (T & { attribution: DraftAttribution }) {
  return attribution ? { ...request, attribution } : request;
}

/** The attribution a queued mutation's payload carries, or null (old-shape payloads have none). */
export function attributionFromPayload(payload: unknown): DraftAttribution | null {
  if (!isRecord(payload) || !("attribution" in payload)) {
    return null;
  }
  try {
    return normalizeDraftAttribution(payload.attribution);
  } catch {
    return null;
  }
}
