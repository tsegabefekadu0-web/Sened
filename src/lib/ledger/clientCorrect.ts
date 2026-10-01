import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import type { LedgerEntryRequest } from "./types";

export type PostCorrectionResult =
  | { readonly status: "created"; readonly sequence: string; readonly replayed: boolean }
  | { readonly status: "invalid" }
  | { readonly status: "unauthorized" }
  | { readonly status: "forbidden" }
  | { readonly status: "conflict" }
  | { readonly status: "rate-limited" }
  | { readonly status: "error" };

/**
 * `POST /api/ledger/entries` with the signed-in user's Bearer token.
 *
 * A 200 is the server saying "this idempotency key already posted this exact
 * entry" (`replayed: true`); that is the outcome the user wanted, so it counts
 * as created. 409 is the opposite: the key was used for a *different* body.
 * Anything unexpected, including a network failure, is `error` — and the
 * caller must treat that as "outcome unknown" and retry with the same key.
 */
export async function postCorrection(
  request: LedgerEntryRequest,
  deps: AuthedFetchDeps = {}
): Promise<PostCorrectionResult> {
  try {
    const response = await authedFetch(
      "/api/ledger/entries",
      { method: "POST", body: JSON.stringify(request) },
      deps
    );
    if (response.status === 200 || response.status === 201) {
      const body = (await response.json().catch(() => null)) as {
        entry?: { sequence?: unknown };
        replayed?: unknown;
      } | null;
      if (!body || typeof body.entry?.sequence !== "string") {
        return { status: "error" };
      }
      return { status: "created", sequence: body.entry.sequence, replayed: body.replayed === true };
    }
    switch (response.status) {
      case 400:
      case 422:
        return { status: "invalid" };
      case 401:
        return { status: "unauthorized" };
      case 403:
        return { status: "forbidden" };
      case 409:
        return { status: "conflict" };
      case 429:
        return { status: "rate-limited" };
      default:
        return { status: "error" };
    }
  } catch (error) {
    return error instanceof NotSignedInError ? { status: "unauthorized" } : { status: "error" };
  }
}
