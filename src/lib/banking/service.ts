import { createHash, createHmac } from "node:crypto";
import { isUuid } from "@/lib/ledger/rules";
import { createProductionBankProviderAdapter } from "./adapter";
import { BankVerificationError, isBankVerificationError } from "./errors";
import { assessBankProviderResult } from "./matching";
import {
  InMemoryBankVerificationRepository,
  toPublicBankVerification
} from "./repository";
import {
  calculateReconciliationBackoff,
  InMemoryReconciliationJobStore
} from "./reconciliation";
import {
  bankVerificationRequestSchema,
  validateNormalizedBankProviderResult
} from "./schemas";
import type {
  BankProvider,
  BankProviderAdapter,
  BankProviderResult,
  BankReferenceVault,
  BankVerificationContext,
  BankVerificationIntent,
  BankVerificationLedgerSink,
  BankVerificationRepository,
  BankVerificationRequest,
  BankVerificationResult,
  CreateBankIntentInput,
  PublicBankVerification,
  ReconciliationJobStore,
  ReconciliationVerificationOutcome
} from "./types";
import { InMemoryReferenceVault, createProviderReferenceHmac } from "./vault";
import type { BankAccountBinding } from "./types";

export interface BankVerificationServiceOptions {
  readonly repository: BankVerificationRepository;
  readonly referenceVault: BankReferenceVault;
  readonly adapterResolver: (provider: BankProvider) => BankProviderAdapter;
  readonly jobStore?: ReconciliationJobStore;
  readonly ledgerSink?: BankVerificationLedgerSink;
  readonly clock?: () => Date;
  readonly hmacKey?: string | Buffer;
  readonly backoff?: {
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly jitterRatio?: number;
    readonly random?: () => number;
  };
  readonly maxAttempts?: number;
}

function parseRequest(input: unknown): BankVerificationRequest {
  const parsed = bankVerificationRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new BankVerificationError("INVALID_REQUEST", "Bank verification request is invalid");
  }
  return parsed.data;
}

function canonicalRequestFingerprint(
  request: BankVerificationRequest,
  bindingId: string,
  providerReferenceHmac: string
): string {
  return createHash("sha256")
    .update(
      [
        "sened-bank-verification-request-v1",
        request.provider,
        bindingId,
        providerReferenceHmac,
        request.amount,
        request.currency,
        request.direction,
        request.occurredAt,
        request.idempotencyKey
      ].join("\u0000"),
      "utf8"
    )
    .digest("hex");
}

function evidenceFingerprint(
  provider: BankProvider,
  evidence: NonNullable<BankProviderResult["evidence"]>,
  key: string | Buffer
): string {
  return createHmac("sha256", key)
    .update(
      [
        "sened-bank-evidence-v1",
        provider,
        evidence.providerTransactionId,
        evidence.amount,
        evidence.currency,
        evidence.direction,
        evidence.senderFingerprint,
        evidence.receiverFingerprint,
        evidence.occurredAt,
        evidence.settledAt
      ].join("\u0000"),
      "utf8"
    )
    .digest("hex");
}

function expectedFromBinding(intent: BankVerificationIntent, binding: BankAccountBinding) {
  return {
    amount: intent.amount,
    currency: intent.currency,
    direction: intent.direction,
    senderFingerprint: binding.senderFingerprintHmac,
    receiverFingerprint: binding.receiverFingerprintHmac,
    occurredAt: intent.occurredAt
  };
}

function asPendingResult(provider: BankProvider, error: unknown): BankProviderResult {
  if (isBankVerificationError(error) && error.code === "PROVIDER_NOT_CONFIGURED") {
    throw error;
  }
  if (isBankVerificationError(error) && error.code === "INVALID_PROVIDER_RESULT") {
    return { provider, kind: "invalid_response" };
  }
  if (isBankVerificationError(error) && error.code === "PROVIDER_UNAVAILABLE") {
    return { provider, kind: "provider_error" };
  }
  const value =
    typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : null;
  const status = typeof value?.status === "number"
    ? value.status
    : typeof value?.statusCode === "number"
      ? value.statusCode
      : undefined;
  const kind = typeof value?.kind === "string" ? value.kind : undefined;
  const retryAfterSeconds = isBankVerificationError(error)
    ? error.retryAfterSeconds
    : typeof value?.retryAfterSeconds === "number"
      ? value.retryAfterSeconds
      : undefined;
  if (kind === "timeout" || value?.name === "AbortError" || value?.code === "ETIMEDOUT") {
    return { provider, kind: "timeout" };
  }
  if (kind === "rate_limited" || status === 429) {
    return {
      provider,
      kind: "rate_limited",
      retryAfterSeconds: retryAfterSeconds === undefined ? 0 : retryAfterSeconds
    };
  }
  if (kind === "unsettled" || kind === "not_found") {
    return { provider, kind };
  }
  return {
    provider,
    kind: "provider_error",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  };
}

