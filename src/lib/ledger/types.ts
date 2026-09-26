export const LEDGER_ENTRY_TYPES = [
  "journal",
  "contribution",
  "disbursement",
  "adjustment",
  "correction"
] as const;

export const LEDGER_POSTING_DIRECTIONS = ["debit", "credit"] as const;

export const LEDGER_ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense"
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export type LedgerPostingDirection = (typeof LEDGER_POSTING_DIRECTIONS)[number];
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];
export type LedgerMembershipRole = "owner" | "treasurer" | "member";
export type LedgerMembershipStatus = "active" | "inactive";

export interface LedgerPostingInput {
  readonly accountId: string;
  readonly direction: LedgerPostingDirection;
  readonly amount: string;
}

export interface LedgerEntryRequest {
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly entryType: LedgerEntryType;
  readonly correctsEntryId?: string;
  readonly rationale?: string;
  readonly postings: readonly LedgerPostingInput[];
}

export interface LedgerPosting extends LedgerPostingInput {
  readonly id: string;
  readonly ordinal: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly groupId: string;
  readonly tenantId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly entryType: LedgerEntryType;
  readonly correctsEntryId: string | null;
  readonly rationale: string | null;
  readonly actorId: string;
  readonly nonce: string;
  readonly previousHash: string;
  readonly entryHash: string;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly postings: readonly LedgerPosting[];
}

export interface LedgerChainHead {
  readonly groupId: string;
  readonly tenantId: string;
  readonly lastSequence: string;
  readonly lastHash: string;
}

export interface LedgerActorContext {
  readonly actorId: string;
}

export interface AppendLedgerEntryResult {
  readonly entry: LedgerEntry;
  readonly replayed: boolean;
}
