import { describe, expect, it } from "vitest";
import {
  buildCorrectionRequest,
  CorrectionBuildError,
  newCorrectionIdempotencyKey,
  type CorrectionOriginal
} from "@/lib/ledger/correction";
import { validateCompensatingEntry } from "@/lib/ledger/rules";
import type { LedgerEntry } from "@/lib/ledger/types";
import { ledgerEntryRequestSchema } from "@/lib/validation";

const GROUP = "22222222-2222-4222-8222-222222222222";
const ORIGINAL_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "corr-test-key-1";
const NOW = new Date("2026-10-01T10:00:00.000Z");
const RATIONALE = "Wrong member was credited";

const original: CorrectionOriginal = {
  id: ORIGINAL_ID,
  groupId: GROUP,
  occurredAt: "2026-09-01T09:00:00.000Z",
  entryType: "contribution",
  postings: [
    { accountId: ACCOUNT_A, direction: "debit", amount: "12000.50" },
    { accountId: ACCOUNT_B, direction: "credit", amount: "12000.50" }
  ]
};

function build(overrides: Partial<Parameters<typeof buildCorrectionRequest>[0]> = {}) {
  return buildCorrectionRequest({ original, rationale: RATIONALE, idempotencyKey: KEY, now: NOW, ...overrides });
}

describe("buildCorrectionRequest", () => {
  it("builds the exact request body the route expects", () => {
    expect(build()).toEqual({
      groupId: GROUP,
      idempotencyKey: KEY,
      occurredAt: "2026-10-01T10:00:00.000Z",
      entryType: "correction",
      correctsEntryId: ORIGINAL_ID,
      rationale: RATIONALE,
      postings: [
        { accountId: ACCOUNT_A, direction: "credit", amount: "12000.50" },
        { accountId: ACCOUNT_B, direction: "debit", amount: "12000.50" }
      ]
    });
  });

  it("flips every posting and keeps accounts and canonical amount strings untouched", () => {
    const many: CorrectionOriginal = {
      ...original,
      postings: [
        { accountId: ACCOUNT_A, direction: "debit", amount: "0.10" },
        { accountId: ACCOUNT_A, direction: "debit", amount: "0.20" },
        { accountId: ACCOUNT_B, direction: "credit", amount: "0.30" }
      ]
    };
    expect(build({ original: many }).postings).toEqual([
      { accountId: ACCOUNT_A, direction: "credit", amount: "0.10" },
      { accountId: ACCOUNT_A, direction: "credit", amount: "0.20" },
      { accountId: ACCOUNT_B, direction: "debit", amount: "0.30" }
    ]);
  });

  it("is accepted by the server request schema and its exact-reversal rule", () => {
    const request = build();
    expect(ledgerEntryRequestSchema.safeParse(request).success).toBe(true);
    const asEntry = {
      ...original,
      tenantId: "t",
      sequence: "1",
      recordedAt: original.occurredAt,
      correctsEntryId: null,
      rationale: null,
      actorId: "a",
      nonce: "n",
      previousHash: "p",
      entryHash: "h",
      requestFingerprint: "f",
      idempotencyKey: "k",
      postings: original.postings.map((posting, ordinal) => ({ ...posting, id: `p${ordinal}`, ordinal }))
    } as LedgerEntry;
    expect(() => validateCompensatingEntry(request, asEntry)).not.toThrow();
  });

  it("trims the rationale", () => {
    expect(build({ rationale: `  ${RATIONALE}  ` }).rationale).toBe(RATIONALE);
  });

  it.each(["", "   ", "too short", "x".repeat(1001)])("REJECTS a rationale of %j", (rationale) => {
    expect(() => build({ rationale })).toThrow(expect.objectContaining({ code: "rationale" }));
  });

  it("REJECTS an original with zero postings", () => {
    expect(() => build({ original: { ...original, postings: [] } })).toThrow(CorrectionBuildError);
    expect(() => build({ original: { ...original, postings: [] } })).toThrow(
      expect.objectContaining({ code: "no-postings" })
    );
  });

  it("REJECTS an original that is itself a correction, so a correction never targets a correction", () => {
    expect(() => build({ original: { ...original, entryType: "correction" } })).toThrow(
      expect.objectContaining({ code: "is-correction" })
    );
  });

  it.each([
    ["a non-canonical amount", { accountId: ACCOUNT_A, direction: "debit" as const, amount: "12" }],
    ["a zero amount", { accountId: ACCOUNT_A, direction: "debit" as const, amount: "0.00" }],
    ["a missing account", { accountId: "", direction: "debit" as const, amount: "1.00" }]
  ])("REJECTS %s", (_label, posting) => {
    expect(() => build({ original: { ...original, postings: [posting, original.postings[1]] } })).toThrow(
      expect.objectContaining({ code: "bad-posting" })
    );
  });

  it("REJECTS an original with an unusable time or id", () => {
    expect(() => build({ original: { ...original, occurredAt: "nope" } })).toThrow(
      expect.objectContaining({ code: "bad-original" })
    );
    expect(() => build({ original: { ...original, id: "" } })).toThrow(expect.objectContaining({ code: "bad-original" }));
  });

  it("never predates the original when the browser clock is behind", () => {
    const future = { ...original, occurredAt: "2026-12-01T00:00:00.000Z" };
    expect(build({ original: future }).occurredAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("builds an identical body for the same inputs, so a retry is a true replay", () => {
    expect(build()).toEqual(build());
  });

  it("does not mutate the original", () => {
    const snapshot = JSON.stringify(original);
    build();
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("newCorrectionIdempotencyKey", () => {
  it("is unique and matches the server key pattern", () => {
    const a = newCorrectionIdempotencyKey();
    const b = newCorrectionIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });
});
