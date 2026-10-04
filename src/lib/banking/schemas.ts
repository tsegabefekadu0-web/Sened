import { z } from "zod";
import { formatEtbAmount, toEtbMinorUnits, WIRE_ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import { MASKED_REFERENCE_PATTERN } from "./referenceMask";
import {
  BANK_DIRECTIONS,
  BANK_PROVIDER_RESULT_KINDS,
  BANK_PROVIDERS,
  BANK_VERIFICATION_REASON_CODES,
  BANK_VERIFICATION_STATES,
  RECONCILIATION_EVENT_TYPES,
  RECONCILIATION_JOB_STATES
} from "./types";
import type {
  BankDirection,
  BankProvider,
  BankProviderResult,
  BankProviderResultKind,
  BankVerificationEvent,
  BankVerificationIntent,
  BankVerificationReasonCode,
  BankVerificationState,
  ReconciliationEventType,
  ReconciliationJob,
  ReconciliationJobState
} from "./types";

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
const hmacSchema = z.string().regex(/^[0-9a-f]{64}$/i).transform((value) => value.toLowerCase());
const timestampSchema = z
  .string()
  .max(35)
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 1900 && year <= 2100;
  }, "Timestamp is outside the supported range");
const amountSchema = z
  .string()
  .max(21)
  .regex(WIRE_ETB_DECIMAL_PATTERN)
  .refine((value) => {
    try {
      return toEtbMinorUnits(value, true) > 0n;
    } catch {
      return false;
    }
  })
  .transform((value) => formatEtbAmount(value));

export const bankProviderSchema = z.enum(BANK_PROVIDERS);
export const bankDirectionSchema = z.enum(BANK_DIRECTIONS);
export const bankVerificationStateSchema = z.enum(BANK_VERIFICATION_STATES);
export const bankVerificationReasonCodeSchema = z.enum(BANK_VERIFICATION_REASON_CODES);
export const bankProviderResultKindSchema = z.enum(BANK_PROVIDER_RESULT_KINDS);
export const reconciliationJobStateSchema = z.enum(RECONCILIATION_JOB_STATES);
export const reconciliationEventTypeSchema = z.enum(RECONCILIATION_EVENT_TYPES);

/** Only the masked shape; a full reference can never pass as a display value. */
export const maskedReferenceSchema = z.string().regex(MASKED_REFERENCE_PATTERN);

export const sealedProviderReferenceSchema = z
  .object({
    provider: bankProviderSchema,
    ciphertext: z.string().min(1).max(16_384),
    hmac: hmacSchema,
    keyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/)
  })
  .strict();

export const bankProviderEvidenceSchema = z
  .object({
    providerTransactionId: z.string().trim().min(1).max(256).refine(
      (value) => /^[!-~]+$/.test(value),
      "Provider transaction identity contains unsupported characters"
    ),
    amount: amountSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    direction: bankDirectionSchema,
    senderFingerprint: hmacSchema,
    receiverFingerprint: hmacSchema,
    occurredAt: timestampSchema,
    settledAt: timestampSchema
  })
  .strict();

const providerResultShape = {
  provider: bankProviderSchema
};

const settledProviderResultSchema = z
  .object({
    ...providerResultShape,
    kind: z.literal("settled"),
    evidence: bankProviderEvidenceSchema
  })
  .strict();

const pendingProviderResultSchema = z
  .object({
    ...providerResultShape,
    kind: z.enum(["unsettled", "not_found", "timeout", "provider_error", "invalid_response"])
  })
  .strict();

const rateLimitedProviderResultSchema = z
  .object({
    ...providerResultShape,
    kind: z.literal("rate_limited"),
    retryAfterSeconds: z.number().int().min(0).max(86_400)
  })
  .strict();

export const normalizedBankProviderResultSchema = z.union([
  settledProviderResultSchema,
  pendingProviderResultSchema,
  rateLimitedProviderResultSchema
]);

