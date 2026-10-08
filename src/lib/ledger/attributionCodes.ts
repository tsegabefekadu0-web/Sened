/**
 * The closed set of reasons a payer attribution can be refused, and how the
 * server's own error strings map onto it.
 *
 * Shared by every browser caller that can hear one: the treasurer's "attribute
 * payer" action (`clientAttribution.ts`), the record-contribution form
 * (`clientContribution.ts`) and the offline console. The strings are the
 * database's codes (`record_ledger_entry_attribution_v1`), which both
 * `POST /api/ledger/attributions` and the `attribution` report on
 * `POST /api/ledger/entries` / `/api/sync` pass through unchanged.
 */

export type AttributeFailureCode =
  | "bank_verified"
  | "corrected"
  | "exists"
  | "unchanged"
  | "not_contribution"
  | "entry_not_found"
  | "member_not_found"
  | "cycle_not_found"
  | "attribution_not_found"
  | "forbidden"
  | "other";

export const ATTRIBUTE_CODES: Readonly<Record<string, AttributeFailureCode>> = {
  attribution_bank_verified: "bank_verified",
  attribution_entry_corrected: "corrected",
  attribution_exists: "exists",
  attribution_unchanged: "unchanged",
  attribution_not_contribution: "not_contribution",
  ledger_entry_not_found: "entry_not_found",
  ledger_member_not_found: "member_not_found",
  ledger_cycle_not_found: "cycle_not_found",
  attribution_not_found: "attribution_not_found",
  forbidden: "forbidden"
};

/** A server error string as one of the known refusal codes; anything else is `other`. */
export function attributeCodeFromServer(error: unknown): AttributeFailureCode {
  return typeof error === "string" ? (ATTRIBUTE_CODES[error] ?? "other") : "other";
}
