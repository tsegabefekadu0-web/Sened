import { randomUUID } from "node:crypto";
import { BankVerificationError } from "./errors";
import type {
  BankVerificationContext,
  BankVerificationEvent,
  BankVerificationIntent,
  BankVerificationReasonCode,
  BankVerificationState,
  ReconciliationClaim,
  ReconciliationJob,
  ReconciliationJobStore
} from "./types";
import type { BankVerificationRepository } from "./types";

export interface ReconciliationBackoffOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_JITTER_RATIO = 0.2;

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function calculateReconciliationBackoff(
  attempt: number,
  options: ReconciliationBackoffOptions = {},
  retryAfterSeconds?: number
): number {
  const requestedMaxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const requestedMaxDelayMs = Number.isFinite(requestedMaxDelay)
    ? Math.min(DEFAULT_MAX_DELAY_MS, Math.max(1, Math.floor(requestedMaxDelay)))
    : DEFAULT_MAX_DELAY_MS;
  const baseDelayMs = Math.min(
    requestedMaxDelayMs,
    boundedInteger(
      options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      1,
      requestedMaxDelayMs,
      Math.min(DEFAULT_BASE_DELAY_MS, requestedMaxDelayMs)
    )
  );
  const maxDelayMs = requestedMaxDelayMs;
  const requestedJitter = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const jitterRatio = Number.isFinite(requestedJitter)
    ? Math.min(1, Math.max(0, requestedJitter))
    : DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const safeAttempt = boundedInteger(attempt, 1, 30, 1);
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (safeAttempt - 1));
  const randomValue = Math.min(1, Math.max(0, random()));
  const jittered = Math.round(exponential * (1 - jitterRatio + 2 * jitterRatio * randomValue));
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.min(maxDelayMs, Math.max(0, (retryAfterSeconds as number) * 1_000))
    : 0;
  return Math.min(maxDelayMs, Math.max(retryAfterMs, jittered));
}

export function nextReconciliationAttemptAt(
  now: Date,
  attempt: number,
  options: ReconciliationBackoffOptions = {},
  retryAfterSeconds?: number
): Date {
  return new Date(now.getTime() + calculateReconciliationBackoff(attempt, options, retryAfterSeconds));
}

function copyJob(job: ReconciliationJob): ReconciliationJob {
  return { ...job };
}

function copyIntent(intent: BankVerificationIntent): BankVerificationIntent {
  return {
    ...intent,
    sealedProviderReference: { ...intent.sealedProviderReference }
  };
}

export interface ReconciliationCoordinatorOutcome {
  readonly state: BankVerificationState;
  readonly reasonCode: BankVerificationReasonCode;
  readonly retryAfterSeconds?: number;
  readonly evidenceFingerprint: string | null;
  readonly providerTransactionIdentityHmac: string | null;
  readonly ledgerEntryId: string | null;
}

export class ReconciliationCoordinator {
  constructor(
    private readonly store: ReconciliationJobStore,
    private readonly verifier: {
      verifyIntent(
        intent: BankVerificationIntent
      ): Promise<ReconciliationCoordinatorOutcome>;
    },
    private readonly clock: () => Date = () => new Date(),
    private readonly backoff: ReconciliationBackoffOptions = {}
  ) {}

  async run(workerId: string, leaseMs: number): Promise<ReconciliationJob | null> {
    const now = this.clock();
    const claim = await this.store.claimNext(workerId, now, leaseMs);
    if (!claim || !claim.job.leaseToken) {
      return null;
    }
    let outcome: ReconciliationCoordinatorOutcome;
    try {
      outcome = await this.verifier.verifyIntent(claim.intent);
    } catch {
      outcome = {
        state: "PENDING_RECONCILIATION",
        reasonCode: "PROVIDER_UNAVAILABLE",
        evidenceFingerprint: null,
        providerTransactionIdentityHmac: null,
        ledgerEntryId: null
      };
    }
    if (outcome.state === "PENDING_RECONCILIATION") {
      const nextAttemptAt = new Date(
        now.getTime() +
          calculateReconciliationBackoff(
            claim.job.attempt,
            this.backoff,
            outcome.retryAfterSeconds
          )
      );
      return this.store.reschedule(
        claim.job.id,
        workerId,
        claim.job.leaseToken,
        outcome.reasonCode,
        nextAttemptAt
      );
    }
    if (outcome.state === "VERIFIED" || outcome.state === "REJECTED") {
      return this.store.finalize(claim.job.id, workerId, claim.job.leaseToken, {
        state: outcome.state,
        reasonCode: outcome.reasonCode,
        evidenceFingerprint: outcome.evidenceFingerprint,
        providerTransactionIdentityHmac: outcome.providerTransactionIdentityHmac,
        ledgerEntryId: outcome.ledgerEntryId
      });
    }
    throw new BankVerificationError("INTEGRITY_FAILURE", "Reconciliation outcome is invalid");
  }
}

