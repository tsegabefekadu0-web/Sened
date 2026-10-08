import { BankVerificationError } from "./errors";
import { maskBankReference } from "./referenceMask";
import type { BankProvider, BankReferenceVault, SealedProviderReference } from "./types";

/**
 * One-off backfill of `bank_verification_intents.reference_display`.
 *
 * Rows created before the column existed have no masked reference, and SQL
 * cannot mask what it cannot decrypt, so a process that holds the vault key
 * does it: decrypt, mask with the same `maskBankReference` the server uses at
 * intent creation, write the mask back. This file is the whole algorithm over
 * two small ports (`BackfillStore`, a vault), so it is tested with fakes and
 * the script (`scripts/backfill-reference-display.ts`) only wires real ones.
 *
 * Properties, each covered by a test:
 *  - Idempotent: only rows with no display are listed, and the write never
 *    overwrites one. Running it twice changes nothing the second time.
 *  - Dry-run by default: nothing is written unless `apply` is true.
 *  - Bounded: at most `batchSize` rows per read and `maxRows` per run.
 *  - Never logs or returns plaintext. The summary holds counts, and the failure
 *    list holds verification ids with an error code, never a reference.
 *  - A row it cannot handle (unreadable, other key version, nothing safe to
 *    show) is skipped and counted, never fatal, never guessed.
 */

export interface BackfillRow {
  readonly verificationId: string;
  readonly provider: BankProvider;
  readonly ciphertext: string;
  readonly hmac: string;
  readonly keyVersion: string;
}

export interface BackfillStore {
  /** Rows with no display, ordered by id, strictly after `after` when given. */
  listPending(after: string | null, limit: number): Promise<readonly BackfillRow[]>;
  /** Write a display only if the row still has none. Resolves true when it wrote. */
  setDisplay(verificationId: string, display: string): Promise<boolean>;
}

export interface BackfillOptions {
  readonly store: BackfillStore;
  readonly vault: BankReferenceVault;
  /** Write the masks. Without it nothing is changed and the summary says what would be. */
  readonly apply?: boolean;
  readonly batchSize?: number;
  readonly maxRows?: number;
  /** Rows sealed under another key version cannot be opened with this vault and are skipped. */
  readonly keyVersion?: string;
  /** Receives progress lines. Never given a reference. */
  readonly log?: (line: string) => void;
}

export interface BackfillFailure {
  readonly verificationId: string;
  readonly code: string;
}

export interface BackfillSummary {
  readonly mode: "dry-run" | "apply";
  readonly scanned: number;
  /** Rows whose mask was written (apply) or would be (dry-run). */
  readonly masked: number;
  /** Rows that already had a display by the time the write ran (another run won). */
  readonly alreadySet: number;
  /** Opened fine, but the reference has nothing safe to show (a single character, or outside printable ASCII). */
  readonly unmaskable: number;
  /** Sealed under a key version other than the one this run holds. */
  readonly otherKeyVersion: number;
  /** Could not be opened (wrong key, tampering). Ids and codes only. */
  readonly failed: readonly BackfillFailure[];
  /** True when the run stopped at `maxRows` and more rows may remain. */
  readonly truncated: boolean;
}

export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 500;
export const DEFAULT_MAX_ROWS = 1000;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BankVerificationError("INVALID_REQUEST", `Backfill limit must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export async function backfillReferenceDisplay(options: BackfillOptions): Promise<BackfillSummary> {
  const apply = options.apply === true;
  const batchSize = boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const maxRows = boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 1_000_000);
  const log = options.log ?? (() => undefined);

  let scanned = 0;
  let masked = 0;
  let alreadySet = 0;
  let unmaskable = 0;
  let otherKeyVersion = 0;
  let truncated = false;
  const failed: BackfillFailure[] = [];
  let after: string | null = null;

  while (scanned < maxRows) {
    const limit = Math.min(batchSize, maxRows - scanned);
    const rows: readonly BackfillRow[] = await options.store.listPending(after, limit);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      scanned += 1;
      after = row.verificationId;
      if (options.keyVersion !== undefined && row.keyVersion !== options.keyVersion) {
        otherKeyVersion += 1;
        continue;
      }
      let display: string | null;
      try {
        const sealed: SealedProviderReference = {
          provider: row.provider,
          ciphertext: row.ciphertext,
          hmac: row.hmac,
          keyVersion: row.keyVersion
        };
        // The plaintext lives only inside this expression: it is masked and dropped.
        display = maskBankReference(await options.vault.open(sealed));
      } catch (error) {
        failed.push({
          verificationId: row.verificationId,
          code: error instanceof BankVerificationError ? error.code : "UNKNOWN"
        });
        continue;
      }
      if (display === null) {
        unmaskable += 1;
        continue;
      }
      if (!apply) {
        masked += 1;
        continue;
      }
      if (await options.store.setDisplay(row.verificationId, display)) {
        masked += 1;
      } else {
        alreadySet += 1;
      }
    }
    log(`scanned ${scanned} rows, ${masked} ${apply ? "updated" : "would be updated"}`);
    if (rows.length < limit) {
      break;
    }
  }
  if (scanned >= maxRows) {
    // Whether anything is left is unknown without another read; say so rather than guess.
    const rest: readonly BackfillRow[] = await options.store.listPending(after, 1);
    truncated = rest.length > 0;
  }

  return {
    mode: apply ? "apply" : "dry-run",
    scanned,
    masked,
    alreadySet,
    unmaskable,
    otherKeyVersion,
    failed,
    truncated
  };
}
