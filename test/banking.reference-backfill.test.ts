import { afterEach, describe, expect, it, vi } from "vitest";

import { BankVerificationError } from "@/lib/banking/errors";
import { backfillReferenceDisplay, type BackfillRow, type BackfillStore } from "@/lib/banking/referenceBackfill";
import { createAesGcmReferenceVaultFromEnvironment } from "@/lib/banking/vault";

const B = "••••";
const enc = Buffer.alloc(32, 3).toString("base64");
const mac = Buffer.alloc(32, 4).toString("base64");

function useKeys(version = "v1") {
  vi.stubEnv("BANK_REFERENCE_ENCRYPTION_KEY", enc);
  vi.stubEnv("BANK_REFERENCE_HMAC_KEY", mac);
  vi.stubEnv("BANK_REFERENCE_KEY_VERSION", version);
  return createAesGcmReferenceVaultFromEnvironment();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

/** An in-memory stand-in for the two service-role RPCs, with the same semantics. */
function fakeStore(rows: BackfillRow[]) {
  const displays = new Map<string, string>();
  const calls = { list: [] as Array<[string | null, number]>, set: [] as string[] };
  const store: BackfillStore = {
    async listPending(after, limit) {
      calls.list.push([after, limit]);
      return rows
        .filter((row) => !displays.has(row.verificationId) && (after === null || row.verificationId > after))
        .sort((a, b) => a.verificationId.localeCompare(b.verificationId))
        .slice(0, limit);
    },
    async setDisplay(verificationId, display) {
      calls.set.push(verificationId);
      if (!/^•{4}[!-~]{1,4}$/.test(display)) {
        throw new Error("bank_invalid_request");
      }
      if (displays.has(verificationId)) {
        return false;
      }
      displays.set(verificationId, display);
      return true;
    }
  };
  return { store, displays, calls };
}

async function seal(vault: ReturnType<typeof useKeys>, n: number, reference: string, version = "v1"): Promise<BackfillRow> {
  const sealed = await vault.seal("telebirr", reference);
  return { verificationId: id(n), provider: "telebirr", ciphertext: sealed.ciphertext, hmac: sealed.hmac, keyVersion: version };
}

describe("backfillReferenceDisplay", () => {
  it("is a dry run by default: counts what it would do and writes nothing", async () => {
    const vault = useKeys();
    const { store, displays, calls } = fakeStore([await seal(vault, 1, "FT26280ABCD2F42"), await seal(vault, 2, "C0970153")]);

    const summary = await backfillReferenceDisplay({ store, vault });

    expect(summary).toMatchObject({ mode: "dry-run", scanned: 2, masked: 2, failed: [], truncated: false });
    expect(calls.set).toEqual([]);
    expect(displays.size).toBe(0);
  });

  it("with apply, decrypts with the real AES vault and writes the same mask the server computes", async () => {
    const vault = useKeys();
    const { store, displays } = fakeStore([await seal(vault, 1, "FT26280ABCD2F42"), await seal(vault, 2, "C0970153"), await seal(vault, 3, "AB")]);

    const summary = await backfillReferenceDisplay({ store, vault, apply: true });

    expect(summary).toMatchObject({ mode: "apply", scanned: 3, masked: 3 });
    expect(displays.get(id(1))).toBe(`${B}2F42`);
    expect(displays.get(id(2))).toBe(`${B}0153`);
    expect(displays.get(id(3))).toBe(`${B}B`);
  });

  it("is idempotent: a second run finds nothing to do and changes nothing", async () => {
    const vault = useKeys();
    const { store, displays } = fakeStore([await seal(vault, 1, "FT26280ABCD2F42")]);
    await backfillReferenceDisplay({ store, vault, apply: true });
    const before = new Map(displays);

    const second = await backfillReferenceDisplay({ store, vault, apply: true });

    expect(second).toMatchObject({ scanned: 0, masked: 0 });
    expect(displays).toEqual(before);
  });

  it("counts a row another run filled first as alreadySet, not as updated", async () => {
    const vault = useKeys();
    const row = await seal(vault, 1, "FT26280ABCD2F42");
    const store: BackfillStore = {
      listPending: async (after) => (after === null ? [row] : []),
      setDisplay: async () => false
    };
    const summary = await backfillReferenceDisplay({ store, vault, apply: true });
    expect(summary).toMatchObject({ scanned: 1, masked: 0, alreadySet: 1 });
  });

  it("is batch-limited: reads at most batchSize at a time and stops at maxRows, saying more may remain", async () => {
    const vault = useKeys();
    const rows = await Promise.all(Array.from({ length: 7 }, (_, index) => seal(vault, index + 1, `REF-${index}-ABCDEFGH`)));
    const { store, displays, calls } = fakeStore(rows);

    const summary = await backfillReferenceDisplay({ store, vault, apply: true, batchSize: 3, maxRows: 5 });

    expect(summary).toMatchObject({ scanned: 5, masked: 5, truncated: true });
    expect(displays.size).toBe(5);
    expect(Math.max(...calls.list.map(([, limit]) => limit))).toBeLessThanOrEqual(3);

    const rest = await backfillReferenceDisplay({ store, vault, apply: true, batchSize: 3, maxRows: 5 });
    expect(rest).toMatchObject({ scanned: 2, masked: 2, truncated: false });
    expect(displays.size).toBe(7);
  });

  it("does not loop on rows that stay null (nothing safe to show): keyset paging moves past them", async () => {
    const vault = useKeys();
    const { store, displays } = fakeStore([
      await seal(vault, 1, "X"),
      await seal(vault, 2, "ማጣቀሻ123456"),
      await seal(vault, 3, "FT26280ABCD2F42")
    ]);

    const summary = await backfillReferenceDisplay({ store, vault, apply: true, batchSize: 1 });

    expect(summary).toMatchObject({ scanned: 3, masked: 1, unmaskable: 2, truncated: false });
    expect([...displays.keys()]).toEqual([id(3)]);
  });

  it("skips a row sealed under another key version, and reports a row it cannot open by id and code only", async () => {
    const vault = useKeys();
    const good = await seal(vault, 1, "FT26280ABCD2F42");
    const otherVersion = await seal(vault, 2, "FT26280ABCD9999", "v0");
    const tampered: BackfillRow = { ...(await seal(vault, 3, "FT26280ABCDSECRET")), ciphertext: Buffer.alloc(40, 1).toString("base64") };
    const { store, displays } = fakeStore([good, otherVersion, tampered]);

    const summary = await backfillReferenceDisplay({ store, vault, apply: true, keyVersion: "v1" });

    expect(summary).toMatchObject({ scanned: 3, masked: 1, otherKeyVersion: 1 });
    expect(summary.failed).toEqual([{ verificationId: id(3), code: "INTEGRITY_FAILURE" }]);
    expect(displays.size).toBe(1);
  });

  it("never puts plaintext in the summary or the log, even when opening fails", async () => {
    const vault = useKeys();
    const reference = "FT26280ABCDPLAINTEXT";
    const lines: string[] = [];
    const { store } = fakeStore([await seal(vault, 1, reference), await seal(vault, 2, "FT99999ZZZZ")]);

    const summary = await backfillReferenceDisplay({ store, vault, apply: true, log: (line) => lines.push(line) });
    const failing = await backfillReferenceDisplay({
      store: { listPending: async (after) => (after === null ? [{ ...(await seal(vault, 9, reference)), hmac: "0".repeat(64) }] : []), setDisplay: async () => true },
      vault,
      apply: true,
      log: (line) => lines.push(line)
    });

    const everything = JSON.stringify([summary, failing, lines]);
    expect(everything).not.toContain(reference);
    expect(everything).not.toContain("PLAINTEXT");
    expect(everything).not.toContain("ZZZZ");
    expect(failing.failed).toHaveLength(1);
  });

  it("only ever writes the masked shape", async () => {
    const vault = useKeys();
    const written: string[] = [];
    const rows = await Promise.all(
      ["FT26280ABCD2F42", "C0970153", "AB", "ABC", "x".repeat(64), "!@#$%^&*()"].map((ref, index) => seal(vault, index + 1, ref))
    );
    const store: BackfillStore = {
      listPending: async (after) => rows.filter((row) => after === null || row.verificationId > after),
      setDisplay: async (_id, display) => {
        written.push(display);
        return true;
      }
    };
    await backfillReferenceDisplay({ store, vault, apply: true });
    expect(written).toHaveLength(6);
    for (const display of written) {
      expect(display).toMatch(/^•{4}[!-~]{1,4}$/);
    }
  });

  it("rejects limits outside the documented range instead of clamping silently", async () => {
    const vault = useKeys();
    const { store } = fakeStore([]);
    await expect(backfillReferenceDisplay({ store, vault, batchSize: 0 })).rejects.toBeInstanceOf(BankVerificationError);
    await expect(backfillReferenceDisplay({ store, vault, batchSize: 501 })).rejects.toBeInstanceOf(BankVerificationError);
    await expect(backfillReferenceDisplay({ store, vault, maxRows: 0 })).rejects.toBeInstanceOf(BankVerificationError);
  });
});
