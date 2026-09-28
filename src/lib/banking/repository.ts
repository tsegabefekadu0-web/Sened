import { randomUUID } from "node:crypto";
import { BankVerificationError } from "./errors";
import { isUuid } from "@/lib/ledger/rules";
import { formatEtbAmount, toEtbMinorUnits } from "@/lib/ledger/money";
import type {
  BankAccountBinding,
  BankAccountBindingSummary,
  BankVerificationContext,
  BankVerificationEvent,
  BankVerificationIntent,
  BankVerificationReasonCode,
  BankVerificationRepository,
  BankVerificationState,
  CreateBankIntentInput,
  CreateBankIntentResult,
  PublicBankVerification,
  ReconciliationEventType
} from "./types";

export interface InMemoryBankVerificationRepositoryOptions {
  readonly bindings?: readonly BankAccountBinding[];
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

function copyBinding(binding: BankAccountBinding): BankAccountBinding {
  return { ...binding };
}

function copyIntent(intent: BankVerificationIntent): BankVerificationIntent {
  return {
    ...intent,
    sealedProviderReference: { ...intent.sealedProviderReference }
  };
}

function copyEvent(event: BankVerificationEvent): BankVerificationEvent {
  return { ...event };
}

function assertUuid(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new BankVerificationError("INVALID_REQUEST", `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function assertHmac(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new BankVerificationError("INVALID_REQUEST", `${field} is invalid`);
  }
  return value.toLowerCase();
}

function assertAmount(value: string): string {
  try {
    toEtbMinorUnits(value, true);
  } catch (error) {
    throw new BankVerificationError("INVALID_REQUEST", "Verification amount is invalid", { cause: error });
  }
  return formatEtbAmount(value);
}

function eventTypeForState(state: BankVerificationState): ReconciliationEventType {
  if (state === "VERIFIED") {
    return "VERIFIED";
  }
  if (state === "REJECTED") {
    return "REJECTED";
  }
  return "VERIFICATION_PENDING";
}

export function toPublicBankVerification(intent: BankVerificationIntent): PublicBankVerification {
  return {
    verificationId: intent.id,
    provider: intent.provider,
    state: intent.state,
    reasonCode: intent.reasonCode,
    amount: intent.amount,
    currency: intent.currency,
    direction: intent.direction,
    occurredAt: intent.occurredAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt
  };
}

export class InMemoryBankVerificationRepository implements BankVerificationRepository {
  private readonly bindings = new Map<string, BankAccountBinding>();
  private readonly intents = new Map<string, BankVerificationIntent>();
  private readonly events: BankVerificationEvent[] = [];
  private readonly idempotency = new Map<string, string>();
  private readonly providerReferences = new Map<string, string>();
  private readonly providerTransactions = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly eventIdFactory: () => string;

  constructor(options: InMemoryBankVerificationRepositoryOptions = {}) {
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("InMemoryBankVerificationRepository is unavailable outside local development");
    }
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.eventIdFactory = options.eventIdFactory ?? randomUUID;
    for (const binding of options.bindings ?? []) {
      const id = assertUuid(binding.id, "bindingId");
      if (this.bindings.has(id)) {
        throw new BankVerificationError("INVALID_REQUEST", "In-memory bindings must be unique");
      }
      this.bindings.set(id, {
        ...copyBinding(binding),
        id,
        userId: assertUuid(binding.userId, "userId"),
        groupId: assertUuid(binding.groupId, "groupId"),
        tenantId: assertUuid(binding.tenantId, "tenantId"),
        ledgerAccountId: assertUuid(binding.ledgerAccountId, "ledgerAccountId")
      });
    }
  }

  async getBinding(
    bindingId: string,
    context: BankVerificationContext
  ): Promise<BankAccountBinding | null> {
    const id = assertUuid(bindingId, "bindingId");
    const binding = this.bindings.get(id);
    if (!binding || !binding.active || binding.userId !== context.userId.toLowerCase()) {
      return null;
    }
    return copyBinding(binding);
  }

  async listBindings(
    context: BankVerificationContext
  ): Promise<readonly BankAccountBindingSummary[]> {
    const userId = context.userId.toLowerCase();
    return Array.from(this.bindings.values())
      // Inactive bindings are listed, not hidden: a treasurer needs to see that
      // an account exists and is switched off, rather than find it missing.
      .filter((binding) => binding.userId === userId)
      .map((binding) => ({
        id: binding.id,
        groupId: binding.groupId,
        provider: binding.provider,
        currency: binding.currency,
        accountLabel: binding.accountLabel,
        active: binding.active
      }));
  }

  async createIntent(
    input: CreateBankIntentInput,
    context: BankVerificationContext
  ): Promise<CreateBankIntentResult> {
    const userId = assertUuid(context.userId, "userId");
    const bindingId = assertUuid(input.bankAccountBindingId, "bankAccountBindingId");
    const binding = this.bindings.get(bindingId);
    if (!binding || !binding.active || binding.userId !== userId) {
      throw new BankVerificationError("NOT_FOUND", "Bank account binding was not found");
    }
    if (binding.provider !== input.provider || binding.currency !== input.currency) {
      throw new BankVerificationError("INVALID_BINDING", "Bank account binding does not match the request");
    }
    const idempotencyKey = input.idempotencyKey;
    const locator = `${userId}:${idempotencyKey}`;
    const requestFingerprint = assertHmac(input.requestFingerprint, "requestFingerprint");
    const providerReferenceHmac = assertHmac(input.providerReferenceHmac, "providerReferenceHmac");
    const existingId = this.idempotency.get(locator);
    if (existingId) {
      const existing = this.intents.get(existingId);
      if (!existing) {
        throw new BankVerificationError("INTEGRITY_FAILURE", "Idempotent verification is missing");
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new BankVerificationError("IDEMPOTENCY_CONFLICT", "Idempotency key payload conflict");
      }
      return { intent: copyIntent(existing), replayed: true };
    }
    const providerReferenceKey = `${input.provider}:${providerReferenceHmac}`;
    const existingProviderIntent = this.providerReferences.get(providerReferenceKey);
    if (existingProviderIntent) {
      throw new BankVerificationError("IDEMPOTENCY_CONFLICT", "Provider reference is already in use");
    }
    if (input.sealedProviderReference.provider !== input.provider) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Sealed provider reference is invalid");
    }
    if (input.sealedProviderReference.hmac !== providerReferenceHmac) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Provider reference fingerprint is invalid");
    }
    const now = this.clock().toISOString();
    const intent: BankVerificationIntent = {
      id: assertUuid(this.idFactory(), "verificationId"),
      userId,
      groupId: binding.groupId,
      tenantId: binding.tenantId,
      bankAccountBindingId: binding.id,
      ledgerAccountId: binding.ledgerAccountId,
      provider: input.provider,
      providerReferenceHmac,
      sealedProviderReference: { ...input.sealedProviderReference },
      amount: assertAmount(input.amount),
      currency: "ETB",
      direction: input.direction,
      occurredAt: input.occurredAt,
      idempotencyKey,
      requestFingerprint,
      state: "PENDING_RECONCILIATION",
      reasonCode: "AWAITING_PROVIDER_EVIDENCE",
      evidenceFingerprint: null,
      providerTransactionIdentityHmac: null,
      createdAt: now,
      updatedAt: now,
      ledgerEntryId: null
    };
    this.intents.set(intent.id, intent);
    this.idempotency.set(locator, intent.id);
    this.providerReferences.set(providerReferenceKey, intent.id);
    await this.appendEvent(
      {
        verificationId: intent.id,
        userId,
        eventType: "INTENT_CREATED",
        state: intent.state,
        reasonCode: intent.reasonCode,
        attempt: 0
      },
      { userId }
    );
    return { intent: copyIntent(intent), replayed: false };
  }

  async getIntent(
    verificationId: string,
    context: BankVerificationContext
  ): Promise<BankVerificationIntent | null> {
    const id = assertUuid(verificationId, "verificationId");
    const intent = this.intents.get(id);
    if (!intent || intent.userId !== context.userId.toLowerCase()) {
      return null;
    }
    return copyIntent(intent);
  }

  async recordResult(
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
  ): Promise<BankVerificationIntent> {
    const intent = await this.getIntent(verificationId, context);
    if (!intent) {
      throw new BankVerificationError("NOT_FOUND", "Verification intent was not found");
    }
    if (intent.state !== "PENDING_RECONCILIATION" && intent.state !== result.state) {
      throw new BankVerificationError("IDEMPOTENCY_CONFLICT", "Verification state is already final");
    }
    if (result.state === "VERIFIED" && !result.evidenceFingerprint) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Verified evidence fingerprint is required");
    }
    if (result.state === "VERIFIED" && !result.providerTransactionIdentityHmac) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Provider transaction identity is required");
    }
    if (result.state !== "VERIFIED" && result.ledgerEntryId) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Only verified evidence may have a ledger entry");
    }
    if (result.providerTransactionIdentityHmac) {
      const normalizedIdentity = assertHmac(
        result.providerTransactionIdentityHmac,
        "providerTransactionIdentityHmac"
      );
      const identityKey = `${intent.provider}:${normalizedIdentity}`;
      const existing = this.providerTransactions.get(identityKey);
      if (existing && existing !== intent.id) {
        throw new BankVerificationError("IDEMPOTENCY_CONFLICT", "Provider transaction is already claimed");
      }
      this.providerTransactions.set(identityKey, intent.id);
    }
    const updated: BankVerificationIntent = {
      ...intent,
      state: result.state,
      reasonCode: result.reasonCode,
      evidenceFingerprint: result.evidenceFingerprint
        ? assertHmac(result.evidenceFingerprint, "evidenceFingerprint")
        : null,
      providerTransactionIdentityHmac: result.providerTransactionIdentityHmac
        ? assertHmac(result.providerTransactionIdentityHmac, "providerTransactionIdentityHmac")
        : null,
      ledgerEntryId: result.ledgerEntryId,
      updatedAt: this.clock().toISOString()
    };
    this.intents.set(updated.id, updated);
    await this.appendEvent(
      {
        verificationId: updated.id,
        userId: updated.userId,
        eventType: eventTypeForState(updated.state),
        state: updated.state,
        reasonCode: updated.reasonCode,
        attempt: 0
      },
      context
    );
    return copyIntent(updated);
  }

  async appendEvent(
    event: Omit<BankVerificationEvent, "id" | "createdAt">,
    context: BankVerificationContext
  ): Promise<BankVerificationEvent> {
    const intent = await this.getIntent(event.verificationId, context);
    if (!intent) {
      throw new BankVerificationError("NOT_FOUND", "Verification intent was not found");
    }
    const created: BankVerificationEvent = {
      ...event,
      id: assertUuid(this.eventIdFactory(), "eventId"),
      createdAt: this.clock().toISOString()
    };
    this.events.push(created);
    return copyEvent(created);
  }

  getEvents(verificationId: string): readonly BankVerificationEvent[] {
    return Object.freeze(this.events.filter((event) => event.verificationId === verificationId).map(copyEvent));
  }

  getIntentUnsafe(verificationId: string): BankVerificationIntent | null {
    const intent = this.intents.get(verificationId);
    return intent ? copyIntent(intent) : null;
  }
}
