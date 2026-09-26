import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProductionBankProviderAdapter } from "./adapter";
import { BankVerificationError } from "./errors";
import {
  bankAccountBindingResponseSchema,
  createBankIntentResponseSchema,
  parseBankVerificationEvent,
  parseBankVerificationIntent,
  parseReconciliationJob,
  reconciliationClaimResponseSchema
} from "./schemas";
import type {
  BankAccountBinding,
  BankReferenceVault,
  BankVerificationContext,
  BankVerificationEvent,
  BankVerificationIntent,
  BankVerificationRepository,
  BankVerificationState,
  CreateBankIntentInput,
  CreateBankIntentResult,
  ReconciliationClaim,
  ReconciliationJob,
  ReconciliationJobStore
} from "./types";
import { createAesGcmReferenceVaultFromEnvironment } from "./vault";
import { BankVerificationService } from "./service";

interface SupabaseErrorLike {
  readonly code?: string;
  readonly message?: string;
}

function mapSupabaseError(error: SupabaseErrorLike): BankVerificationError {
  const message = error.message ?? "";
  if (message.includes("bank_binding_not_found") || message.includes("bank_verification_not_found")) {
    return new BankVerificationError("NOT_FOUND", "Bank verification resource was not found", {
      cause: error
    });
  }
  if (message.includes("bank_idempotency_conflict") || error.code === "23505") {
    return new BankVerificationError("IDEMPOTENCY_CONFLICT", "Bank verification idempotency conflict", {
      cause: error
    });
  }
  if (message.includes("bank_forbidden") || error.code === "42501") {
    return new BankVerificationError("FORBIDDEN", "Bank verification access is forbidden", { cause: error });
  }
  if (message.includes("bank_invalid_request") || error.code === "22023") {
    return new BankVerificationError("INVALID_REQUEST", "Bank verification request is invalid", {
      cause: error
    });
  }
  if (error.code === "PGRST202" || error.code === "57014") {
    return new BankVerificationError("STORAGE_UNAVAILABLE", "Bank verification storage is unavailable", {
      cause: error
    });
  }
  return new BankVerificationError("STORAGE_FAILURE", "Bank verification storage failed", { cause: error });
}

function parseOrThrow<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    throw new BankVerificationError("INTEGRITY_FAILURE", "Bank verification storage returned invalid data", {
      cause: error
    });
  }
}

function parseBinding(value: unknown): BankAccountBinding {
  return parseOrThrow((input) => bankAccountBindingResponseSchema.parse(input) as BankAccountBinding, value);
}

export class SupabaseBankVerificationRepository implements BankVerificationRepository, ReconciliationJobStore {
  constructor(private readonly client: SupabaseClient) {}

