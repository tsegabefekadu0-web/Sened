import { describe, expect, it } from "vitest";
import {
  buildLedgerEntry,
  canonicalSerializeEntry,
  canonicalSerializeRequest,
  fingerprintLedgerRequest,
  verifyLedgerChain
} from "@/lib/ledger";

const actorId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const accountDebit = "33333333-3333-4333-8333-333333333333";
const accountCredit = "44444444-4444-4444-8444-444444444444";
const request = {
  groupId,
  idempotencyKey: "contribution-001",
  occurredAt: "2026-09-25T10:30:00.000Z",
  entryType: "contribution" as const,
  postings: [
    { accountId: accountDebit, direction: "debit" as const, amount: "25.00" },
    { accountId: accountCredit, direction: "credit" as const, amount: "25.00" }
  ]
};

function entry() {
  return buildLedgerEntry({
    request,
    actorId,
    tenantId,
    entryId: "55555555-5555-4555-8555-555555555555",
    nonce: "66666666-6666-4666-8666-666666666666",
    sequence: "1",
    previousHash: "0".repeat(64),
    recordedAt: "2026-09-25T10:30:01.000Z",
    postingIds: [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ]
  });
}

describe("canonical ledger hashing", () => {
  it("matches the versioned request fingerprint vector", () => {
    expect(canonicalSerializeRequest(request, actorId)).toBe(
      [
        "sened-ledger-request-v1",
        "7:actorId",
        "36:11111111-1111-4111-8111-111111111111",
        "7:groupId",
        "36:22222222-2222-4222-8222-222222222222",
        "14:idempotencyKey",
        "16:contribution-001",
        "10:occurredAt",
        "24:2026-09-25T10:30:00.000Z",
        "9:entryType",
        "12:contribution",
        "15:correctsEntryId",
        "0:",
        "9:rationale",
        "0:",
        "13:posting.count",
        "1:2",
        "19:posting.1.accountId",
        "36:33333333-3333-4333-8333-333333333333",
        "19:posting.1.direction",
        "5:debit",
        "16:posting.1.amount",
        "5:25.00",
        "19:posting.2.accountId",
        "36:44444444-4444-4444-8444-444444444444",
        "19:posting.2.direction",
        "6:credit",
        "16:posting.2.amount",
        "5:25.00"
      ].join("\n")
    );
    expect(fingerprintLedgerRequest(request, actorId)).toBe(
      "9843b97e67c40df236689074b4b087bc42defb1e9c5752dc62f520130c76ec6d"
    );
  });

  it("matches the versioned entry hash vector", () => {
    const built = entry();
    expect(canonicalSerializeEntry(built)).toContain("sened-ledger-entry-v1\n2:id\n36:");
    expect(built.entryHash).toBe("e5e5ed8e6b3262c6728bc3f4d4d74850928f51435224a0774e6a76a8338490d8");
    expect(verifyLedgerChain([built])).toEqual({ valid: true, entriesChecked: 1 });
  });

  it("detects amount tampering even when entry order is unchanged", () => {
    const built = entry();
    const tampered = {
      ...built,
      postings: built.postings.map((posting, index) =>
        index === 0 ? { ...posting, amount: "75.00" } : posting
      )
    };

    expect(verifyLedgerChain([tampered])).toMatchObject({
      valid: false,
      error: { code: "ENTRY_HASH_MISMATCH" }
    });
  });

  it("binds the server-recorded timestamp into the entry hash", () => {
    const tampered = { ...entry(), recordedAt: "2026-09-25T10:30:01.001Z" };

    expect(verifyLedgerChain([tampered])).toMatchObject({
      valid: false,
      error: { code: "ENTRY_HASH_MISMATCH" }
    });
  });
});
