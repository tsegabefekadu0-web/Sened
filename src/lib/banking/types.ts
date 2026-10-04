export const BANK_PROVIDERS = ["telebirr", "cbe", "awash"] as const;
export type BankProvider = (typeof BANK_PROVIDERS)[number];

export const BANK_DIRECTIONS = ["inbound", "outbound"] as const;
export type BankDirection = (typeof BANK_DIRECTIONS)[number];

export const BANK_VERIFICATION_STATES = [
  "PENDING_RECONCILIATION",
  "VERIFIED",
  "REJECTED"
] as const;
export type BankVerificationState = (typeof BANK_VERIFICATION_STATES)[number];

export const BANK_VERIFICATION_REASON_CODES = [
  "AWAITING_PROVIDER_EVIDENCE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_UNSETTLED",
  "PROVIDER_RESPONSE_INVALID",
  "EVIDENCE_INCOMPLETE",
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "DIRECTION_MISMATCH",
  "SENDER_MISMATCH",
  "RECEIVER_MISMATCH",
  "TIMESTAMP_MISMATCH",
  "MANUAL_REVIEW_REQUIRED",
  "VERIFIED"
] as const;
export type BankVerificationReasonCode = (typeof BANK_VERIFICATION_REASON_CODES)[number];

export const BANK_PROVIDER_RESULT_KINDS = [
  "settled",
  "unsettled",
  "not_found",
  "timeout",
  "rate_limited",
  "provider_error",
  "invalid_response"
] as const;
export type BankProviderResultKind = (typeof BANK_PROVIDER_RESULT_KINDS)[number];

export const RECONCILIATION_JOB_STATES = [
  "QUEUED",
  "CLAIMED",
  "RETRY_SCHEDULED",
  "SUCCEEDED",
  "MANUAL_REVIEW"
] as const;
export type ReconciliationJobState = (typeof RECONCILIATION_JOB_STATES)[number];

export const RECONCILIATION_EVENT_TYPES = [
  "INTENT_CREATED",
  "VERIFICATION_PENDING",
  "VERIFIED",
  "REJECTED",
  "RETRY_SCHEDULED",
  "MANUAL_REVIEW",
  "REVERSAL_PLANNED"
] as const;
export type ReconciliationEventType = (typeof RECONCILIATION_EVENT_TYPES)[number];

export interface BankProviderEvidence {
  readonly providerTransactionId: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly senderFingerprint: string;
  readonly receiverFingerprint: string;
  readonly occurredAt: string;
  readonly settledAt: string;
}

export interface BankProviderResult {
  readonly provider: BankProvider;
  readonly kind: BankProviderResultKind;
  readonly evidence?: BankProviderEvidence;
  readonly retryAfterSeconds?: number;
}

export interface BankProviderLookup {
  readonly provider: BankProvider;
  readonly transactionReference: string;
  readonly accountFingerprintHmac: string;
}

export interface BankProviderAdapter {
  readonly provider: BankProvider;
  /**
   * Permitted clock skew, in seconds, between the declared contribution time
   * and the provider's own timestamp. Omitted means exact equality.
   *
   * Live provider feeds publish wall-clock timestamps at minute precision with
   * no offset, so an adapter that reads one must state how much skew it accepts.
   * The value narrows only the timestamp dimension; amount, currency, direction
   * and both account fingerprints are always compared exactly.
   */
  readonly timestampToleranceSeconds?: number;
  isConfigured(): boolean;
  verify(lookup: BankProviderLookup): Promise<unknown>;
}

export interface BankAccountBinding {
  readonly id: string;
  readonly userId: string;
  readonly groupId: string;
  readonly tenantId: string;
  readonly ledgerAccountId: string;
  readonly provider: BankProvider;
  readonly currency: string;
  readonly accountLabel: string;
  readonly accountFingerprintHmac: string;
  readonly senderFingerprintHmac: string;
  readonly receiverFingerprintHmac: string;
  readonly active: boolean;
}

