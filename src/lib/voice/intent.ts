import type { BankDirection } from "@/lib/banking/types";
import { isSubmittableToBank, VOICE_ISSUE_DETAIL, type ProvisionalContribution, type VoiceIssueCode } from "./types";

/**
 * The hand-off to AGENT-1's verifier.
 *
 * AGENTWORK.md §8.2 and cross-lane task **#14**: *neither* agent builds the
 * voice → `/api/bank-verifications` wiring alone. A2's job is to make the
 * payload correct and to refuse to produce one when the extraction is not
 * sound; A1's job is to send it, during integration.
 *
 * So this module produces the exact body `bankVerificationRequestSchema`
 * (`src/lib/banking/schemas.ts:147`) validates, and a function that says no.
 * It performs no I/O — there is deliberately no `fetch` in this file.
 */

export interface BankVerificationIntentInput {
  readonly draft: ProvisionalContribution;
  /** The treasurer's bound bank account — A1's surface, never spoken. */
  readonly bankAccountBindingId: string;
  /**
   * When the contribution actually happened, ISO 8601 with an offset.
   *
   * Speech cannot produce a trustworthy clock, so this is **not** defaulted to
   * `new Date()`. An absent time is a reason to ask, not a reason to guess:
   * `occurredAt` participates in the request fingerprint and in A1's
   * timestamp-mismatch reconciliation reason.
   */
  readonly occurredAt: string;
  readonly direction?: BankDirection;
  /** Stable key for A1's idempotency. Must be unique per attempt. */
  readonly idempotencyKey: string;
}

export type IntentRejectionCode =
  | VoiceIssueCode
  | "UNVERIFIABLE_RAIL"
  | "OCCURRED_AT_REQUIRED";

/** Which part of the extraction the treasurer has to fix. */
export type IntentRejectionField =
  | "transcript"
  | "amount"
  | "currency"
  | "channel"
  | "txRef"
  | "month"
  | "occurredAt";

export interface IntentRejectionReason {
  readonly code: IntentRejectionCode;
  readonly field: IntentRejectionField;
  /**
   * English, for logs and for the rejection reason attached to the response.
   * Display copy belongs in `i18n.ts`; this string is never rendered raw by a
   * user-facing surface.
   */
  readonly detail: string;
}

export type IntentOutcome =
  | { readonly ok: true; readonly body: BankVerificationIntentBody }
  | { readonly ok: false; readonly rejections: readonly IntentRejectionReason[] };

/** Byte-compatible with `bankVerificationRequestSchema` input. */
export interface BankVerificationIntentBody {
  readonly provider: string;
  readonly bankAccountBindingId: string;
  readonly providerReference: string;
  readonly amount: string;
  readonly currency: "ETB";
  readonly direction: BankDirection;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Every reason a draft cannot be handed to a bank right now.
 *
 * `NO_TX_REF` **is** a rejection, even though it is not a *blocking* issue for
 * the draft. `bankVerificationRequestSchema`
 * (`src/lib/banking/schemas.ts:156`) requires
 * `providerReference: z.string().trim().min(1)` — A1's provider lookup is
 * driven by the reference, so a reference-less utterance is simply not
 * queryable. The draft stays visible and correctable in the UI; the hand-off
 * waits until the treasurer reads the number off the phone.
 */
export function rejectionsFor(
  draft: ProvisionalContribution,
  occurredAt: string | null
): IntentRejectionReason[] {
  const rejections: IntentRejectionReason[] = [];

  for (const code of draft.issues) {
    const detail = VOICE_ISSUE_DETAIL[code];
    if (detail.blocking) {
      rejections.push({ code, field: detail.field, detail: `Blocked by ${code}` });
    } else if (code === "CASH_CHANNEL") {
      // Not blocking for the draft, but a cash rail can never be settled by a
      // bank provider, so it blocks *this* hand-off.
      rejections.push({
        code,
        field: "channel",
        detail: "A cash contribution cannot be settled by a bank provider"
      });
    } else if (code === "NO_TX_REF") {
      rejections.push({
        code,
        field: "txRef",
        detail: "A transaction reference is required for a bank lookup"
      });
    }
  }

  if (!isSubmittableToBank(draft)) {
    if (!rejections.some((rejection) => rejection.field === "channel")) {
      rejections.push({
        code: "NO_CHANNEL",
        field: "channel",
        detail: "No verifiable payment channel was identified"
      });
    }
    if (draft.amount === null && !rejections.some((rejection) => rejection.field === "amount")) {
      rejections.push({
        code: "NO_AMOUNT",
        field: "amount",
        detail: "No amount was extracted"
      });
    }
  }

  if (draft.amountWire === null) {
    rejections.push({
      code: "NO_AMOUNT",
      field: "amount",
      detail: "The extracted amount cannot be represented in ledger wire format"
    });
  }

  if (occurredAt === null || !ISO_OFFSET_PATTERN.test(occurredAt)) {
    rejections.push({
      code: "OCCURRED_AT_REQUIRED",
      field: "occurredAt",
      detail: "A treasury-supplied ISO 8601 timestamp is required"
    });
  }

  return rejections;
}

/**
 * Build the A1 request body, or explain precisely why it cannot be built.
 *
 * `idempotencyKey` and `bankAccountBindingId` must be supplied by the caller;
 * speech can produce neither, and inventing either would be the exact failure
 * this lane exists to prevent.
 */
export function toBankVerificationIntent(
  input: BankVerificationIntentInput
): IntentOutcome {
  const { draft, bankAccountBindingId, occurredAt, idempotencyKey } = input;
  const direction: BankDirection = input.direction ?? "inbound";

  const rejections: IntentRejectionReason[] = rejectionsFor(draft, occurredAt);

  if (!UUID_PATTERN.test(bankAccountBindingId)) {
    rejections.push({
      code: "NO_CHANNEL",
      field: "channel",
      detail: "A valid bank account binding UUID is required"
    });
  }
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    rejections.push({
      code: "OCCURRED_AT_REQUIRED",
      field: "occurredAt",
      detail: "A valid idempotency key is required"
    });
  }
  if (draft.provider === null) {
    if (!rejections.some((rejection) => rejection.field === "channel")) {
      rejections.push({
        code: "NO_CHANNEL",
        field: "channel",
        detail: "No bank provider was named in the utterance"
      });
    }
  }
  if (draft.txRef === null) {
    if (!rejections.some((rejection) => rejection.field === "txRef")) {
      rejections.push({
        code: "NO_TX_REF",
        field: "txRef",
        detail: "A transaction reference is required for a bank lookup"
      });
    }
  } else if (!/^[!-~]+$/.test(draft.txRef)) {
    rejections.push({
      code: "UNPARSEABLE",
      field: "txRef",
      detail: "The extracted reference contains characters the provider cannot accept"
    });
  }

  const provider = draft.provider;
  const amountWire = draft.amountWire;
  const txRef = draft.txRef;

  if (rejections.length > 0 || provider === null || amountWire === null || txRef === null) {
    return { ok: false, rejections };
  }

  return {
    ok: true,
    body: {
      provider,
      bankAccountBindingId,
      providerReference: txRef,
      amount: amountWire,
      currency: "ETB",
      direction,
      occurredAt,
      idempotencyKey
    }
  };
}

/** Warnings that do not block submission but must stay visible. */
export function warningsFor(draft: ProvisionalContribution): readonly string[] {
  return draft.issues.filter((code) => !VOICE_ISSUE_DETAIL[code].blocking);
}