function requireHmacKey(service: BankVerificationService): string | Buffer {
  if (service.hmacKey) {
    return service.hmacKey;
  }
  const configured = process.env.BANK_REFERENCE_HMAC_KEY?.trim();
  if (!configured) {
    throw new BankVerificationError(
      "PROVIDER_NOT_CONFIGURED",
      "Bank reference protection is not configured"
    );
  }
  const decoded = Buffer.from(configured, "base64");
  return decoded.length === 32 ? decoded : configured;
}

export class BankVerificationService {
  private readonly repository: BankVerificationRepository;
  private readonly referenceVault: BankReferenceVault;
  private readonly adapterResolver: (provider: BankProvider) => BankProviderAdapter;
  private readonly jobStore?: ReconciliationJobStore;
  private readonly ledgerSink?: BankVerificationLedgerSink;
  private readonly clock: () => Date;
  readonly hmacKey?: string | Buffer;
  private readonly backoff: NonNullable<BankVerificationServiceOptions["backoff"]>;
  private readonly maxAttempts: number;

  constructor(options: BankVerificationServiceOptions) {
    this.repository = options.repository;
    this.referenceVault = options.referenceVault;
    this.adapterResolver = options.adapterResolver;
    this.jobStore = options.jobStore;
    this.ledgerSink = options.ledgerSink;
    this.clock = options.clock ?? (() => new Date());
    this.hmacKey = options.hmacKey;
    this.backoff = options.backoff ?? {};
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  async create(
    requestInput: unknown,
    context: BankVerificationContext
  ): Promise<BankVerificationResult> {
    const request = parseRequest(requestInput);
    if (!isUuid(context.userId)) {
      throw new BankVerificationError("UNAUTHORIZED", "Authenticated user context is invalid");
    }
    const adapter = this.adapterResolver(request.provider);
    if (!adapter.isConfigured()) {
      throw new BankVerificationError(
        "PROVIDER_NOT_CONFIGURED",
        "The bank provider adapter is not configured"
      );
    }
    const binding = await this.repository.getBinding(request.bankAccountBindingId, context);
    if (!binding) {
      throw new BankVerificationError("NOT_FOUND", "Bank account binding was not found");
    }
    if (binding.provider !== request.provider || binding.currency !== request.currency) {
      throw new BankVerificationError("INVALID_BINDING", "Bank account binding does not match the request");
    }
    const key = requireHmacKey(this);
    const providerReferenceHmac = createProviderReferenceHmac(
      request.provider,
      request.providerReference,
      key
    );
    const sealedProviderReference = await this.referenceVault.seal(
      request.provider,
      request.providerReference
    );
    if (sealedProviderReference.hmac !== providerReferenceHmac) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Provider reference protection failed");
    }
    const requestFingerprint = canonicalRequestFingerprint(
      request,
      binding.id,
      providerReferenceHmac
    );
    const createInput: CreateBankIntentInput = {
      bankAccountBindingId: binding.id,
      provider: request.provider,
      providerReferenceHmac,
      sealedProviderReference,
      amount: request.amount,
      currency: request.currency,
      direction: request.direction,
      occurredAt: request.occurredAt,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint
    };
    const created = await this.repository.createIntent(createInput, context);
    if (this.jobStore) {
      await this.jobStore.enqueue(created.intent, this.maxAttempts);
    }
    if (created.replayed) {
      return {
        verification: toPublicBankVerification(created.intent),
        replayed: true
      };
    }

    let providerResult: BankProviderResult;
    try {
      const rawResult = await adapter.verify({
        provider: request.provider,
        transactionReference: request.providerReference,
        accountFingerprintHmac: binding.accountFingerprintHmac
      });
      providerResult = validateNormalizedBankProviderResult(request.provider, rawResult);
      if (providerResult.provider !== request.provider) {
        providerResult = { provider: request.provider, kind: "invalid_response" };
      }
    } catch (error) {
      providerResult = asPendingResult(request.provider, error);
    }

    const assessment = assessBankProviderResult(providerResult, expectedFromBinding(created.intent, binding));
    const now = this.clock();
    const keyForFingerprint = requireHmacKey(this);
    const evidence = assessment.evidence;
    const evidenceHash = evidence ? evidenceFingerprint(request.provider, evidence, keyForFingerprint) : null;
    const transactionIdentityHash = evidence
      ? createProviderReferenceHmac(request.provider, evidence.providerTransactionId, keyForFingerprint)
      : null;
    let ledgerEntryId: string | null = null;
    if (assessment.state === "VERIFIED" && this.ledgerSink) {
      ledgerEntryId = await this.ledgerSink.postVerifiedContribution(created.intent);
    }
    const nextAttemptAt =
      assessment.state === "PENDING_RECONCILIATION"
        ? new Date(
            now.getTime() +
              calculateReconciliationBackoff(1, this.backoff, assessment.retryAfterSeconds)
          ).toISOString()
        : null;
    const updated = await this.repository.recordResult(
      created.intent.id,
      {
        state: assessment.state,
        reasonCode: assessment.reasonCode,
        evidenceFingerprint: evidenceHash,
        providerTransactionIdentityHmac: transactionIdentityHash,
        ledgerEntryId,
        nextAttemptAt
      },
      context
    );
    if (assessment.state === "PENDING_RECONCILIATION" && this.jobStore?.schedulePending && nextAttemptAt) {
      await this.jobStore.schedulePending(created.intent.id, assessment.reasonCode, new Date(nextAttemptAt));
    }
    return {
      verification: toPublicBankVerification(updated),
      replayed: false
    };
  }