export class InMemoryReconciliationJobStore implements ReconciliationJobStore {
  private readonly jobs = new Map<string, ReconciliationJob>();
  private readonly jobsByVerification = new Map<string, string>();
  private readonly intents = new Map<string, BankVerificationIntent>();
  private readonly leaseOwners = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly leaseTokenFactory: () => string;
  private readonly defaultMaxAttempts: number;
  private readonly repository?: BankVerificationRepository;

  constructor(options: {
    readonly repository?: BankVerificationRepository;
    readonly clock?: () => Date;
    readonly idFactory?: () => string;
    readonly leaseTokenFactory?: () => string;
    readonly maxAttempts?: number;
  } = {}) {
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("InMemoryReconciliationJobStore is unavailable outside local development");
    }
    this.repository = options.repository;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.leaseTokenFactory = options.leaseTokenFactory ?? randomUUID;
    this.defaultMaxAttempts = boundedInteger(options.maxAttempts ?? 5, 1, 20, 5);
  }

  async enqueue(intent: BankVerificationIntent, maxAttempts = this.defaultMaxAttempts): Promise<ReconciliationJob> {
    const existingId = this.jobsByVerification.get(intent.id);
    if (existingId) {
      return copyJob(this.requireJob(existingId));
    }
    const now = this.clock().toISOString();
    const job: ReconciliationJob = {
      id: this.idFactory(),
      verificationId: intent.id,
      userId: intent.userId,
      provider: intent.provider,
      state: "QUEUED",
      attempt: 0,
      maxAttempts: boundedInteger(maxAttempts, 1, 20, this.defaultMaxAttempts),
      nextAttemptAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastReasonCode: null,
      terminalAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    this.jobsByVerification.set(intent.id, job.id);
    this.intents.set(intent.id, copyIntent(intent));
    return copyJob(job);
  }

  async schedulePending(
    verificationId: string,
    reasonCode: BankVerificationReasonCode,
    nextAttemptAt: Date
  ): Promise<ReconciliationJob> {
    const jobId = this.jobsByVerification.get(verificationId);
    if (!jobId) {
      throw new BankVerificationError("NOT_FOUND", "Reconciliation job was not found");
    }
    const job = this.requireJob(jobId);
    if (job.state === "QUEUED" || job.state === "RETRY_SCHEDULED") {
      const updated: ReconciliationJob = {
        ...job,
        state: "RETRY_SCHEDULED",
        nextAttemptAt: nextAttemptAt.toISOString(),
        lastReasonCode: reasonCode,
        updatedAt: this.clock().toISOString()
      };
      this.jobs.set(job.id, updated);
      return copyJob(updated);
    }
    return copyJob(job);
  }

  async claimNext(workerId: string, now: Date, leaseMs: number): Promise<ReconciliationClaim | null> {
    if (!workerId || workerId.length > 128) {
      throw new BankVerificationError("INVALID_REQUEST", "workerId is invalid");
    }
    const boundedLeaseMs = Math.min(900_000, Math.max(1_000, Math.floor(leaseMs)));
    const eligible = Array.from(this.jobs.values())
      .filter((job) => {
        const leaseActive = job.leaseExpiresAt !== null && new Date(job.leaseExpiresAt).getTime() > now.getTime();
        return (
          (job.state === "QUEUED" || job.state === "RETRY_SCHEDULED" || (job.state === "CLAIMED" && !leaseActive)) &&
          new Date(job.nextAttemptAt).getTime() <= now.getTime() &&
          job.attempt < job.maxAttempts
        );
      })
      .sort((left, right) => {
        const timeDifference = new Date(left.nextAttemptAt).getTime() - new Date(right.nextAttemptAt).getTime();
        return timeDifference || left.id.localeCompare(right.id);
      });
    const job = eligible[0];
    if (!job) {
      return null;
    }
    const token = this.leaseTokenFactory();
    const updated: ReconciliationJob = {
      ...job,
      state: "CLAIMED",
      attempt: job.attempt + 1,
      leaseToken: token,
      leaseExpiresAt: new Date(now.getTime() + boundedLeaseMs).toISOString(),
      updatedAt: now.toISOString()
    };
    this.jobs.set(job.id, updated);
    this.leaseOwners.set(job.id, workerId);
    const intent = this.intents.get(updated.verificationId);
    if (!intent) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Reconciliation intent is missing");
    }
    return { job: copyJob(updated), intent: copyIntent(intent) };
  }

  async reschedule(
    jobId: string,
    workerId: string,
    leaseToken: string,
    reasonCode: BankVerificationReasonCode,
    nextAttemptAt: Date
  ): Promise<ReconciliationJob> {
    const job = this.requireClaim(jobId, workerId, leaseToken);
    if (job.attempt >= job.maxAttempts) {
      const now = this.clock().toISOString();
      const manual: ReconciliationJob = {
        ...job,
        state: "MANUAL_REVIEW",
        leaseToken: null,
        leaseExpiresAt: null,
        lastReasonCode: "MANUAL_REVIEW_REQUIRED",
        terminalAt: now,
        updatedAt: now
      };
      this.jobs.set(job.id, manual);
      this.leaseOwners.delete(job.id);
      if (this.repository) {
        const updatedIntent = await this.repository.recordResult(
          job.verificationId,
          {
            state: "PENDING_RECONCILIATION",
            reasonCode: "MANUAL_REVIEW_REQUIRED",
            evidenceFingerprint: null,
            providerTransactionIdentityHmac: null,
            ledgerEntryId: null,
            nextAttemptAt: null
          },
          { userId: job.userId }
        );
        this.intents.set(job.verificationId, copyIntent(updatedIntent));
      }
      return copyJob(manual);
    }
    const updated: ReconciliationJob = {
      ...job,
      state: "RETRY_SCHEDULED",
      leaseToken: null,
      leaseExpiresAt: null,
      lastReasonCode: reasonCode,
      nextAttemptAt: nextAttemptAt.toISOString(),
      updatedAt: this.clock().toISOString()
    };
    this.jobs.set(job.id, updated);
    this.leaseOwners.delete(job.id);
    if (this.repository) {
      const intent = this.intents.get(job.verificationId);
      if (intent) {
        const updatedIntent = await this.repository.recordResult(
          job.verificationId,
          {
            state: "PENDING_RECONCILIATION",
            reasonCode,
            evidenceFingerprint: null,
            providerTransactionIdentityHmac: null,
            ledgerEntryId: null,
            nextAttemptAt: nextAttemptAt.toISOString()
          },
          { userId: job.userId }
        );
        this.intents.set(job.verificationId, copyIntent(updatedIntent));
      }
    }
    return copyJob(updated);
  }

  async finalize(
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
  ): Promise<ReconciliationJob> {
    const job = this.requireClaim(jobId, workerId, leaseToken);
    if (result.state === "VERIFIED" && !result.evidenceFingerprint) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Verified evidence fingerprint is required");
    }
    if (result.state === "REJECTED" && result.ledgerEntryId) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Rejected verification cannot have a ledger entry");
    }
    const now = this.clock().toISOString();
    const updated: ReconciliationJob = {
      ...job,
      state: "SUCCEEDED",
      leaseToken: null,
      leaseExpiresAt: null,
      lastReasonCode: result.reasonCode,
      terminalAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, updated);
    this.leaseOwners.delete(job.id);
    if (this.repository) {
      const updatedIntent = await this.repository.recordResult(
        job.verificationId,
        {
          state: result.state,
          reasonCode: result.reasonCode,
          evidenceFingerprint: result.evidenceFingerprint,
          providerTransactionIdentityHmac: result.providerTransactionIdentityHmac,
          ledgerEntryId: result.ledgerEntryId,
          nextAttemptAt: null
        },
        { userId: job.userId }
      );
      this.intents.set(job.verificationId, copyIntent(updatedIntent));
    }
    return copyJob(updated);
  }

  async getJobByVerificationId(verificationId: string): Promise<ReconciliationJob | null> {
    const id = this.jobsByVerification.get(verificationId);
    return id ? copyJob(this.requireJob(id)) : null;
  }

  async planCompensatingReversal(
    verificationId: string,
    reason: string,
    context: BankVerificationContext
  ): Promise<BankVerificationEvent> {
    if (!reason || reason.length > 500) {
      throw new BankVerificationError("INVALID_REQUEST", "Reversal plan reason is invalid");
    }
    const intent = this.intents.get(verificationId);
    if (!intent || intent.userId !== context.userId) {
      throw new BankVerificationError("NOT_FOUND", "Verification intent was not found");
    }
    if (!this.repository) {
      throw new BankVerificationError("STORAGE_FAILURE", "Verification event storage is unavailable");
    }
    return this.repository.appendEvent(
      {
        verificationId,
        userId: context.userId,
        eventType: "REVERSAL_PLANNED",
        state: intent.state,
        reasonCode: intent.reasonCode,
        attempt: 0
      },
      context
    );
  }

  private requireJob(jobId: string): ReconciliationJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new BankVerificationError("NOT_FOUND", "Reconciliation job was not found");
    }
    return job;
  }

  private requireClaim(jobId: string, workerId: string, leaseToken: string): ReconciliationJob {
    const job = this.requireJob(jobId);
    if (
      job.state !== "CLAIMED" ||
      job.leaseToken !== leaseToken ||
      this.leaseOwners.get(jobId) !== workerId
    ) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Reconciliation lease is invalid");
    }
    return job;
  }
}
