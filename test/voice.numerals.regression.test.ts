import { describe, expect, it } from "vitest";

import { parseContributionUtterance } from "@/lib/voice/parser";
import { parseNumericToken } from "@/lib/voice/numerals";
import { toBankVerificationIntent } from "@/lib/voice/intent";
import { bankVerificationRequestSchema } from "@/lib/banking/schemas";

/**
 * Regression guards for a numeral composer that invented amounts.
 *
 * Two separate defects, both found by reading the composed value rather than
 * trusting that a number was produced at all.
 *
 * 1. `composeNumeralWords` decided the prefix form by multiplying the leading
 *    unit by the *following tens word's own value*. That is right only when
 *    that word is አስራ (ten). Amharic `አምስት አስራ` = 5 x 10 = 50 happened to
 *    survive, so the one committed test covering it passed and every other pair
 *    went unchecked. Oromo then broke loudly: `shan digdama` became 100 when
 *    the phrase means 50, and `afur digdama` became 80 — colliding with the
 *    compound `sadde digdama`, two different sentences for one number.
 * 2. The prefix form was not restricted to words that can actually mean "ten",
 *    so `አምስት ሃምሳ` (fifty-five) was folded to 50 and the spoken 50 vanished.
 *
 * A wrong amount is worse than none: a treasurer reads the figure back and
 * believes it. Every case here therefore asserts an exact value or a refusal.
 *
 * Ge'ez is written as \uXXXX escapes, matching the convention in
 * src/lib/voice/numerals.ts, so an editor that does not round-trip the script
 * cannot silently corrupt a test vector.
 */
const UNITS: ReadonlyArray<readonly [number, string]> = [
  [1, "\u12a0\u1295\u12f5"], // አንድ
  [2, "\u1201\u1208\u1275"], // ሁለት
  [3, "\u1226\u1235\u1275"], // ሦስት
  [4, "\u12a0\u122b\u1275"], // አራት
  [5, "\u12a0\u121d\u1235\u1275"], // አምስት
  [6, "\u1235\u12f5\u1235\u1275"], // ስድስት
  [7, "\u1230\u1263\u1275"], // ሰባት
  [8, "\u1235\u121d\u1295\u1275"], // ስምንት
  [9, "\u12d8\u1320\u129d"] // ዘጠኝ
];

const TENS: ReadonlyArray<readonly [number, string]> = [
  [10, "\u12a0\u1235\u122b"], // አስራ
  [20, "\u1203\u12eb"], // ሃያ
  [30, "\u1230\u120b\u1233"], // ሰላሳ
  [40, "\u12a0\u122d\u1263"], // አርባ
  [50, "\u1203\u121d\u1233"], // ሃምሳ
  [60, "\u1235\u12f5\u1233"], // ስድሳ
  [70, "\u1230\u1263"], // ሰባ
  [80, "\u1230\u121b\u1295\u12eb"], // ሰማንያ
  [90, "\u1230\u12f5\u1233"] // ሰድሳ
];

/** The words that may stand in for "ten" in the prefix form. */
const TENS_NOUNS: ReadonlySet<number> = new Set([10]);

const CURRENCY = "\u1265\u122f"; // ብር
const CHANNEL = "\u1274\u1208\u1265\u122d"; // ቴሌብር
const PAID = "\u12a0\u1235\u12ad\u1265\u1263\u12b5\u1208\u12f1"; // አስገብቻለሁ

const BINDING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OCCURRED_AT = "2026-09-26T09:30:00.000Z";

function speak(...words: readonly string[]): string {
  return words.join(" ");
}

function amountOf(...words: readonly string[]): number | null {
  return parseContributionUtterance(speak(...words, CURRENCY)).amount;
}

function unit(value: number): string {
  const found = UNITS.find(([candidate]) => candidate === value);
  if (found === undefined) {
    throw new Error(`no unit word for ${value}`);
  }
  return found[1];
}

function tens(value: number): string {
  const found = TENS.find(([candidate]) => candidate === value);
  if (found === undefined) {
    throw new Error(`no tens word for ${value}`);
  }
  return found[1];
}

