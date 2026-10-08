import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseCycleContributions, type CycleContributions } from "./contributions";

/**
 * Server side of `GET /api/draw/contributions` (§18). A thin forwarder: who may read (any active
 * member of the cycle's group, and an unknown cycle reads the same as one in another group) is
 * decided by `get_draw_cycle_contributions_v1` from `auth.uid()`. This file translates the SQL
 * refusal and re-validates the shape of what comes back.
 */
export type ReadContributionsResult =
  | { readonly status: "ok"; readonly contributions: CycleContributions }
  | { readonly status: "forbidden" };

export async function readCycleContributions(client: SupabaseClient, cycleId: string): Promise<ReadContributionsResult> {
  const { data, error } = await client.rpc("get_draw_cycle_contributions_v1", { p_cycle_id: cycleId });
  if (error) {
    if ((error.message ?? "").includes("draw_forbidden") || error.code === "42501" || error.code === "28000") {
      return { status: "forbidden" };
    }
    throw new Error("contributions_storage_failure", { cause: error });
  }
  const contributions = parseCycleContributions(data);
  if (contributions === null) {
    throw new Error("contributions_integrity_failure");
  }
  return { status: "ok", contributions };
}
