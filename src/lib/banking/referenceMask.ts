/**
 * The masked display form of a bank transaction reference.
 *
 * Pure and dependency-free so the server (at intent creation), the backfill
 * script, the reader and the browser all use the one rule and the one shape.
 *
 * Rule: four bullets, then the last `k` characters of the reference, where
 * `k = min(4, floor(length / 2))`. So a reference of 8 or more characters shows
 * its last 4, a 6-character one its last 3, a 2-character one its last 1, and
 * a 1-character reference has nothing safe to show and yields `null`. Never
 * more than half of the reference, never more than 4 characters.
 *
 * The number of bullets is fixed (not one per hidden character) so the display
 * does not also reveal the reference's length.
 *
 * Alphabet: only printable ASCII without space (`[!-~]`), the same alphabet the
 * verification request already enforces on a provider reference. Anything else
 * (control characters, whitespace inside, non-ASCII text) yields `null`: the
 * mask counts code points, not UTF-16 units, but a reference that is not in
 * the expected alphabet is not one we can describe safely, so none is shown.
 * The input is trimmed first, as the request schema does.
 *
 * Why it is safe to show to fellow group members: the reference identifies a
 * receipt the treasurer already presented to the group, and 4 trailing
 * characters of a bank transaction id are not enough to look up, replay or
 * forge a receipt (the provider also requires the amount and accounts to
 * match, and the full reference stays encrypted, with HMACs for lookup,
 * server-side only). It is what a bank statement or an ATM slip routinely
 * prints. The database stores this value in its own column behind a CHECK
 * constraint that accepts only this shape, so a full reference cannot be
 * written there by mistake.
 */

export const MASK_BULLET = "•";
export const MASK_BULLET_COUNT = 4;
export const MASK_MAX_VISIBLE = 4;

/** Exactly what `maskBankReference` can return. Mirrors the SQL CHECK constraint. */
export const MASKED_REFERENCE_PATTERN = /^•{4}[!-~]{1,4}$/;

const REFERENCE_ALPHABET = /^[!-~]+$/;

export function maskBankReference(reference: unknown): string | null {
  if (typeof reference !== "string") {
    return null;
  }
  const trimmed = reference.trim();
  if (!REFERENCE_ALPHABET.test(trimmed)) {
    return null;
  }
  // Printable ASCII is one code unit per character, so slicing is exact.
  const visible = Math.min(MASK_MAX_VISIBLE, Math.floor(trimmed.length / 2));
  if (visible < 1) {
    return null;
  }
  return MASK_BULLET.repeat(MASK_BULLET_COUNT) + trimmed.slice(trimmed.length - visible);
}

/** True only for a value of the masked shape; anything else must never be displayed. */
export function isMaskedReference(value: unknown): value is string {
  return typeof value === "string" && MASKED_REFERENCE_PATTERN.test(value);
}