export interface BankVerificationRequest {
  readonly provider: BankProvider;
  readonly bankAccountBindingId: string;
  readonly providerReference: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

export interface SealedProviderReference {
  readonly provider: BankProvider;
  readonly ciphertext: string;
  readonly hmac: string;
  readonly keyVersion: string;
}

export interface BankReferenceVault {
  seal(provider: BankProvider, reference: string): Promise<SealedProviderReference>;
  open(sealed: SealedProviderReference): Promise<string>;
}

export interface BankVerificationContext {
  readonly userId: string;
}

export interface BankVerificationIntent {
  readonly id: string;
  readonly userId: string;
  readonly groupId: string;
  readonly tenantId: string;
  readonly bankAccountBindingId: string;
  readonly ledgerAccountId: string;
  readonly provider: BankProvider;
  readonly providerReferenceHmac: string;
  readonly sealedProviderReference: SealedProviderReference;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly evidenceFingerprint: string | null;
  readonly providerTransactionIdentityHmac: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ledgerEntryId: string | null;
  /**
   * Masked form of the bank reference (`••••2F42`, see `referenceMask.ts`).
   * `null` when none was stored (rows from before it existed until the backfill
   * script has run, or a reference too short to mask). Absent from fixtures that
   * predate the field; treat absent as `null`.
   */
  readonly referenceDisplay?: string | null;
}

export interface BankVerificationEvent {
  readonly id: string;
  readonly verificationId: string;
  readonly userId: string;
  readonly eventType: ReconciliationEventType;
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly attempt: number;
  readonly createdAt: string;
}

export interface PublicBankVerification {
  readonly verificationId: string;
  readonly provider: BankProvider;
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Masked bank reference for the owner (`••••2F42`), or `null`. Never the full reference. */
  readonly referenceMasked: string | null;
}

export interface CreateBankIntentInput {
  readonly bankAccountBindingId: string;
  readonly provider: BankProvider;
  readonly providerReferenceHmac: string;
  readonly sealedProviderReference: SealedProviderReference;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankDirection;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  /** Computed by the server from the plaintext reference with `maskBankReference`. */
  readonly referenceDisplay?: string | null;
}

export interface CreateBankIntentResult {
  readonly intent: BankVerificationIntent;
  readonly replayed: boolean;
}

export interface BankVerificationResult {
  readonly verification: PublicBankVerification;
  readonly replayed: boolean;
}

/**
 * A binding, as shown to the treasurer who owns it.
 *
 * Deliberately narrower than {@link BankAccountBinding}: no account
 * fingerprints and no sealed reference. The fingerprints are HMACs over masked
 * account numbers, and they exist to be compared server-side. A treasurer only
 * needs to recognise *which* account they bound, which is the provider, the
 * currency and the label they gave it.
 */
export interface BankAccountBindingSummary {
  readonly id: string;
  readonly groupId: string;
  readonly provider: BankProvider;
  readonly currency: string;
  readonly accountLabel: string;
  readonly active: boolean;
}

export interface BankVerificationRepository {
  getBinding(bindingId: string, context: BankVerificationContext): Promise<BankAccountBinding | null>;
  /**
   * Every binding the calling user owns.
   *
   * Required, not optional, because a client cannot derive a binding id and a
   * verification request is unusable without one. An implementation that returns
   * nothing is worse than one that fails loudly, so this has no default.
   */
  listBindings(context: BankVerificationContext): Promise<readonly BankAccountBindingSummary[]>;
  createIntent(
    input: CreateBankIntentInput,
    context: BankVerificationContext
  ): Promise<CreateBankIntentResult>;
  getIntent(verificationId: string, context: BankVerificationContext): Promise<BankVerificationIntent | null>;
  recordResult(
    verificationId: string,
    result: {
      readonly state: BankVerificationState;
      readonly reasonCode: BankVerificationReasonCode;
      readonly evidenceFingerprint: string | null;
      readonly providerTransactionIdentityHmac: string | null;
      readonly ledgerEntryId: string | null;
      readonly nextAttemptAt: string | null;
    },
    context: BankVerificationContext
  ): Promise<BankVerificationIntent>;
  appendEvent(
    event: Omit<BankVerificationEvent, "id" | "createdAt">,
    context: BankVerificationContext
  ): Promise<BankVerificationEvent>;
}

export interface BankVerificationLedgerSink {
  postVerifiedContribution(intent: BankVerificationIntent): Promise<string | null>;
}

export interface ReconciliationJob {
  readonly id: string;
  readonly verificationId: string;
  readonly userId: string;
  readonly provider: BankProvider;
  readonly state: ReconciliationJobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastReasonCode: BankVerificationReasonCode | null;
  readonly terminalAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReconciliationClaim {
  readonly job: ReconciliationJob;
  readonly intent: BankVerificationIntent;
}

export interface ReconciliationJobStore {
  enqueue(intent: BankVerificationIntent, maxAttempts?: number): Promise<ReconciliationJob>;
  schedulePending?(
    verificationId: string,
    reasonCode: BankVerificationReasonCode,
    nextAttemptAt: Date
  ): Promise<ReconciliationJob>;
  claimNext(workerId: string, now: Date, leaseMs: number): Promise<ReconciliationClaim | null>;
  /**
   * Move jobs that are leased-and-expired on their final attempt to
   * MANUAL_REVIEW (claimNext can never return them). Returns how many.
   */
  reapExhausted?(): Promise<number>;
  reschedule(
    jobId: string,
    workerId: string,
    leaseToken: string,
    reasonCode: BankVerificationReasonCode,
    nextAttemptAt: Date
  ): Promise<ReconciliationJob>;
  finalize(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: {
      readonly state: "VERIFIED" | "REJECTED";
      readonly reasonCode: BankVerificationReasonCode;
      readonly evidenceFingerprint: string | null;
      readonly providerTransactionIdentityHmac: string | null;
      readonly ledgerEntryId: string | null;
    }
  ): Promise<ReconciliationJob>;
  getJobByVerificationId(verificationId: string): Promise<ReconciliationJob | null>;
  planCompensatingReversal(
    verificationId: string,
    reason: string,
    context: BankVerificationContext
  ): Promise<BankVerificationEvent>;
}

export interface ReconciliationVerificationOutcome {
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly retryAfterSeconds?: number;
  readonly evidenceFingerprint: string | null;
  readonly providerTransactionIdentityHmac: string | null;
  readonly ledgerEntryId: string | null;
}

export interface ReconciliationVerifier {
  verifyIntent(intent: BankVerificationIntent): Promise<ReconciliationVerificationOutcome>;
}
