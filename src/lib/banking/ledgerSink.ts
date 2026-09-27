import { LedgerService } from "@/lib/ledger";
import { BankVerificationError } from "./errors";
import type { BankVerificationIntent, BankVerificationLedgerSink } from "./types";

/**
 * Bank truth → committed ledger.
 *
 * This is the step that makes money real. `BankVerificationService` calls
 * `postVerifiedContribution` the moment a provider returns `VERIFIED`, and until
 * something implements this interface the verified result stopped there: the UI
 * could say a bank confirmed a contribution while no balanced, hash-chained
 * entry existed anywhere. `BankVerificationLedgerSink` was declared in
 * `types.ts:244` and had zero implementations.
 *
 * Two rules govern the shape of this file.
 *
 * **The entry goes through `LedgerService.append`, never a direct write.** That
 * is what enforces Σ debits = Σ credits and the SHA-256 chain. The same rule
 * binds AGENT-3's draw payouts (`src/lib/draw/service.ts:285`), and bypassing it
 * in one place would defeat the product's central claim in exactly the place
 * that matters most.
 *
 * **An unresolved account is a refusal, not a guess.** The counter-account is
 * per group and per direction — a pot's cash account cannot also be its income
 * account — so it is supplied by a resolver. If the resolver cannot answer, this
 * returns `null` and no entry is written. The verification stays `VERIFIED`,
 * because the bank did verify it, and the missing ledger entry stays visible as
 * a `null` `ledgerEntryId` rather than being papered over with a plausible
 * account code.
 */

/** The two accounts a verified bank movement needs. */
export interface VerifiedContributionAccounts {
  /** The group's pot account. Normally `intent.ledgerAccountId`. */
  readonly cashAccountId: string;
  /**
   * What the movement is recognised as: an income account for money arriving,
   * an expense account for money leaving.
   */
  readonly counterAccountId: string;
}

export interface BankLedgerSinkOptions {
  readonly ledger: Pick<LedgerService, "append">;
  /**
   * Resolve the group's accounts for one verification.
   *
   * Return `null` when the group has no such account configured. That is the
   * honest answer and it is the one this sink acts on.
   */
  readonly accounts: (
    intent: BankVerificationIntent
  ) => VerifiedContributionAccounts | null | Promise<VerifiedContributionAccounts | null>;
  readonly clock?: () => Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Namespaced so a bank posting can never collide with the caller's own
 * idempotency key — a voice draft and a bank confirmation for the same
 * contribution are different events and must both be recorded.
 */
export function bankLedgerIdempotencyKey(intent: BankVerificationIntent): string {
  return `bank-verified-${intent.idempotencyKey}`;
}

export class LedgerBankVerificationSink implements BankVerificationLedgerSink {
  private readonly ledger: Pick<LedgerService, "append">;
  private readonly accounts: BankLedgerSinkOptions["accounts"];
  private readonly clock: () => Date;

  constructor(options: BankLedgerSinkOptions) {
    this.ledger = options.ledger;
    this.accounts = options.accounts;
    this.clock = options.clock ?? (() => new Date());
  }

  async postVerifiedContribution(intent: BankVerificationIntent): Promise<string | null> {
    // The service only calls this on a verified result, but the sink is public
    // and the invariant is cheap to assert. Posting a contribution for an
    // unverified intent would put money in the pot on the strength of a claim.
    if (intent.state !== "VERIFIED") {
      throw new BankVerificationError(
        "INTEGRITY_FAILURE",
        "Only a verified bank result may be posted to the ledger"
      );
    }

    const resolved = await this.accounts(intent);
    if (!resolved) {
      return null;
    }

    const { cashAccountId, counterAccountId } = resolved;
    if (
      !UUID_PATTERN.test(cashAccountId) ||
      !UUID_PATTERN.test(counterAccountId) ||
      cashAccountId === counterAccountId
    ) {
      // A pot account posted against itself would balance arithmetically and
      // mean nothing. Treat it as unconfigured.
      return null;
    }

    // Money arriving debits the asset and recognises income; money leaving does
    // the reverse against an expense. Both are two-posting entries, so Σ debits
    // = Σ credits holds by construction and the ledger re-checks it anyway.
    const inbound = intent.direction === "inbound";
    const result = await this.ledger.append(
      {
        groupId: intent.groupId,
        idempotencyKey: bankLedgerIdempotencyKey(intent),
        occurredAt: intent.occurredAt || this.clock().toISOString(),
        entryType: inbound ? "contribution" : "disbursement",
        postings: [
          {
            accountId: inbound ? cashAccountId : counterAccountId,
            direction: "debit",
            amount: intent.amount
          },
          {
            accountId: inbound ? counterAccountId : cashAccountId,
            direction: "credit",
            amount: intent.amount
          }
        ]
      },
      { actorId: intent.userId }
    );

    return result.entry.id;
  }
}

/**
 * The resolver the product should actually use.
 *
 * There is no canonical account code seeded per group yet — AGENT-3 filed this
 * as R-5 and asked whether one exists. Until it does, the honest implementation
 * refuses rather than inventing `POT_CASH` / `CONTRIBUTION_INCOME` codes that no
 * group has, which would post entries against accounts the database rejects.
 * Wiring this to the real per-group account table is the whole remaining task.
 */
export function unconfiguredAccounts(): null {
  return null;
}
