/**
 * How a manual contribution was paid (channel) and a short note, recorded beside
 * the entry on its attribution record (`20261012100000_attribution_channel_and_note.sql`).
 *
 * Isomorphic on purpose: the server (validation, RPC wrapper, reader), the browser
 * (record form, feed) and the offline store all share ONE definition, and the SQL
 * repeats the same rules as table constraints. Nothing here is part of the
 * hash-chained entry.
 *
 * - `channel`: one of `telebirr | cbe | awash | cash | other`. The first three are
 *   the bank-verification providers; for a bank-verified entry the channel IS the
 *   verification's provider and a manual one cannot be recorded at all.
 * - `note`: optional plain text, trimmed, 1..280 characters (code points), with no
 *   control characters and no invisible bidirectional / zero-width formatting
 *   characters. It is data: nothing renders it as markup.
 */

export const CONTRIBUTION_CHANNELS = ["telebirr", "cbe", "awash", "cash", "other"] as const;
export type ContributionChannel = (typeof CONTRIBUTION_CHANNELS)[number];

export const CONTRIBUTION_NOTE_MAX = 280;

/** C0 (except NUL, which text cannot hold), DEL, C1, zero-width, bidi marks/overrides/isolates and BOM. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NOTE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

export function isContributionChannel(value: unknown): value is ContributionChannel {
  return typeof value === "string" && (CONTRIBUTION_CHANNELS as readonly string[]).includes(value);
}

export type NoteProblem = "empty" | "too-long" | "forbidden-characters";

/**
 * The note as it would be stored: trimmed. Returns the problem when it cannot be.
 * An all-blank note is `"empty"`; callers that treat a blank field as "no note"
 * should test for blank first (`isBlankNote`).
 */
export function checkContributionNote(value: string): { readonly ok: true; readonly note: string } | { readonly ok: false; readonly problem: NoteProblem } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, problem: "empty" };
  }
  if (FORBIDDEN_NOTE_CHARACTERS.test(trimmed)) {
    return { ok: false, problem: "forbidden-characters" };
  }
  if (Array.from(trimmed).length > CONTRIBUTION_NOTE_MAX) {
    return { ok: false, problem: "too-long" };
  }
  return { ok: true, note: trimmed };
}

/** True for a form field with nothing (or only spaces) in it: "no note", not an error. */
export function isBlankNote(value: string): boolean {
  return value.trim().length === 0;
}
