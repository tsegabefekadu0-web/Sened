import { describe, expect, it } from "vitest";
import { parseContributionUtterance } from "@/lib/voice/parser";
import { isSubmittableToBank } from "@/lib/voice/types";

/**
 * M3 entity-extraction benchmarks (ROADMAP §6.2).
 *
 * Table-driven across Amharic and Afaan Oromoo, digits and spoken numerals,
 * with the negative cases that matter for a treasury: no amount, two amounts,
 * a foreign currency, an unnamed provider, a provider conflict, a reference
 * that must never be read as money.
 *
 * Ge'ez text is written as `\uXXXX` escapes throughout so a copy-paste through
 * a non-Ethiopic terminal cannot silently change what is being asserted. The
 * rendered forms are asserted in `voice.numerals.test.ts` and
 * `voice.months.test.ts`.
 */

const TEXT = {
  // ── Amharic, digits ──────────────────────────────────────────────────────
  roadmap:
    "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  amharicNoSeparator:
    "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  amharicSpaceGrouped:
    "\u12a5\u1241\u1265 5 000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  // Ethiopic digits ፬ ፬ ፪ ፭ ፩ ፪ → 4,725,012
  amharicEthiopicDigits:
    "\u12a5\u1241\u1265 \u136c\u136f\u136a\u136d\u1360\u1369\u136a \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201",
  // ── Amharic, spoken numerals ─────────────────────────────────────────────
  amharicFiveThousandWords:
    "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 \u12a0\u121d\u1235\u1275 \u123a\u1205 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201",
  amharicBareThousand: "\u12a5\u1241\u1265 \u123a\u1205 \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicTwoThousand: "\u12a5\u1241\u1265 \u1201\u1208\u1275 \u123a\u1205 \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicTenThousand: "\u12a5\u1241\u1265 \u12a3\u1225\u122d \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicFifty: "\u12a5\u1241\u1265 \u12a0\u121d\u1235\u1275 \u12a0\u1235\u122b \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicTwentyOne: "\u12a5\u1241\u1265 \u1203\u12eb \u12a0\u1295\u12f5 \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicOneFifty: "\u12a5\u1241\u1265 \u12a0\u1295\u12f5 \u1218\u1276 \u1203\u121d\u1233 \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicFourHundred: "\u12a5\u1241\u1265 \u12a0\u122b\u1275 \u1218\u1276 \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicFiveThousandA: "\u12a5\u1241\u1265 \u12a0\u121d\u1235\u1275 \u12a3\u1225\u122d \u1265\u122d \u1274\u120c\u1265\u122d",
  amharicCbe: "\u12a5\u1241\u1265 1,500 \u1265\u122d \u1232\u1262\u12a2 \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u12a0\u12ed\u12f6 4KP11Z",
  amharicAwash: "\u12a5\u1241\u1265 2,500 \u1265\u122d \u12a0\u12cb\u123d \u1265\u1295\u12ad \u12a0\u1235\u1308\u1265\u127b\u1208\u1201",
  amharicCash: "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1325\u122c \u12a0\u1235\u1308\u1265\u127b\u1208\u1201",
  /** No currency word anywhere — the parser must assume ETB and say so. */
  amharicNoCurrencyWord:
    "\u12a5\u1241\u1265 5,000 \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  // ── Afaan Oromoo ─────────────────────────────────────────────────────────
  oromoFiveThousand:
    "senaa equb shan dugum birr tellebirr dabbadee kutaa 9BF42 dha",
  oromoTwentyOne: "equb digdama kanaa birr tellebirr dabbadee",
  oromoTwentySeven: "equb digdama tokkee birr tellebirr dabbadee",
  oromoFifty: "equb shan digdama birr tellebirr dabbadee",
  oromoEighty: "equb sadde tokkoma birr tellebirr dabbadee",
  oromoNinety: "equb saga tokkoma birr tellebirr dabbadee",
  oromoBareThousand: "equb dugum birr tellebirr dabbadee",
  oromoHundredFifty: "equb kana kuu shantama birr tellebirr dabbadee",
  oromoGinbot: "ginbot equb tokkoma dugum birr tellebirr dabbadee",
  // ── Negative ─────────────────────────────────────────────────────────────
  noAmount: "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  twoAmounts:
    "\u12a5\u1241\u1265 5,000 \u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd \u1295\u12f6\u1275\u1275 500 \u1265\u122d \u12a0\u1235\u1308\u127b\u121d",  foreignCurrency:
    "\u12a5\u1241\u1265 500 \u12f6\u120b\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1274\u120c\u1265\u122d \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  genericBank:
    "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1262\u1295\u12ad \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  twoProviders:
    "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1295\u12f6\u1275\u1275 \u1232\u1262\u12a2 \u1261\u1325\u1229 9BF42 \u1290\u12cd",
  noChannel: "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1308\u1295\u12d8\u1265",
  numericRefOnly: "\u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u1261\u1325\u122d 12345",
  unparseableWord: "ምንም አልታወቅም",
  empty: "   ",
  malformedNumber: "\u12a5\u1241\u1265 12,34 \u1265\u122d \u1274\u120c\u1265\u122d"
} as const;

