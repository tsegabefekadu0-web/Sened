import { attributionFromPayload } from "@/lib/db/attribution";
import type { OutboxRow } from "@/lib/db/types";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff";

/**
 * When is it safe to retry recording the payer of a synced draft by itself?
 *
 * The entry and its payer are two writes (`docs/architecture/offline-pwa.md`). The
 * entry is posted whatever happens to the payer, so a payer that did not record is a
 * follow-up to retry, never a reason to push the entry again. The retry sends only
 * `POST /api/ledger/attributions` for the server's entry id, and the database
 * (`record_ledger_entry_attribution_v1`) answers an IDENTICAL record with the existing
 * one (`replayed: true`) instead of writing a second, so repeating it cannot
 * double-record.
 *
 * Whether to repeat it AUTOMATICALLY depends on what the last answer said about the
 * payer:
 *
 * - TRANSIENT: the answer says nothing about the payer being wrong. Nothing was said
 *   at all (`unknown`: the server did not report an outcome), the attribution write
 *   itself failed (`attribution_failed`), its answer could not be read
 *   (`attribution_unreadable`), a concurrent writer won (`attribution_conflict`; the
 *   retry sees the winner), or the call hit the network, a 5xx or a rate limit.
 *   Retried automatically, with backoff and a bound.
 * - DEFINITIVE: the database or the server said NO for a reason a retry cannot change:
 *   `attribution_exists` (a different payer is already on the entry), `forbidden`, the
 *   member is not in the group, a verified bank receipt already names the payer, the
 *   entry was reversed, and so on. Needs a person: never retried automatically. The
 *   button stays, with the reason.
 * - Anything this client does not recognise is DEFINITIVE too. Failing closed means a
 *   code added on the server later shows up for a person instead of looping.
 */

export type AttributionRetryKind = "transient" | "definitive";

/** The codes (server side, as reported in `attributionError`) that mean "try again". */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "attribution_failed",
  "attribution_unreadable",
  "attribution_conflict"
]);

/** `null`/empty is the "unknown" outcome: the server did not say what became of the payer. */
export function classifyAttributionError(error: string | null | undefined): AttributionRetryKind {
  if (error === null || error === undefined || error === "") {
    return "transient";
  }
  return TRANSIENT_CODES.has(error) ? "transient" : "definitive";
}

/** Automatic attempts per synced draft, the one that came back with the sync result included. */
export const ATTRIBUTION_MAX_AUTO_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
/** While an attempt is in flight its row is not due again for this long (another tab, a second trigger). */
export const ATTRIBUTION_ATTEMPT_LEASE_MS = 30_000;

/** What the console says about the payer of one draft. */
export type AttributionRetryView =
  /** Not a synced draft with a payer: nothing to say. */
  | { readonly kind: "none" }
  /** The entry has not synced yet; the payer rides along with it. */
  | { readonly kind: "waiting" }
  | { readonly kind: "recorded" }
  /** Will be retried by itself. `attempt` is the number of the NEXT try; `nextAt` is epoch ms (`null` = as soon as possible). */
  | { readonly kind: "auto"; readonly attempt: number; readonly maxAttempts: number; readonly nextAt: number | null }
  /** A person has to act. `definitive`: the answer was no; `exhausted`: automatic tries ran out. */
  | { readonly kind: "attention"; readonly reason: "definitive" | "exhausted"; readonly code: string | null };

export function attributionAttemptsOf(row: Pick<OutboxRow, "attributionAttempts">): number {
  const value = row.attributionAttempts;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function attributionNextAttemptAtOf(row: Pick<OutboxRow, "attributionNextAttemptAt">): number | null {
  const value = row.attributionNextAttemptAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function attributionRetryView(row: OutboxRow | null | undefined, maxAttempts: number = ATTRIBUTION_MAX_AUTO_ATTEMPTS): AttributionRetryView {
  if (!row || row.kind !== "ledger-draft" || attributionFromPayload(row.payload) === null) {
    return { kind: "none" };
  }
  if (row.state !== "synced") {
    return { kind: "waiting" };
  }
  if (row.attributionOutcome === "RECORDED") {
    return { kind: "recorded" };
  }
  const code = row.attributionOutcome === "REFUSED" ? (row.attributionError ?? null) : null;
  if (classifyAttributionError(code) === "definitive") {
    return { kind: "attention", reason: "definitive", code };
  }
  const attempts = attributionAttemptsOf(row);
  if (attempts >= maxAttempts) {
    return { kind: "attention", reason: "exhausted", code };
  }
  return { kind: "auto", attempt: attempts + 1, maxAttempts, nextAt: attributionNextAttemptAtOf(row) };
}

/** Is this synced row owed an automatic attempt at `nowMs`? */
export function isAttributionRetryDue(row: OutboxRow, nowMs: number, maxAttempts: number = ATTRIBUTION_MAX_AUTO_ATTEMPTS): boolean {
  const view = attributionRetryView(row, maxAttempts);
  if (view.kind !== "auto" || !row.serverEntryId) {
    return false;
  }
  return view.nextAt === null || view.nextAt <= nowMs;
}
