import { describe, expect, it } from "vitest";
import {
  InMemoryLedgerRepository,
  verifyLedgerChain,
  type LedgerEntryRequest
} from "@/lib/ledger";

const actorId = "11111111-1111-4111-8111-111111111111";
const memberId = "abababab-abab-4bab-8bab-abababababab";
const groupId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const cashAccount = "33333333-3333-4333-8333-333333333333";
const incomeAccount = "44444444-4444-4444-8444-444444444444";

function repository(): InMemoryLedgerRepository {
  return new InMemoryLedgerRepository({
    groups: [
      {
        id: groupId,
        tenantId,
        members: [
          { userId: actorId, role: "treasurer" },
          { userId: memberId, role: "member" }
        ]
      }
    ],
    accounts: [
      { id: cashAccount, groupId, code: "CASH", name: "Cash", type: "asset" },
      { id: incomeAccount, groupId, code: "INCOME", name: "Income", type: "income" }
    ],
    clock: () => new Date("2026-09-25T10:30:00.000Z")
  });
}

function contribution(idempotencyKey: string, amount = "25.00"): LedgerEntryRequest {
  return {
    groupId,
    idempotencyKey,
    occurredAt: "2026-09-25T10:30:00.000Z",
    entryType: "contribution",
    postings: [
      { accountId: cashAccount, direction: "debit", amount },
      { accountId: incomeAccount, direction: "credit", amount }
    ]
  };
}

describe("append-only ledger repository", () => {
  it("serializes concurrent appends into one gapless hash chain", async () => {
    const ledger = repository();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ledger.append(contribution(`concurrent-${index + 1}`), { actorId })
      )
    );

    expect(results.map((result) => result.entry.sequence)).toEqual(["1", "2", "3", "4", "5"]);
    expect(new Set(results.map((result) => result.entry.nonce)).size).toBe(5);
    expect(verifyLedgerChain(results.map((result) => result.entry))).toEqual({
      valid: true,
      entriesChecked: 5
    });
  });

  it("returns the original entry for an idempotent replay", async () => {
    const ledger = repository();
    const first = await ledger.append(contribution("same-request"), { actorId });
    const replay = await ledger.append(contribution("same-request"), { actorId });

    expect(replay.replayed).toBe(true);
    expect(replay.entry).toEqual(first.entry);
    expect(ledger.getEntries(groupId, { actorId })).toHaveLength(1);
  });

  it("rejects a conflicting payload for the same idempotency key", async () => {
    const ledger = repository();
    await ledger.append(contribution("conflict"), { actorId });

    await expect(ledger.append(contribution("conflict", "30.00"), { actorId })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT"
    });
  });

  it("requires a correction to exactly reverse the original once", async () => {
    const ledger = repository();
    const original = await ledger.append(contribution("original"), { actorId });
    const correction: LedgerEntryRequest = {
      groupId,
      idempotencyKey: "correction-original",
      occurredAt: "2026-09-25T11:30:00.000Z",
      entryType: "correction",
      correctsEntryId: original.entry.id,
      rationale: "Correct a duplicated contribution posting",
      postings: [
        { accountId: cashAccount, direction: "credit", amount: "25.00" },
        { accountId: incomeAccount, direction: "debit", amount: "25.00" }
      ]
    };
    await expect(
      ledger.append(
        {
          ...correction,
          idempotencyKey: "incorrect-correction",
          postings: [
            { accountId: cashAccount, direction: "credit", amount: "24.99" },
            { accountId: incomeAccount, direction: "debit", amount: "24.99" }
          ]
        },
        { actorId }
      )
    ).rejects.toMatchObject({ code: "INVALID_CORRECTION" });

    const corrected = await ledger.append(correction, { actorId });

    expect(corrected.entry.correctsEntryId).toBe(original.entry.id);
    expect(verifyLedgerChain(ledger.getEntries(groupId, { actorId }).slice())).toMatchObject({
      valid: true,
      entriesChecked: 2
    });
    await expect(
      ledger.append({ ...correction, idempotencyKey: "second-correction" }, { actorId })
    ).rejects.toMatchObject({ code: "INVALID_CORRECTION" });
  });

  it("derives tenant access from membership rather than a request field", async () => {
    const ledger = repository();
    await expect(ledger.append(contribution("member-write"), { actorId: memberId })).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
  });
});