describe("M3.1 — the ROADMAP reference utterance", () => {
  it("extracts { month, amount, channel, tx_ref } from Amharic", () => {
    const result = parseContributionUtterance(TEXT.roadmap);

    expect(result.month).toBe("meskerem");
    expect(result.monthLabel).toBe("Meskerem");
    expect(result.amount).toBe(5000);
    expect(result.amountWire).toBe("5000.00");
    expect(result.provider).toBe("telebirr");
    expect(result.rail).toBe("bank");
    expect(result.txRef).toBe("9BF42");
    expect(result.txRefSource).toBe("labelled");
    expect(result.currency).toBe("ETB");
    expect(result.currencySource).toBe("explicit");
    expect(result.language).toBe("am");
    expect(result.issues).toEqual([]);
    expect(result.blocking).toBe(false);
    expect(isSubmittableToBank(result)).toBe(true);
  });

  it("accepts the same sentence with no thousands separator", () => {
    const result = parseContributionUtterance(TEXT.amharicNoSeparator);
    expect(result.amount).toBe(5000);
    expect(result.month).toBe("meskerem");
    expect(result.txRef).toBe("9BF42");
  });

  it("accepts `5 000` as the same amount as `5,000`", () => {
    expect(parseContributionUtterance(TEXT.amharicSpaceGrouped).amount).toBe(5000);
  });

  it("reads Ethiopic digits (4,725,012)", () => {
    const result = parseContributionUtterance(TEXT.amharicEthiopicDigits);
    expect(result.amount).toBe(4_725_012);
    expect(result.amountWire).toBe("4725012.00");
  });
});

describe("M3.1 — Amharic spoken numerals", () => {
  const cases: readonly { readonly text: string; readonly amount: number; readonly label: string }[] = [
    { label: "አምስት ሺህ = 5,000", text: TEXT.amharicFiveThousandWords, amount: 5000 },
    { label: "ሺህ alone = 1,000", text: TEXT.amharicBareThousand, amount: 1000 },
    { label: "ሁለት ሺህ = 2,000", text: TEXT.amharicTwoThousand, amount: 2000 },
    { label: "አሥር = 10,000", text: TEXT.amharicTenThousand, amount: 10_000 },
    { label: "አምስት አስራ = 50 (prefix form)", text: TEXT.amharicFifty, amount: 50 },
    { label: "ሃያ አንድ = 21 (suffix form)", text: TEXT.amharicTwentyOne, amount: 21 },
    { label: "አንድ መቶ ሃምሳ = 150", text: TEXT.amharicOneFifty, amount: 150 },
    { label: "አራት መቶ = 400", text: TEXT.amharicFourHundred, amount: 400 },
    { label: "አምስት አሥር = 50,000", text: TEXT.amharicFiveThousandA, amount: 50_000 }
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const result = parseContributionUtterance(testCase.text);
      expect(result.issues).not.toContain("NO_AMOUNT");
      expect(result.amount).toBe(testCase.amount);
      expect(result.amountWire).toBe(`${testCase.amount}.00`);
    });
  }
});

