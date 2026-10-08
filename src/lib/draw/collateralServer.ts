import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseCycleCollateral,
  parseGuarantee,
  type CycleCollateral,
  type Guarantee
} from "./collateral";

/**
 * Server side of the collateral routes (M4.2). A thin forwarder: every rule (who
 * may propose, that only the guarantor can accept, that the guarantor is an active
 * member and not the winner, that the winner really won with rounds left) lives in
 * the SECURITY DEFINER functions, which take no "acting user" argument (it is
 * `auth.uid()`). This file translates the SQL error contract and re-validates the
 * shape of what comes back. ADVISORY ONLY: nothing here touches money.
 */

export type CollateralRefusal =
  | { readonly status: "forbidden" }
  | { readonly status: "not_found"; readonly code: string }
  | { readonly status: "invalid"; readonly code: string }
  | { readonly status: "conflict"; readonly code: string };

const CONFLICT_CODES = [
  "collateral_winner_not_found",
  "collateral_no_remaining_rounds",
  "collateral_cycle_closed",
  "collateral_exists",
  "collateral_limit",
  "collateral_state_conflict"
];

function refusal(error: { readonly message?: string; readonly code?: string }): CollateralRefusal | null {
  const message = error.message ?? "";
  if (message.includes("collateral_forbidden") || error.code === "42501") {
    return { status: "forbidden" };
  }
  if (message.includes("collateral_member_not_found")) {
    return { status: "not_found", code: "collateral_member_not_found" };
  }
  if (message.includes("collateral_invalid_request") || error.code === "22023") {
    return { status: "invalid", code: "collateral_invalid_request" };
  }
  const conflict = CONFLICT_CODES.find((code) => message.includes(code));
  return conflict ? { status: "conflict", code: conflict } : null;
}

export type ReadCollateralResult =
  | { readonly status: "ok"; readonly collateral: CycleCollateral }
  | { readonly status: "forbidden" };

export async function readCycleCollateral(client: SupabaseClient, cycleId: string): Promise<ReadCollateralResult> {
  const { data, error } = await client.rpc("get_draw_cycle_collateral_v1", { p_cycle_id: cycleId });
  if (error) {
    const known = refusal(error);
    if (known?.status === "forbidden") return known;
    throw new Error("collateral_storage_failure", { cause: error });
  }
  const collateral = parseCycleCollateral(data);
  if (collateral === null) {
    throw new Error("collateral_integrity_failure");
  }
  return { status: "ok", collateral };
}

export type GuaranteeAction =
  | { readonly action: "propose"; readonly cycleId: string; readonly winnerMemberId: string; readonly guarantorMemberId: string }
  | { readonly action: "accept"; readonly guaranteeId: string }
  | { readonly action: "decline"; readonly guaranteeId: string; readonly reason?: string }
  | { readonly action: "release"; readonly guaranteeId: string; readonly reason: string }
  | {
      readonly action: "supersede";
      readonly guaranteeId: string;
      readonly newGuarantorMemberId: string;
      readonly reason: string;
    };

export type GuaranteeActionResult =
  | {
      readonly status: "ok";
      readonly guarantee: Guarantee;
      /** Only for `supersede`: the guarantee that was replaced. */
      readonly superseded: Guarantee | null;
      readonly replayed: boolean;
    }
  | CollateralRefusal;

/** `[rpc name, arguments]` for an action. No argument ever names the acting user. */
function callFor(input: GuaranteeAction): readonly [string, Record<string, unknown>] {
  switch (input.action) {
    case "propose":
      return [
        "propose_collateral_guarantee_v1",
        {
          p_cycle_id: input.cycleId,
          p_winner_member_id: input.winnerMemberId,
          p_guarantor_member_id: input.guarantorMemberId
        }
      ];
    case "accept":
      return ["respond_collateral_guarantee_v1", { p_guarantee_id: input.guaranteeId, p_accept: true, p_reason: null }];
    case "decline":
      return [
        "respond_collateral_guarantee_v1",
        { p_guarantee_id: input.guaranteeId, p_accept: false, p_reason: input.reason ?? null }
      ];
    case "release":
      return ["release_collateral_guarantee_v1", { p_guarantee_id: input.guaranteeId, p_reason: input.reason }];
    case "supersede":
      return [
        "supersede_collateral_guarantee_v1",
        {
          p_guarantee_id: input.guaranteeId,
          p_new_guarantor_member_id: input.newGuarantorMemberId,
          p_reason: input.reason
        }
      ];
  }
}

export async function runGuaranteeAction(client: SupabaseClient, input: GuaranteeAction): Promise<GuaranteeActionResult> {
  const [name, args] = callFor(input);
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const known = refusal(error);
    if (known) return known;
    throw new Error("collateral_storage_failure", { cause: error });
  }
  const envelope = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const guarantee = parseGuarantee(envelope.guarantee);
  const superseded = envelope.superseded === undefined ? null : parseGuarantee(envelope.superseded);
  if (guarantee === null || typeof envelope.replayed !== "boolean" || (envelope.superseded !== undefined && superseded === null)) {
    throw new Error("collateral_integrity_failure");
  }
  return { status: "ok", guarantee, superseded, replayed: envelope.replayed };
}