  async get(verificationId: string, context: BankVerificationContext): Promise<PublicBankVerification> {
    if (!isUuid(verificationId)) {
      throw new BankVerificationError("NOT_FOUND", "Verification was not found");
    }
    const intent = await this.repository.getIntent(verificationId, context);
    if (!intent) {
      throw new BankVerificationError("NOT_FOUND", "Verification was not found");
    }
    return toPublicBankVerification(intent);
  }

  async verifyIntent(intent: BankVerificationIntent): Promise<ReconciliationVerificationOutcome> {
    const adapter = this.adapterResolver(intent.provider);
    if (!adapter.isConfigured()) {
      return {
        state: "PENDING_RECONCILIATION",
        reasonCode: "PROVIDER_UNAVAILABLE",
        evidenceFingerprint: null,
        providerTransactionIdentityHmac: null,
        ledgerEntryId: null
      };
    }
    const binding = await this.repository.getBinding(intent.bankAccountBindingId, {
      userId: intent.userId
    });
    if (!binding) {
      throw new BankVerificationError("NOT_FOUND", "Bank account binding was not found");
    }
    const reference = await this.referenceVault.open(intent.sealedProviderReference);
    let result: BankProviderResult;
    try {
      const rawResult = await adapter.verify({
        provider: intent.provider,
        transactionReference: reference,
        accountFingerprintHmac: binding.accountFingerprintHmac
      });
      result = validateNormalizedBankProviderResult(intent.provider, rawResult);
      if (result.provider !== intent.provider) {
        result = { provider: intent.provider, kind: "invalid_response" };
      }
    } catch (error) {
      result = asPendingResult(intent.provider, error);
    }
    const assessment = assessBankProviderResult(result, expectedFromBinding(intent, binding));
    const key = requireHmacKey(this);
    const evidenceHash = assessment.evidence
      ? evidenceFingerprint(intent.provider, assessment.evidence, key)
      : null;
    const identityHash = assessment.evidence
      ? createProviderReferenceHmac(intent.provider, assessment.evidence.providerTransactionId, key)
      : null;
    let ledgerEntryId: string | null = null;
    if (assessment.state === "VERIFIED" && this.ledgerSink) {
      ledgerEntryId = await this.ledgerSink.postVerifiedContribution(intent);
    }
    return {
      state: assessment.state,
      reasonCode: assessment.reasonCode,
      ...(assessment.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: assessment.retryAfterSeconds }),
      evidenceFingerprint: evidenceHash,
      providerTransactionIdentityHmac: identityHash,
      ledgerEntryId
    };
  }

  planCompensatingReversal(verificationId: string, reason: string, context: BankVerificationContext) {
    if (!this.jobStore) {
      throw new BankVerificationError("STORAGE_FAILURE", "Reconciliation storage is unavailable");
    }
    return this.jobStore.planCompensatingReversal(verificationId, reason, context);
  }
}

export interface InMemoryBankVerificationServiceOptions {
  readonly bindings: readonly BankAccountBinding[];
  readonly adapters: Partial<Record<BankProvider, BankProviderAdapter>>;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly leaseTokenFactory?: () => string;
  readonly maxAttempts?: number;
  readonly hmacKey?: string | Buffer;
  readonly backoff?: BankVerificationServiceOptions["backoff"];
  readonly ledgerSink?: BankVerificationLedgerSink;
}

export function createInMemoryBankVerificationService(
  options: InMemoryBankVerificationServiceOptions
): BankVerificationService {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    throw new Error("In-memory bank verification is unavailable outside local development");
  }
  const repository = new InMemoryBankVerificationRepository({
    bindings: options.bindings,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.eventIdFactory ? { eventIdFactory: options.eventIdFactory } : {})
  });
  const jobStore = new InMemoryReconciliationJobStore({
    repository,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.leaseTokenFactory ? { leaseTokenFactory: options.leaseTokenFactory } : {}),
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {})
  });
  const hmacKey = options.hmacKey ?? Buffer.alloc(32, 7);
  return new BankVerificationService({
    repository,
    jobStore,
    referenceVault: new InMemoryReferenceVault(hmacKey),
    adapterResolver: (provider) => options.adapters[provider] ?? createProductionBankProviderAdapter(provider),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hmacKey ? { hmacKey: options.hmacKey } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.ledgerSink ? { ledgerSink: options.ledgerSink } : {}),
    hmacKey
  });
}