describe("M3.1 — Afaan Oromoo numerals and phrasing", () => {
  it("extracts the full set from an Oromo utterance", () => {
    const result = parseContributionUtterance(TEXT.oromoFiveThousand);
    expect(result.month).toBe("sene");
    expect(result.amount).toBe(5000);
    expect(result.provider).toBe("telebirr");
    expect(result.txRef).toBe("9BF42");
    expect(result.language).toBe("om");
    expect(result.issues).toEqual([]);
  });

  const cases: readonly { readonly label: string; readonly text: string; readonly amount: number }[] = [
    { label: "digdama kanaa = 21", text: TEXT.oromoTwentyOne, amount: 21 },
    { label: "digdama tokkee = 27 (tokkee is 7, not a 1-suffix)", text: TEXT.oromoTwentySeven, amount: 27 },
    { label: "shan digdama = 50 (prefix form)", text: TEXT.oromoFifty, amount: 50 },
    { label: "sadde tokkoma = 80 (compound, not 78)", text: TEXT.oromoEighty, amount: 80 },
    { label: "saga tokkoma = 90 (compound, not 97)", text: TEXT.oromoNinety, amount: 90 },
    { label: "dugum = 1,000", text: TEXT.oromoBareThousand, amount: 1000 },
    { label: "kana kuu shantama = 150", text: TEXT.oromoHundredFifty, amount: 150 },
    { label: "tokkoma dugum = 70,000", text: TEXT.oromoGinbot, amount: 70_000 }
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const result = parseContributionUtterance(testCase.text);
      expect(result.amount).toBe(testCase.amount);
    });
  }
});

describe("M3.1 — provider detection", () => {
  it("detects CBE Birr and an Ayid-labelled reference", () => {
    const result = parseContributionUtterance(TEXT.amharicCbe);
    expect(result.provider).toBe("cbe");
    expect(result.amount).toBe(1500);
    expect(result.txRef).toBe("4KP11Z");
    expect(result.txRefSource).toBe("labelled");
    expect(isSubmittableToBank(result)).toBe(true);
  });

  it("detects Awash Bank", () => {
    const result = parseContributionUtterance(TEXT.amharicAwash);
    expect(result.provider).toBe("awash");
    expect(result.amount).toBe(2500);
  });
});

