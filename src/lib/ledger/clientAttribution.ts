import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { attributeCodeFromServer, type AttributeFailureCode as SharedFailureCode } from "./attributionCodes";
import type { ContributionChannel } from "./paymentChannel";

/**
 * Browser side of "who paid this contribution" (M4.2): the owner's or
 * treasurer's `attribute payer` action on a ledger row.
 *
 * `POST /api/ledger/attributions` records the first attribution of an entry;
 * `PUT` corrects one by appending a new record that carries a reason (nothing is
 * ever edited or deleted). The database decides who may do it and refuses an
 * entry a verified bank receipt already names, so this only forwards the call and
 * names the outcome. The recorder is the session; no user id is sent for it.
 */

export interface AttributeInput {
  readonly groupId: string;
  readonly entryId: string;
  readonly memberUserId: string;
  readonly cycleId?: string;
  readonly round?: number;
  /**
   * How it was paid / a plain-text note (already trimmed and checked by the caller;
   * the server and the database check them again). Record: absent or `null` = none.
   * Correction: absent KEEPS the earlier value, `null` CLEARS it.
   */
  readonly channel?: ContributionChannel | null;
  readonly note?: string | null;
}

export type AttributeFailureCode = Exclude<SharedFailureCode, "forbidden">;

export type AttributeResult =
  | { readonly status: "ok"; readonly replayed: boolean; readonly revision: number }
  | { readonly status: "refused"; readonly code: AttributeFailureCode }
  | { readonly status: "forbidden" }
  | { readonly status: "unauthorized" }
  | { readonly status: "rate-limited" }
  | { readonly status: "error" };

async function send(
  method: "POST" | "PUT",
  body: Record<string, unknown>,
  deps: AuthedFetchDeps
): Promise<AttributeResult> {
  try {
    const response = await authedFetch("/api/ledger/attributions", { method, body: JSON.stringify(body) }, deps);
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      replayed?: unknown;
      attribution?: { revision?: unknown };
    } | null;
    if (response.status === 200 || response.status === 201) {
      const revision = payload?.attribution?.revision;
      if (typeof revision !== "number") return { status: "error" };
      return { status: "ok", replayed: payload?.replayed === true, revision };
    }
    switch (response.status) {
      case 401:
        return { status: "unauthorized" };
      case 403:
        return { status: "forbidden" };
      case 429:
        return { status: "rate-limited" };
      case 404:
      case 409:
      case 422: {
        const code = attributeCodeFromServer(payload?.error);
        return { status: "refused", code: code === "forbidden" ? "other" : code };
      }
      default:
        return { status: "error" };
    }
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}

function bodyOf(input: AttributeInput): Record<string, unknown> {
  return {
    groupId: input.groupId,
    entryId: input.entryId,
    memberUserId: input.memberUserId,
    ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
    ...(input.round === undefined ? {} : { round: input.round }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.note === undefined ? {} : { note: input.note })
  };
}

/** Record who paid an entry that has no attribution yet. */
export function attributePayer(input: AttributeInput, deps: AuthedFetchDeps = {}): Promise<AttributeResult> {
  return send("POST", bodyOf(input), deps);
}

/** Correct an attribution with a reason (10..1000 characters). The earlier record stays. */
export function supersedePayer(
  input: AttributeInput & { readonly reason: string },
  deps: AuthedFetchDeps = {}
): Promise<AttributeResult> {
  return send("PUT", { ...bodyOf(input), reason: input.reason }, deps);
}