describe("the prefix form means N tens, and only with a word that can mean ten", () => {
  it.each([2, 4, 5, 6, 7, 8, 9])("አምስት አስራ style: %i x 10 is a round ten", (count) => {
    // አስራ is the only Amharic tens noun, so every round ten goes through it.
    expect(amountOf(unit(count), tens(10))).toBe(count * 10);
  });

  it("composes the committed Oromo prefix case as fifty, not one hundred", () => {
    // shan digdama = 50. `digdama` is the Oromo tens noun here, so the unit is
    // scaled by ten. Multiplying by the word's own value gave 100.
    expect(amountOf("shaan", "digdama")).toBe(50);
    expect(amountOf("afur", "digdama")).toBe(40);
    expect(amountOf("shaan", "daa")).toBe(50);
  });

  it("keeps the Oromo compound tens distinct from the generic prefix form", () => {
    // sadde digdama is the compound for 80. If the generic rule also produced
    // 80 for afur digdama, two different sentences would mean one number.
    expect(amountOf("sadde", "digdama")).toBe(80);
    expect(amountOf("saga", "tokkoma")).toBe(90);
    expect(amountOf("sadde", "afur")).toBe(12);
  });

  it("composes every Amharic unit-plus-tens pair without inventing or dropping", () => {
    for (const [unitValue, unitWord] of UNITS) {
      for (const [tensValue, tensWord] of TENS) {
        // A tens noun scales the unit; any other tens word is added, because
        // አምስት ሃምሳ is fifty-five and folding it would drop the 50.
        const expected = TENS_NOUNS.has(tensValue) ? unitValue * 10 : unitValue + tensValue;
        expect(amountOf(unitWord, tensWord), `${unitWord} ${tensWord}`).toBe(expected);
      }
    }
  });

  it("composes every Amharic tens-plus-unit suffix pair as a sum", () => {
    for (const [tensValue, tensWord] of TENS) {
      for (const [unitValue, unitWord] of UNITS) {
        expect(amountOf(tensWord, unitWord), `${tensWord} ${unitWord}`).toBe(
          tensValue + unitValue
        );
      }
    }
  });

  it("composes the Oromo suffix and prefix forms the same way", () => {
    expect(amountOf("digdama", "tokkee")).toBe(27);
    expect(amountOf("digdama", "kanaa")).toBe(21);
    expect(amountOf("kana", "digdama", "kanaa")).toBe(11);
  });
});

describe("over-limit and ambiguous digit runs are refused, not truncated", () => {
  it("refuses a digit run that only parses once its leading group is dropped", () => {
    // The group absorber discarded the head and returned the tail, so
    // "1 234 567 890" was read as 234,567,890 birr.
    const parsed = parseContributionUtterance("1 234 567 890 birr");

    expect(parsed.amount).toBeNull();
    expect(parsed.issues).toContain("NO_AMOUNT");
  });

  it("does not adopt a ten-digit phone number as an amount", () => {
    // 0912345678 is a phone number. Folded to digits it looks like a figure,
    // and it was adopted as 912,345,678 birr with no blocking issue.
    const parsed = parseContributionUtterance("0912345678");

    expect(parsed.amount).toBeNull();
  });

  it("still parses a legitimate grouped amount", () => {
    expect(parseContributionUtterance("1 250 birr").amountWire).toBe("1250.00");
  });

  it("still parses a genuine sub-birr amount", () => {
    // The leading-zero rule exists to keep `0912345678` out; it must not cost
    // us the half-birr a treasurer genuinely reads off a receipt.
    expect(parseNumericToken("0.50")).toBe(50n);
  });
});

describe("a parsed amount survives the bank schema unchanged", () => {
  const goodUtterance =
    "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5,000 \u1265\u122f " +
    "\u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd";

  it("submits the figure the parser produced, validated against the real schema", () => {
    const draft = parseContributionUtterance(goodUtterance);
    const outcome = toBankVerificationIntent({
      draft,
      bankAccountBindingId: BINDING_ID,
      occurredAt: OCCURRED_AT,
      idempotencyKey: "voice-regression-1"
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected a buildable intent");
    }
    expect(bankVerificationRequestSchema.safeParse(outcome.body).success).toBe(true);
    expect(outcome.body.amount).toBe("5000.00");
  });

  it("is not submittable while the amount is unusable", () => {
    const draft = parseContributionUtterance("1 234 567 890 birr");
    const outcome = toBankVerificationIntent({
      draft,
      bankAccountBindingId: BINDING_ID,
      occurredAt: OCCURRED_AT,
      idempotencyKey: "voice-regression-2"
    });

    expect(outcome.ok).toBe(false);
  });

  it("never carries a voice extraction across as verified", () => {
    const draft = parseContributionUtterance(goodUtterance);
    const outcome = toBankVerificationIntent({
      draft,
      bankAccountBindingId: BINDING_ID,
      occurredAt: OCCURRED_AT,
      idempotencyKey: "voice-regression-3"
    });

    expect(draft.status).toBe("PROVISIONAL");
    expect(draft.verified).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('"verified":true');
  });
});
