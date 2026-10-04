import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { attributionFromPayload } from "@/lib/db/attribution";
import { getOutboxRow, recordAttributionOutcome } from "@/lib/db/outbox";
import type { SenedDatabase } from "@/lib/db/schema";
import { attributePayer, type AttributeResult } from "@/lib/ledger/clientAttribution";
import { attributeCodeFromServer, type AttributeFailureCode } from "@/lib/ledger/attributionCodes";

/**
 * Retry the payer attribution of a ledger draft whose ENTRY the server already
 * holds, once the treasurer is online again.
 *
 * Only the attribution is sent (`POST /api/ledger/attributions`, the same action
 * the home feed's "attribute payer" uses) against the server's entry id; the entry
 * is never pushed again, so it cannot post twice. The attribution RPC records the
 * first attribution of an entry and answers an identical one with the existing
 * record, so a retry after a lost response is `recorded`, not an error.
 */

export type RetryAttributionResult =
  | { readonly status: "recorded" }
  /** The database refused it (the entry is unchanged; the reason is stored for the console). */
  | { readonly status: "refused"; readonly code: AttributeFailureCode }
  /** Nothing to retry: the mutation is not a synced draft that carried a payer. */
  | { readonly status: "nothing-to-retry" }
  /** Could not reach a verdict (offline, signed out, rate limited): nothing was changed. */
  | { readonly status: "unavailable"; readonly cause: Exclude<AttributeResult["status"], "ok" | "refused"> };

export async function retryDraftAttribution(
  db: SenedDatabase,
  outboxId: string,
  options: { readonly deps?: AuthedFetchDeps; readonly now?: Date } = {}
): Promise<RetryAttributionResult> {
  const row = await getOutboxRow(db, outboxId);
  const attribution = row ? attributionFromPayload(row.payload) : null;
  if (!row || row.kind !== "ledger-draft" || row.state !== "synced" || !row.serverEntryId || attribution === null) {
    return { status: "nothing-to-retry" };
  }
  if (row.attributionOutcome === "RECORDED") {
    return { status: "recorded" };
  }
  const result = await attributePayer(
    {
      groupId: row.groupId,
      entryId: row.serverEntryId,
      memberUserId: attribution.memberUserId,
      ...(attribution.cycleId === undefined ? {} : { cycleId: attribution.cycleId }),
      ...(attribution.round === undefined ? {} : { round: attribution.round })
    },
    options.deps ?? {}
  );
  const now = options.now ?? new Date();
  if (result.status === "ok") {
    await recordAttributionOutcome(db, outboxId, "RECORDED", null, now);
    return { status: "recorded" };
  }
  if (result.status === "refused") {
    await recordAttributionOutcome(db, outboxId, "REFUSED", result.code, now);
    return { status: "refused", code: result.code };
  }
  return { status: "unavailable", cause: result.status };
}

/** Both the server's codes (`attribution_bank_verified`) and the retry's (`bank_verified`) as one code. */
export function attributionRefusalCode(error: string | null | undefined): AttributeFailureCode {
  if (!error) return "other";
  const fromServer = attributeCodeFromServer(error);
  if (fromServer !== "other") return fromServer;
  const friendly: readonly AttributeFailureCode[] = [
    "bank_verified",
    "corrected",
    "exists",
    "unchanged",
    "not_contribution",
    "entry_not_found",
    "member_not_found",
    "cycle_not_found",
    "attribution_not_found"
  ];
  return (friendly as readonly string[]).includes(error) ? (error as AttributeFailureCode) : "other";
}
