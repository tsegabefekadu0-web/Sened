import type { BankAccountBindingSummary } from "@/lib/banking/types";
import { authedFetch, NotSignedInError, type AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { toBankVerificationIntent } from "./intent";
import type { ProvisionalContribution } from "./types";

/** Which message the UI should show; the keys live in `i18n.ts`. */
export type VerifyNotice =
  | "voice.verify.signedOut"
  | "voice.verify.noBinding"
  | "voice.verify.ambiguousBinding"
  | "voice.verify.pending"
  | "voice.verify.rejected"
  | "voice.verify.failed"
  | "voice.submitUnverifiedReason";

export interface VerifyResult {
  readonly verified: boolean;
  readonly verificationId?: string;
  readonly notice?: VerifyNotice;
}

export interface VerifyDeps extends AuthedFetchDeps {
  readonly now?: () => Date;
  readonly newKey?: () => string;
}

/**
 * The signed-in voice hand-off: read the treasurer's bindings, pick the one
 * that matches the spoken rail, and POST `/api/bank-verifications`.
 *
 * Only a server `VERIFIED` state yields `verified: true`; a spoken sentence
 * never does. A binding is chosen only when exactly one active ETB binding
 * matches the provider; guessing between accounts would attach a contribution
 * to the wrong one. `occurredAt` is the moment of submission, as the offline
 * path already does, because speech cannot supply a trustworthy clock.
 */
export async function requestBankVerification(
  draft: ProvisionalContribution,
  deps: VerifyDeps = {}
): Promise<VerifyResult> {
  try {
    const listed = await authedFetch("/api/bank-account-bindings", { method: "GET" }, deps);
    if (listed.status === 401) {
      return { verified: false, notice: "voice.verify.signedOut" };
    }
    if (!listed.ok) {
      return { verified: false, notice: "voice.verify.failed" };
    }
    const payload = (await listed.json()) as { bindings?: readonly BankAccountBindingSummary[] };
    const candidates = (payload.bindings ?? []).filter(
      (binding) => binding.active && binding.currency === "ETB" && binding.provider === draft.provider
    );
    if (candidates.length === 0) {
      return { verified: false, notice: "voice.verify.noBinding" };
    }
    if (candidates.length > 1) {
      return { verified: false, notice: "voice.verify.ambiguousBinding" };
    }

    const intent = toBankVerificationIntent({
      draft,
      bankAccountBindingId: candidates[0].id,
      occurredAt: (deps.now ?? (() => new Date()))().toISOString(),
      idempotencyKey: (deps.newKey ?? (() => `voice-${crypto.randomUUID()}`))()
    });
    if (!intent.ok) {
      return { verified: false, notice: "voice.submitUnverifiedReason" };
    }

    const response = await authedFetch(
      "/api/bank-verifications",
      { method: "POST", body: JSON.stringify(intent.body) },
      deps
    );
    if (response.status === 401) {
      return { verified: false, notice: "voice.verify.signedOut" };
    }
    if (!response.ok && response.status !== 202) {
      return { verified: false, notice: "voice.verify.failed" };
    }
    const result = (await response.json()) as { verificationId?: string; state?: string };
    if (result.state === "VERIFIED") {
      return { verified: true, verificationId: result.verificationId };
    }
    if (result.state === "PENDING_RECONCILIATION") {
      return { verified: false, verificationId: result.verificationId, notice: "voice.verify.pending" };
    }
    return { verified: false, verificationId: result.verificationId, notice: "voice.verify.rejected" };
  } catch (error) {
    return {
      verified: false,
      notice: error instanceof NotSignedInError ? "voice.verify.signedOut" : "voice.verify.failed"
    };
  }
}