describe("M3.1 — negative cases fail closed", () => {
  it("REJECTS (blocking) an utterance with no amount", () => {
    const result = parseContributionUtterance(TEXT.noAmount);
    expect(result.amount).toBeNull();
    expect(result.amountWire).toBeNull();
    expect(result.issues).toContain("NO_AMOUNT");
    expect(result.blocking).toBe(true);
    expect(isSubmittableToBank(result)).toBe(false);
  });

  it("REJECTS (blocking) two amounts rather than guessing which one", () => {
    const result = parseContributionUtterance(TEXT.twoAmounts);
    expect(result.amount).toBeNull();
    expect(result.issues).toContain("AMBIGUOUS_AMOUNT");
    expect(result.blocking).toBe(true);
  });

  it("REJECTS (blocking) a foreign currency instead of reading it as birr", () => {
    const result = parseContributionUtterance(TEXT.foreignCurrency);
    expect(result.amount).toBeNull();
    expect(result.issues).toContain("CURRENCY_MISMATCH");
    expect(result.issues).toContain("NO_AMOUNT");
    expect(result.blocking).toBe(true);
  });

  it("REJECTS (blocking) a bank named without a provider", () => {
    const result = parseContributionUtterance(TEXT.genericBank);
    expect(result.provider).toBeNull();
    expect(result.rail).toBe("bank");
    expect(result.issues).toContain("AMBIGUOUS_CHANNEL");
    expect(result.blocking).toBe(true);
  });

  it("REJECTS (blocking) two providers in one utterance", () => {
    const result = parseContributionUtterance(TEXT.twoProviders);
    expect(result.provider).toBeNull();
    expect(result.issues).toContain("AMBIGUOUS_CHANNEL");
    expect(result.blocking).toBe(true);
  });

  it("REJECTS (blocking) an utterance with no channel at all", () => {
    const result = parseContributionUtterance(TEXT.noChannel);
    expect(result.rail).toBe("none");
    expect(result.issues).toContain("NO_CHANNEL");
    expect(result.blocking).toBe(true);
  });

  it("flags a cash contribution as unverifiable by a bank", () => {
    const result = parseContributionUtterance(TEXT.amharicCash);
    expect(result.rail).toBe("cash");
    expect(result.provider).toBeNull();
    expect(result.amount).toBe(5000);
    expect(result.issues).toContain("CASH_CHANNEL");
    // Not blocking for the *draft* — a treasurer may legitimately log cash —
    // but it can never be submitted to a provider.
    expect(result.blocking).toBe(false);
    expect(isSubmittableToBank(result)).toBe(false);
  });

  it("flags an unlabelled reference as unreliable", () => {
    const result = parseContributionUtterance(TEXT.numericRefOnly);
    expect(result.txRef).toBeNull();
    expect(result.issues).toContain("NO_TX_REF");
    // The digits after `ቁጥር` are a receipt number, not a 12,345 birr payment.
    expect(result.amount).toBe(5000);
    expect(result.issues).not.toContain("AMBIGUOUS_AMOUNT");
  });

  it("returns UNPARSEABLE for empty and for non-numeric noise", () => {
    expect(parseContributionUtterance(TEXT.empty).issues).toContain("UNPARSEABLE");
    expect(parseContributionUtterance("").issues).toContain("UNPARSEABLE");
    const noise = parseContributionUtterance(TEXT.unparseableWord);
    expect(noise.amount).toBeNull();
    expect(noise.blocking).toBe(true);
  });

  it("refuses a malformed digit group instead of truncating it", () => {
    const result = parseContributionUtterance(TEXT.malformedNumber);
    expect(result.amount).toBeNull();
    expect(result.blocking).toBe(true);
  });

  it("never throws on hostile input", () => {
    for (const input of [" ".repeat(50), "𝕏𝕆𝕓".repeat(40), "0".repeat(400), "-5000"]) {
      const result = parseContributionUtterance(input);
      expect(result.status).toBe("PROVISIONAL");
      expect(result.verified).toBe(false);
    }
  });
});

describe("M3.1 — the zero-trust invariant", () => {
  const everyUtterance = [
    TEXT.roadmap,
    TEXT.oromoFiveThousand,
    TEXT.noAmount,
    TEXT.twoAmounts,
    TEXT.foreignCurrency,
    TEXT.amharicCash,
    TEXT.noChannel,
    ""
  ];

  it("marks every extraction PROVISIONAL and never verified", () => {
    for (const text of everyUtterance) {
      const result = parseContributionUtterance(text);
      expect(result.status).toBe("PROVISIONAL");
      expect(result.verified).toBe(false);
      expect(result.currency).toBe("ETB");
    }
  });

  it("assumes ETB and says so when the utterance never named a currency", () => {
    const result = parseContributionUtterance(TEXT.amharicNoCurrencyWord);
    expect(result.amount).toBe(5000);
    expect(result.provider).toBe("telebirr");
    expect(result.currency).toBe("ETB");
    expect(result.currencySource).toBe("assumed");
    expect(result.issues).toContain("INFERRED_CURRENCY");
  });

  it("reports an explicit currency when the treasurer said birr", () => {
    expect(parseContributionUtterance(TEXT.roadmap).currencySource).toBe("explicit");
  });
});
