/**
 * One-off: fill `bank_verification_intents.reference_display` for verifications
 * created before migration 20261008100000_bank_reference_display.sql.
 *
 * Why a script and not SQL: the reference is stored encrypted (AES-256-GCM) and
 * only the server holds the key, so only a server-side process can derive the
 * masked form (`••••2F42`). New rows get theirs at intent creation; this covers
 * the old ones. Entries without it simply show no reference until it has run.
 *
 * Usage (from the repo root, on a machine that has the production vault keys):
 *
 *   npx vite-node scripts/backfill-reference-display.ts            # dry run
 *   npx vite-node scripts/backfill-reference-display.ts --apply    # write
 *     [--batch-size 100]   rows per read, 1-500
 *     [--max-rows 1000]    stop after this many rows this run; run again for the rest
 *
 * Environment (server secrets; never put them in a client bundle):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   BANK_REFERENCE_ENCRYPTION_KEY, BANK_REFERENCE_HMAC_KEY,
 *   BANK_REFERENCE_KEY_VERSION (optional, default v1)
 *
 * Safe to re-run. Dry-run is the default and writes nothing. Output is counts
 * and verification ids, never a reference. Exit code: 0 on success, 1 if any
 * row could not be opened or on a configuration or database error.
 *
 * Relative imports on purpose: vite-node does not read this project's `@/` alias.
 */
import { createClient } from "@supabase/supabase-js";

import { BankVerificationError } from "../src/lib/banking/errors";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ROWS,
  MAX_BATCH_SIZE,
  backfillReferenceDisplay,
  type BackfillRow,
  type BackfillStore
} from "../src/lib/banking/referenceBackfill";
import { createAesGcmReferenceVaultFromEnvironment } from "../src/lib/banking/vault";

function parseArgs(argv: readonly string[]): { apply: boolean; batchSize: number; maxRows: number } {
  let apply = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let maxRows = DEFAULT_MAX_ROWS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--batch-size" || arg === "--max-rows") {
      const raw = argv[(index += 1)];
      if (raw === undefined || !/^\d{1,9}$/.test(raw)) {
        throw new Error(`${arg} needs a whole number`);
      }
      if (arg === "--batch-size") {
        batchSize = Number(raw);
      } else {
        maxRows = Number(raw);
      }
    } else {
      throw new Error(`Unknown argument: ${arg} (expected --apply, --batch-size N, --max-rows N)`);
    }
  }
  if (batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be 1-${MAX_BATCH_SIZE}`);
  }
  if (maxRows < 1) {
    throw new Error("--max-rows must be at least 1");
  }
  return { apply, batchSize, maxRows };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function isRow(value: unknown): value is BackfillRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.verificationId === "string" &&
    (row.provider === "telebirr" || row.provider === "cbe" || row.provider === "awash") &&
    typeof row.ciphertext === "string" &&
    typeof row.hmac === "string" &&
    typeof row.keyVersion === "string"
  );
}

function supabaseStore(url: string, serviceKey: string): BackfillStore {
  const client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
  });
  return {
    async listPending(after, limit) {
      const { data, error } = await client.rpc("list_bank_reference_display_backfill_v1", {
        p_after: after,
        p_limit: limit
      });
      if (error) {
        throw new Error(`list_bank_reference_display_backfill_v1 failed (${error.code ?? "no code"})`);
      }
      if (!Array.isArray(data) || !data.every(isRow)) {
        throw new Error("list_bank_reference_display_backfill_v1 returned an unexpected shape");
      }
      return data;
    },
    async setDisplay(verificationId, display) {
      const { data, error } = await client.rpc("set_bank_reference_display_v1", {
        p_verification_id: verificationId,
        p_reference_display: display
      });
      if (error) {
        throw new Error(`set_bank_reference_display_v1 failed for ${verificationId} (${error.code ?? "no code"})`);
      }
      return data === true;
    }
  };
}

async function main(): Promise<number> {
  const { apply, batchSize, maxRows } = parseArgs(process.argv.slice(2));
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const vault = createAesGcmReferenceVaultFromEnvironment();
  const keyVersion = process.env.BANK_REFERENCE_KEY_VERSION?.trim() || "v1";

  console.log(apply ? "APPLY: masked references will be written." : "DRY RUN: nothing will be written. Pass --apply to write.");
  const summary = await backfillReferenceDisplay({
    store: supabaseStore(url, serviceKey),
    vault,
    apply,
    batchSize,
    maxRows,
    keyVersion,
    log: (line) => console.log(line)
  });

  console.log(
    JSON.stringify(
      {
        mode: summary.mode,
        scanned: summary.scanned,
        [apply ? "updated" : "wouldUpdate"]: summary.masked,
        alreadySet: summary.alreadySet,
        unmaskable: summary.unmaskable,
        otherKeyVersion: summary.otherKeyVersion,
        failed: summary.failed.length,
        truncated: summary.truncated
      },
      null,
      2
    )
  );
  for (const failure of summary.failed) {
    console.error(`could not open ${failure.verificationId}: ${failure.code}`);
  }
  if (summary.truncated) {
    console.log("Stopped at --max-rows; run again to continue.");
  }
  return summary.failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Configuration and database errors only; none of them carries a reference.
    console.error(error instanceof BankVerificationError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "backfill failed");
    process.exitCode = 1;
  }
);
