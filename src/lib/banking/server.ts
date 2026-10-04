import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseLedgerAccountResolver } from "@/lib/ledger/accountResolver";
import { LedgerService, SupabaseLedgerRepository } from "@/lib/ledger";
import { createProductionBankProviderAdapter } from "./adapter";
import { BankVerificationError } from "./errors";
import { LedgerBankVerificationSink } from "./ledgerSink";
import { BANK_PROVIDERS } from "./types";
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
  BankAccountBindingSummary,
  BankProvider,
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
import { ReconciliationCoordinator } from "./reconciliation";

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

/**
 * Parse one row of `list_bank_account_bindings_v1()`.
 *
 * Checked field by field rather than trusted, because this response goes
 * straight to a browser. A row that does not match the shape is dropped by the
 * caller's `filter` below rather than surfacing a half-populated account.
 */
function parseBindingSummary(value: unknown): BankAccountBindingSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.groupId !== "string" ||
    !UUID_PATTERN.test(row.groupId) ||
    typeof row.provider !== "string" ||
    !BANK_PROVIDERS.includes(row.provider as BankProvider) ||
    typeof row.currency !== "string" ||
    typeof row.accountLabel !== "string" ||
    typeof row.active !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    groupId: row.groupId,
    provider: row.provider as BankProvider,
    currency: row.currency,
    accountLabel: row.accountLabel,
    active: row.active
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SupabaseBankVerificationRepository implements BankVerificationRepository, ReconciliationJobStore {
  /**
   * @param options.readBindingsAsReconciliationWorker Look bindings up through
   *   `get_bank_account_binding_for_reconciliation_v1`, for the cron-driven
   *   drain. A service-role client has no `auth.uid()`, so the user-scoped RPC
   *   would return nothing for every job. The worker RPC takes the owner from
   *   the context and refuses unless a claimed job covers that binding. Never
   *   set it for a user-scoped client.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly options: { readonly readBindingsAsReconciliationWorker?: boolean } = {}
  ) {}

  async getBinding(
    bindingId: string,
    context: BankVerificationContext
  ): Promise<BankAccountBinding | null> {
    const { data, error } = this.options.readBindingsAsReconciliationWorker
      ? await this.client.rpc("get_bank_account_binding_for_reconciliation_v1", {
          p_binding_id: bindingId,
          p_user_id: context.userId
        })
      : await this.client.rpc("get_bank_account_binding_v1", {
          p_binding_id: bindingId
        });
    if (error) {
      throw mapSupabaseError(error);
    }
    return data ? parseBinding(data) : null;
  }

  /**
   * Every binding the calling user owns.
   *
   * A client cannot derive a binding id — it is minted when an account is bound
   * — and a verification request is unusable without one, so this read is what
   * stands between a treasurer and being able to verify anything at all.
   *
   * The RPC is scoped to `auth.uid()` and returns no account fingerprints and no
   * sealed reference, so the result is safe to hand to a browser.
   */
  async listBindings(
    _context: BankVerificationContext
  ): Promise<readonly BankAccountBindingSummary[]> {
    const { data, error } = await this.client.rpc("list_bank_account_bindings_v1");
    if (error) {
      throw mapSupabaseError(error);
    }
    if (!Array.isArray(data)) {
      throw new BankVerificationError(
        "INTEGRITY_FAILURE",
        "Binding list storage returned an invalid response"
      );
    }
    return data
      .map((entry) => parseBindingSummary(entry))
      .filter((entry): entry is BankAccountBindingSummary => entry !== null);
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
      p_idempotency_key: input.idempotencyKey,
      p_reference_display: input.referenceDisplay ?? null
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

  async reapExhausted(): Promise<number> {
    const { data, error } = await this.client.rpc("reap_exhausted_bank_reconciliation_jobs_v1");
    if (error) {
      throw mapSupabaseError(error);
    }
    return typeof data === "number" && Number.isInteger(data) && data >= 0 ? data : 0;
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

/**
 * The production wiring.
 *
 * The ledger sink is built here and nowhere else, which is the point: a bank
 * result is only money once a balanced entry exists, and there must be exactly
 * one place that decides that. Before this, `BankVerificationService` accepted a
 * `ledgerSink` option and nothing ever passed one, so the production path could
 * verify a contribution and post nothing.
 *
 * The sink fails closed on its own — an unprovisioned group writes no entry and
 * the verification keeps a `null` `ledgerEntryId` — so a group that has not been
 * through `sened_ledger_provision_group_v1` degrades to "verified but not
 * posted", which is visible, rather than to a wrong posting.
 */
export function createProductionBankVerificationService(
  client: SupabaseClient
): BankVerificationService {
  const repository = new SupabaseBankVerificationRepository(client);
  const ledgerSink = new LedgerBankVerificationSink({
    ledger: new LedgerService(new SupabaseLedgerRepository(client)),
    accounts: async (intent) => {
      const resolver = new SupabaseLedgerAccountResolver(client);
      return resolver.resolve(intent.groupId, intent.ledgerAccountId, intent.direction);
    }
  });
  return new BankVerificationService({
    repository,
    jobStore: repository,
    referenceVault: createLazyEnvironmentVault(),
    adapterResolver: createProductionBankProviderAdapter,
    ledgerSink
  });
}

/**
 * The reconciliation drain's wiring: the same verifier and ledger sink as the
 * synchronous path, driven by a service-role client.
 *
 * `client` MUST be the service-role client; this is the only place that is
 * true. The queue RPCs (claim, reschedule, finalize) are granted to
 * `service_role` only, and the two worker RPCs below stand in for the
 * `auth.uid()`-scoped binding read and ledger post that a cron has no session
 * for. Everything else (matching, evidence hashing, the sink's refusal to
 * guess an account, ledger idempotency) is the shared code, not a copy.
 */
export function createProductionReconciliationCoordinator(
  client: SupabaseClient,
  options: { readonly clock?: () => Date } = {}
): ReconciliationCoordinator {
  const repository = new SupabaseBankVerificationRepository(client, {
    readBindingsAsReconciliationWorker: true
  });
  const ledgerSink = new LedgerBankVerificationSink({
    ledger: new LedgerService(
      new SupabaseLedgerRepository(client, { postAsReconciliationWorker: true })
    ),
    accounts: async (intent) => {
      const resolver = new SupabaseLedgerAccountResolver(client);
      return resolver.resolve(intent.groupId, intent.ledgerAccountId, intent.direction);
    }
  });
  const service = new BankVerificationService({
    repository,
    jobStore: repository,
    referenceVault: createLazyEnvironmentVault(),
    adapterResolver: createProductionBankProviderAdapter,
    ledgerSink,
    ...(options.clock ? { clock: options.clock } : {})
  });
  return new ReconciliationCoordinator(repository, service, options.clock);
}
