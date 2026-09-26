import { describe, expect, it } from "vitest";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { rejectionsFor, toBankVerificationIntent, warningsFor } from "@/lib/voice/intent";
import { bankVerificationRequestSchema } from "@/lib/banking/schemas";

/**
 * The hand-off to AGENT-1's verifier.
 *
 * Two properties matter more than the happy path:
 *
 * 1. The body A2 produces must satisfy **A1's own** `zod` schema. This file
 *    imports that schema and parses with it, so the two lanes cannot drift.
 * 2. A draft that is not sound must be *refused*, with a reason. A treasurer
 *    mid-meeting is better served by "add the Telebirr reference" than by a
 *    confident-looking request the bank will reject in four minutes.
 */

const GOOD = parseContributionUtterance(
  "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd"
);
const NO_AMOUNT = parseContributionUtterance(
  "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd"
);
const GENERIC_BANK = parseContributionUtterance(
  "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1265\u1295\u12ad \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd"
);
const CASH = parseContributionUtterance(
  "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1325\u122c \u12a0\u1235\u1308\u1265\u127b\u1208\u1201"
);

const BINDING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OCCURRED_AT = "2026-09-26T09:30:00.000Z";

function goodInput(overrides: Partial<Parameters<typeof toBankVerificationIntent>[0]> = {}) {
  return {
    draft: GOOD,
    bankAccountBindingId: BINDING_ID,
    occurredAt: OCCURRED_AT,
    idempotencyKey: "voice-9BF42-1",
    ...overrides
  };
}

describe("a sound extraction produces a body A1's schema accepts", () => {
  it("builds the intent and it passes bankVerificationRequestSchema", () => {
    const outcome = toBankVerificationIntent(goodInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected a buildable intent");
    }

    expect(bankVerificationRequestSchema.safeParse(outcome.body).success).toBe(true);
    expect(outcome.body).toEqual({
      provider: "telebirr",
      bankAccountBindingId: BINDING_ID,
      providerReference: "9BF42",
      amount: "5000.00",
      currency: "ETB",
      direction: "inbound",
      occurredAt: OCCURRED_AT,
      idempotencyKey: "voice-9BF42-1"
    });
  });

  it("never marks the draft as verified, whatever the outcome", () => {
    const outcome = toBankVerificationIntent(goodInput());
    expect(GOOD.verified).toBe(false);
    expect(GOOD.status).toBe("PROVISIONAL");
    expect(JSON.stringify(outcome)).not.toContain('"verified":true');
  });

  it("honours an explicit direction", () => {
    const outcome = toBankVerificationIntent(goodInput({ direction: "outbound" }));
    expect(outcome.ok && outcome.body.direction).toBe("outbound");
  });
});

describe("an unsound extraction is refused with a reason", () => {
  it("refuses a draft with no amount", () => {
    const outcome = toBankVerificationIntent(goodInput({ draft: NO_AMOUNT }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("NO_AMOUNT");
  });

  it("refuses a bank named without a provider", () => {
    const outcome = toBankVerificationIntent(goodInput({ draft: GENERIC_BANK }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejections.some((rejection) => rejection.field === "channel")).toBe(true);
    }
  });

  it("refuses a cash contribution — no bank can settle it", () => {
    const outcome = toBankVerificationIntent(goodInput({ draft: CASH }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejections.map((rejection) => rejection.code)).toContain("CASH_CHANNEL");
    }
  });

  it("refuses to invent an occurredAt", () => {
    const outcome = toBankVerificationIntent(goodInput({ occurredAt: "" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejections.map((rejection) => rejection.code)).toContain("OCCURRED_AT_REQUIRED");
    }
  });

  it("REJECTS a malformed bank account binding rather than forwarding it", () => {
    const outcome = toBankVerificationIntent(goodInput({ bankAccountBindingId: "not-a-uuid" }));
    expect(outcome.ok).toBe(false);
  });

  it("REJECTS a malformed idempotency key", () => {
    for (const key of ["", "has space", "-leading-dash", "x".repeat(200)]) {
      expect(toBankVerificationIntent(goodInput({ idempotencyKey: key })).ok).toBe(false);
    }
  });

  it("REJECTS an occurredAt without a timezone offset", () => {
    // A naive local timestamp is ambiguous across the Ethiopian calendar's own
    // midnight, and A1 uses it in a request fingerprint.
    const outcome = toBankVerificationIntent(goodInput({ occurredAt: "2026-09-26T09:30:00" }));
    expect(outcome.ok).toBe(false);
  });
});

describe("a missing reference blocks the bank hand-off", () => {
  const noRef = parseContributionUtterance(
    "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201"
  );

  it("is a warning on the draft, so the treasurer can still see and fix it", () => {
    expect(noRef.issues).toContain("NO_TX_REF");
    expect(noRef.blocking).toBe(false);
    expect(warningsFor(noRef)).toContain("NO_TX_REF");
  });

  it("but is a rejection for the intent — A1's provider lookup is keyed on the reference", () => {
    // bankVerificationRequestSchema requires providerReference min(1); an
    // empty string would 400 at the boundary, so A2 refuses earlier and says why.
    const outcome = toBankVerificationIntent(goodInput({ draft: noRef }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejections.map((rejection) => rejection.code)).toContain("NO_TX_REF");
    }
  });
});

describe("rejectionsFor is a pure function of the draft", () => {
  it("returns nothing for a clean extraction", () => {
    expect(rejectionsFor(GOOD, OCCURRED_AT)).toEqual([]);
  });

  it("separates a missing timestamp from extraction problems", () => {
    const rejections = rejectionsFor(GOOD, null);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe("OCCURRED_AT_REQUIRED");
  });

  it("does not list blocking codes as warnings", () => {
    for (const code of NO_AMOUNT.issues) {
      expect(warningsFor(NO_AMOUNT)).not.toContain(code);
    }
  });
});
