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
}

export interface CreateBankIntentResult {
  readonly intent: BankVerificationIntent;
  readonly replayed: boolean;
}

export interface BankVerificationResult {
  readonly verification: PublicBankVerification;
  readonly replayed: boolean;
}

export interface BankVerificationRepository {
  getBinding(bindingId: string, context: BankVerificationContext): Promise<BankAccountBinding | null>;
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