function providerResultSchema(provider: BankProvider) {
  return normalizedBankProviderResultSchema.superRefine((result, context) => {
    if (result.provider !== provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "Provider identity does not match the adapter"
      });
    }
  });
}

export const normalizedBankProviderResultSchemas = {
  telebirr: providerResultSchema("telebirr"),
  cbe: providerResultSchema("cbe"),
  awash: providerResultSchema("awash")
} as const;

export const telebirrNormalizedBankProviderResultSchema =
  normalizedBankProviderResultSchemas.telebirr;
export const cbeNormalizedBankProviderResultSchema = normalizedBankProviderResultSchemas.cbe;
export const awashNormalizedBankProviderResultSchema = normalizedBankProviderResultSchemas.awash;

export function validateNormalizedBankProviderResult(
  provider: BankProvider,
  input: unknown
): BankProviderResult {
  const schema = normalizedBankProviderResultSchemas[provider];
  return schema.parse(input) as BankProviderResult;
}

export const bankVerificationRequestSchema = z
  .object({
    provider: bankProviderSchema,
    bankAccountBindingId: uuidSchema,
    providerReference: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => /^[!-~]+$/.test(value), "Provider reference contains unsupported characters"),
    amount: amountSchema,
    currency: z.literal("ETB"),
    direction: bankDirectionSchema,
    occurredAt: timestampSchema,
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();

export const bankVerificationIdSchema = uuidSchema;

export const publicBankVerificationSchema = z
  .object({
    verificationId: uuidSchema,
    provider: bankProviderSchema,
    state: bankVerificationStateSchema,
    reasonCode: bankVerificationReasonCodeSchema,
    amount: amountSchema,
    currency: z.literal("ETB"),
    direction: bankDirectionSchema,
    occurredAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    referenceMasked: maskedReferenceSchema.nullable()
  })
  .strict();

export const bankVerificationIntentResponseSchema = z
  .object({
    verificationId: uuidSchema,
    userId: uuidSchema,
    groupId: uuidSchema,
    tenantId: uuidSchema,
    bankAccountBindingId: uuidSchema,
    ledgerAccountId: uuidSchema,
    provider: bankProviderSchema,
    providerReferenceHmac: hmacSchema,
    sealedProviderReference: sealedProviderReferenceSchema,
    amount: amountSchema,
    currency: z.literal("ETB"),
    direction: bankDirectionSchema,
    occurredAt: timestampSchema,
    idempotencyKey: z.string().min(1).max(128),
    requestFingerprint: hmacSchema,
    state: bankVerificationStateSchema,
    reasonCode: bankVerificationReasonCodeSchema,
    evidenceFingerprint: hmacSchema.nullable(),
    providerTransactionIdentityHmac: hmacSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    ledgerEntryId: uuidSchema.nullable(),
    // Optional so a response from a database still on the previous migration parses.
    referenceDisplay: maskedReferenceSchema.nullable().optional()
  })
  .strict();

export const bankAccountBindingResponseSchema = z
  .object({
    id: uuidSchema,
    userId: uuidSchema,
    groupId: uuidSchema,
    tenantId: uuidSchema,
    ledgerAccountId: uuidSchema,
    provider: bankProviderSchema,
    currency: z.literal("ETB"),
    accountLabel: z.string().min(1).max(120),
    accountFingerprintHmac: hmacSchema,
    senderFingerprintHmac: hmacSchema,
    receiverFingerprintHmac: hmacSchema,
    active: z.boolean()
  })
  .strict();

export const createBankIntentResponseSchema = z
  .object({
    intent: bankVerificationIntentResponseSchema,
    replayed: z.boolean()
  })
  .strict();

export const bankVerificationEventResponseSchema = z
  .object({
    id: uuidSchema,
    verificationId: uuidSchema,
    userId: uuidSchema,
    eventType: reconciliationEventTypeSchema,
    state: bankVerificationStateSchema,
    reasonCode: bankVerificationReasonCodeSchema,
    attempt: z.number().int().min(0).max(100),
    createdAt: timestampSchema
  })
  .strict();

export const reconciliationJobResponseSchema = z
  .object({
    id: uuidSchema,
    verificationId: uuidSchema,
    userId: uuidSchema,
    provider: bankProviderSchema,
    state: reconciliationJobStateSchema,
    attempt: z.number().int().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(20),
    nextAttemptAt: timestampSchema,
    leaseToken: uuidSchema.nullable(),
    leaseExpiresAt: timestampSchema.nullable(),
    lastReasonCode: bankVerificationReasonCodeSchema.nullable(),
    terminalAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const reconciliationClaimResponseSchema = z
  .object({
    job: reconciliationJobResponseSchema,
    intent: bankVerificationIntentResponseSchema
  })
  .strict();

export function parseBankVerificationIntent(value: unknown): BankVerificationIntent {
  const parsed = bankVerificationIntentResponseSchema.parse(value) as unknown as {
    verificationId: string;
    userId: string;
    groupId: string;
    tenantId: string;
    bankAccountBindingId: string;
    ledgerAccountId: string;
    provider: BankProvider;
    providerReferenceHmac: string;
    sealedProviderReference: BankVerificationIntent["sealedProviderReference"];
    amount: string;
    currency: string;
    direction: BankDirection;
    occurredAt: string;
    idempotencyKey: string;
    requestFingerprint: string;
    state: BankVerificationState;
    reasonCode: BankVerificationReasonCode;
    evidenceFingerprint: string | null;
    providerTransactionIdentityHmac: string | null;
    createdAt: string;
    updatedAt: string;
    ledgerEntryId: string | null;
    referenceDisplay?: string | null;
  };
  const { verificationId, referenceDisplay, ...rest } = parsed;
  return { id: verificationId, ...rest, referenceDisplay: referenceDisplay ?? null };
}

export function parseBankVerificationEvent(value: unknown): BankVerificationEvent {
  return bankVerificationEventResponseSchema.parse(value) as BankVerificationEvent;
}

export function parseReconciliationJob(value: unknown): ReconciliationJob {
  return reconciliationJobResponseSchema.parse(value) as ReconciliationJob;
}

export function bankResultReasonCode(kind: BankProviderResultKind): BankVerificationReasonCode {
  switch (kind) {
    case "timeout":
      return "PROVIDER_TIMEOUT";
    case "rate_limited":
      return "PROVIDER_RATE_LIMITED";
    case "not_found":
      return "PROVIDER_NOT_FOUND";
    case "unsettled":
      return "PROVIDER_UNSETTLED";
    case "provider_error":
      return "PROVIDER_UNAVAILABLE";
    case "invalid_response":
      return "PROVIDER_RESPONSE_INVALID";
    case "settled":
      return "EVIDENCE_INCOMPLETE";
  }
}

export function isBankProvider(value: unknown): value is BankProvider {
  return typeof value === "string" && (BANK_PROVIDERS as readonly string[]).includes(value);
}

export function isBankDirection(value: unknown): value is BankDirection {
  return typeof value === "string" && (BANK_DIRECTIONS as readonly string[]).includes(value);
}

export function isBankVerificationState(value: unknown): value is BankVerificationState {
  return typeof value === "string" && (BANK_VERIFICATION_STATES as readonly string[]).includes(value);
}

export function isReconciliationEventType(value: unknown): value is ReconciliationEventType {
  return (
    typeof value === "string" && (RECONCILIATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isReconciliationJobState(value: unknown): value is ReconciliationJobState {
  return typeof value === "string" && (RECONCILIATION_JOB_STATES as readonly string[]).includes(value);
}

export function isBankVerificationReasonCode(value: unknown): value is BankVerificationReasonCode {
  return (
    typeof value === "string" && (BANK_VERIFICATION_REASON_CODES as readonly string[]).includes(value)
  );
}