  async getBinding(
    bindingId: string,
    _context: BankVerificationContext
  ): Promise<BankAccountBinding | null> {
    const { data, error } = await this.client.rpc("get_bank_account_binding_v1", {
      p_binding_id: bindingId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data ? parseBinding(data) : null;
  }

  async createIntent(
    input: CreateBankIntentInput,
    _context: BankVerificationContext
  ): Promise<CreateBankIntentResult> {
    const { data, error } = await this.client.rpc("create_bank_verification_intent_v1", {
      p_binding_id: input.bankAccountBindingId,
      p_provider: input.provider,
      p_provider_reference_hmac: input.providerReferenceHmac,
      p_provider_reference_ciphertext: input.sealedProviderReference.ciphertext,
      p_provider_reference_key_version: input.sealedProviderReference.keyVersion,
      p_amount: input.amount,
      p_currency: input.currency,
      p_direction: input.direction,
      p_occurred_at: input.occurredAt,
      p_idempotency_key: input.idempotencyKey
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    const response = parseOrThrow((value) => createBankIntentResponseSchema.parse(value), data);
    return {
      intent: parseBankVerificationIntent(response.intent),
      replayed: response.replayed
    };
  }

  async getIntent(
    verificationId: string,
    _context: BankVerificationContext
  ): Promise<BankVerificationIntent | null> {
    const { data, error } = await this.client.rpc("get_bank_verification_intent_v1", {
      p_verification_id: verificationId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data ? parseBankVerificationIntent(data) : null;
  }

  async recordResult(
    verificationId: string,
    result: {
      readonly state: BankVerificationState;
      readonly reasonCode: BankVerificationIntent["reasonCode"];
      readonly evidenceFingerprint: string | null;
      readonly providerTransactionIdentityHmac: string | null;
      readonly ledgerEntryId: string | null;
      readonly nextAttemptAt: string | null;
    },
    _context: BankVerificationContext
  ): Promise<BankVerificationIntent> {
    const { data, error } = await this.client.rpc("record_bank_verification_result_v1", {
      p_verification_id: verificationId,
      p_state: result.state,
      p_reason_code: result.reasonCode,
      p_evidence_fingerprint: result.evidenceFingerprint,
      p_provider_transaction_identity_hmac: result.providerTransactionIdentityHmac,
      p_ledger_entry_id: result.ledgerEntryId,
      p_next_attempt_at: result.nextAttemptAt
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseBankVerificationIntent(data);
  }

  async appendEvent(
    event: Omit<BankVerificationEvent, "id" | "createdAt">,
    _context: BankVerificationContext
  ): Promise<BankVerificationEvent> {
    const { data, error } = await this.client.rpc("append_bank_verification_event_v1", {
      p_verification_id: event.verificationId,
      p_event_type: event.eventType,
      p_state: event.state,
      p_reason_code: event.reasonCode,
      p_attempt: event.attempt
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseBankVerificationEvent(data);
  }

  async enqueue(intent: BankVerificationIntent, _maxAttempts?: number): Promise<ReconciliationJob> {
    const { data, error } = await this.client.rpc("enqueue_bank_reconciliation_job_v1", {
      p_verification_id: intent.id,
      p_max_attempts: _maxAttempts ?? 5
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseReconciliationJob(data);
  }

  async claimNext(workerId: string, _now: Date, leaseMs: number): Promise<ReconciliationClaim | null> {
    const { data, error } = await this.client.rpc("claim_bank_reconciliation_job_v1", {
      p_worker_id: workerId,
      p_lease_seconds: Math.ceil(leaseMs / 1_000)
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    if (!data) {
      return null;
    }
    const response = parseOrThrow((value) => reconciliationClaimResponseSchema.parse(value), data);
    return {
      job: response.job as ReconciliationJob,
      intent: parseBankVerificationIntent(response.intent)
    };
  }

  async reschedule(
    jobId: string,
    workerId: string,
    leaseToken: string,
    reasonCode: BankVerificationIntent["reasonCode"],
    nextAttemptAt: Date
  ): Promise<ReconciliationJob> {
    const { data, error } = await this.client.rpc("reschedule_bank_reconciliation_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_token: leaseToken,
      p_reason_code: reasonCode,
      p_next_attempt_at: nextAttemptAt.toISOString()
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseReconciliationJob(data);
  }

  async finalize(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: {
      readonly state: "VERIFIED" | "REJECTED";
      readonly reasonCode: BankVerificationIntent["reasonCode"];
      readonly evidenceFingerprint: string | null;
      readonly providerTransactionIdentityHmac: string | null;
      readonly ledgerEntryId: string | null;
    }
  ): Promise<ReconciliationJob> {
    const { data, error } = await this.client.rpc("finalize_bank_reconciliation_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_token: leaseToken,
      p_state: result.state,
      p_reason_code: result.reasonCode,
      p_evidence_fingerprint: result.evidenceFingerprint,
      p_provider_transaction_identity_hmac: result.providerTransactionIdentityHmac,
      p_ledger_entry_id: result.ledgerEntryId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseReconciliationJob(data);
  }

  async getJobByVerificationId(verificationId: string): Promise<ReconciliationJob | null> {
    const { data, error } = await this.client.rpc("get_bank_reconciliation_job_v1", {
      p_verification_id: verificationId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data ? parseReconciliationJob(data) : null;
  }

  async planCompensatingReversal(
    verificationId: string,
    _reason: string,
    _context: BankVerificationContext
  ): Promise<BankVerificationEvent> {
    const { data, error } = await this.client.rpc("plan_bank_compensating_reversal_v1", {
      p_verification_id: verificationId
    });
    if (error) {
      throw mapSupabaseError(error);
    }
    return parseBankVerificationEvent(data);
  }
}

function createLazyEnvironmentVault(): BankReferenceVault {
  return {
    seal: async (provider, reference) => createAesGcmReferenceVaultFromEnvironment().seal(provider, reference),
    open: async (sealed) => createAesGcmReferenceVaultFromEnvironment().open(sealed)
  };
}

export function createProductionBankVerificationService(
  client: SupabaseClient
): BankVerificationService {
  const repository = new SupabaseBankVerificationRepository(client);
  return new BankVerificationService({
    repository,
    jobStore: repository,
    referenceVault: createLazyEnvironmentVault(),
    adapterResolver: createProductionBankProviderAdapter
  });
}
