import { describe, expect, it } from "vitest";
import { composeNumeralWords, isNumeralWord, parseNumericToken } from "@/lib/voice/numerals";
import { normalizeUtterance, tokenizeUtterance, tokenVariants, matchTokenVariant } from "@/lib/voice/normalize";
import { monthFormsFor, monthFromToken, monthLabel, monthNumber } from "@/lib/voice/months";
import { isEtbToken, isForeignCurrencyToken, isTxRefTriggerToken, providerFromToken } from "@/lib/voice/lexicon";
import { ETHIOPIAN_MONTH_IDS } from "@/lib/voice/types";

/**
 * Unit tests for the parser's primitives.
 *
 * The Ge'ez lexica are stored as `\uXXXX` escapes so a non-Ethiopic editor
 * cannot corrupt them. That safety is worthless unless the escapes still spell
 * the right word, so the first describe block asserts the *rendered* forms —
 * if someone "fixes" a codepoint, this fails loudly instead of shipping a
 * parser that silently stops recognising ቴሌብር.
 */

const RENDERED_LEXICON: readonly { readonly word: string; readonly expected: string; readonly source: string }[] = [
  { source: "UNITS", word: "\u12a0\u1295\u12f5", expected: "አንድ" },
  { source: "UNITS", word: "\u1201\u1208\u1275", expected: "ሁለት" },
  { source: "UNITS", word: "\u1226\u1235\u1275", expected: "ሦስት" },
  { source: "UNITS", word: "\u12a0\u122b\u1275", expected: "አራት" },
  { source: "UNITS", word: "\u12a0\u121d\u1235\u1275", expected: "አምስት" },
  { source: "UNITS", word: "\u1235\u12f5\u1235\u1275", expected: "ስድስት" },
  { source: "UNITS", word: "\u1230\u1263\u1275", expected: "ሰባት" },
  { source: "UNITS", word: "\u1235\u121d\u1295\u1275", expected: "ስምንት" },
  { source: "UNITS", word: "\u12d8\u1320\u129d", expected: "ዘጠኝ" },
  { source: "TENS", word: "\u12a0\u1235\u122b", expected: "አስራ" },
  { source: "TENS", word: "\u1203\u12eb", expected: "ሃያ" },
  { source: "TENS", word: "\u1230\u120b\u1233", expected: "ሰላሳ" },
  { source: "TENS", word: "\u12a0\u122d\u1263", expected: "አርባ" },
  { source: "TENS", word: "\u1203\u121d\u1233", expected: "ሃምሳ" },
  { source: "TENS", word: "\u1235\u12f5\u1233", expected: "ስድሳ" },
  { source: "TENS", word: "\u1230\u1263", expected: "ሰባ" },
  { source: "TENS", word: "\u1230\u121b\u1295\u12eb", expected: "ሰማንያ" },
  { source: "TENS", word: "\u1230\u12f5\u1233", expected: "ሰድሳ" },
  { source: "MULTIPLIERS", word: "\u1218\u1276", expected: "መቶ" },
  { source: "MULTIPLIERS", word: "\u12a0\u123d\u1275", expected: "አሽት" },
  { source: "MULTIPLIERS", word: "\u123a\u1205", expected: "ሺህ" },
  { source: "MULTIPLIERS", word: "\u12a3\u1225\u122d", expected: "ኣሥር" }
];

describe("the Ge'ez lexica still spell the words they claim to", () => {
  for (const entry of RENDERED_LEXICON) {
    it(`${entry.source} entry is ${entry.expected}`, () => {
      expect(entry.word).toBe(entry.expected);
      expect(isNumeralWord(entry.word)).toBe(true);
    });
  }

  it("provider, currency and reference triggers render correctly", () => {
    expect("\u1274\u120c\u1265\u122d").toBe("ቴሌብር");
    expect(providerFromToken("\u1274\u120c\u1265\u122d")).toBe("telebirr");
    expect(providerFromToken("\u1232\u1262\u12a2")).toBe("cbe");
    expect(providerFromToken("\u12a0\u12cb\u123d")).toBe("awash");
    expect(isEtbToken("\u1265\u122d")).toBe(true);
    expect(isForeignCurrencyToken("\u12f6\u120b\u122d")).toBe(true);
    expect(isTxRefTriggerToken("\u1261\u1325\u1229")).toBe(true);
  });
});

describe("composeNumeralWords", () => {
  it("composes the Amharic prefix form for round tens", () => {
    // አምስት አስራ
    expect(composeNumeralWords(["\u12a0\u121d\u1235\u1275", "\u12a0\u1235\u122b"])).toBe(50n);
  });

  it("composes the Amharic suffix form", () => {
    // ሃያ አንድ
    expect(composeNumeralWords(["\u1203\u12eb", "\u12a0\u1295\u12f5"])).toBe(21n);
  });

  it("treats a bare multiplier as the multiplier", () => {
    // ሺህ
    expect(composeNumeralWords(["\u123a\u1205"])).toBe(1000n);
    // መቶ
    expect(composeNumeralWords(["\u1218\u1276"])).toBe(100n);
  });

  it("scales a unit by a multiplier", () => {
    // አምስት ሺህ
    expect(composeNumeralWords(["\u12a0\u121d\u1235\u1275", "\u123a\u1205"])).toBe(5000n);
  });

  it("scales a tens by a multiplier (አስራ ሺህ = 10,000)", () => {
    expect(composeNumeralWords(["\u12a0\u1235\u122b", "\u123a\u1205"])).toBe(10_000n);
  });

  it("does NOT let a finished tens+unit pair be scaled by a later multiplier", () => {
    // tokkoma dugum must be 70,000, not 70,070.
    expect(composeNumeralWords(["tokkoma", "dugum"])).toBe(70_000n);
  });

  it("sums a completed hundreds group and a tens group", () => {
    // አንድ መቶ ሃምሳ
    expect(composeNumeralWords(["\u12a0\u1295\u12f5", "\u1218\u1276", "\u1203\u121d\u1233"])).toBe(150n);
  });

  it("refuses a unit after a multiplier rather than inventing 1,002", () => {
    // አሽት ሁለት is not a number anyone says.
    expect(composeNumeralWords(["\u12a0\u123d\u1275", "\u1201\u1208\u1275"])).toBeNull();
  });

  it("refuses two chained multipliers", () => {
    // ሺህ አሽት
    expect(composeNumeralWords(["\u123a\u1205", "\u12a0\u123d\u1275"])).toBeNull();
  });

  it("refuses a non-numeral word", () => {
    expect(composeNumeralWords(["\u12a5\u1241\u1265"])).toBeNull();
    expect(composeNumeralWords([])).toBeNull();
  });

  it("refuses an implausibly long numeral run", () => {
    expect(composeNumeralWords(["\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5", "\u12a0\u1295\u12f5"])).toBeNull();
  });

  it("resolves the Oromo compound tens that the generic rule would misread", () => {
    expect(composeNumeralWords(["sadde", "tokkoma"])).toBe(80n);
    expect(composeNumeralWords(["saga", "tokkoma"])).toBe(90n);
    expect(composeNumeralWords(["sadde", "digdama"])).toBe(80n);
  });

  it("reads Oromo units as themselves, not as a 1-suffix", () => {
    // digdama tokkee is 27: `tokkee` is the Oromo seven.
    expect(composeNumeralWords(["digdama", "tokkee"])).toBe(27n);
    // digdama kanaa is 21.
    expect(composeNumeralWords(["digdama", "kanaa"])).toBe(21n);
  });
});

describe("parseNumericToken", () => {
  it("accepts plain and comma-grouped digits", () => {
    expect(parseNumericToken("5000")).toBe(500_000n);
    expect(parseNumericToken("5,000")).toBe(500_000n);
    expect(parseNumericToken("5 000")).toBe(500_000n);
    expect(parseNumericToken("5,000.75")).toBe(500_075n);
  });

  it("REJECTS a dot-grouped `5.000` — it could be 5.000 birr or 5,000 birr", () => {
    // A treasury parser that reads `5.000` as 5,000 can overstate a
    // contribution a thousandfold; a treasurer can always retype a comma.
    expect(parseNumericToken("5.000")).toBeNull();
  });

  it("returns minor units, matching A1's wire scale", () => {
    // 1 birr = 100 minor units
    expect(parseNumericToken("1")).toBe(100n);
    expect(parseNumericToken("0.01")).toBe(1n);
  });

  it("rejects a token with any letter — that is a reference, not an amount", () => {
    expect(parseNumericToken("9BF42")).toBeNull();
    expect(parseNumericToken("5k")).toBeNull();
  });

  it("rejects a malformed digit group instead of truncating it", () => {
    expect(parseNumericToken("12,34")).toBeNull();
    expect(parseNumericToken("1,23,456")).toBeNull();
    expect(parseNumericToken("5,0000")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(parseNumericToken("5.000")).toBeNull();
  });

  it("rejects absurd length and empty input", () => {
    expect(parseNumericToken("")).toBeNull();
    expect(parseNumericToken("1".repeat(40))).toBeNull();
  });
});

describe("normalizeUtterance", () => {
  it("folds Ethiopic digits to ASCII", () => {
    // ፬ ፯ ፪ ፭ ፠ ፩ ፪
    expect(normalizeUtterance("\u136c\u136f\u136a\u136d\u1360\u1369\u136a")).toBe("4725012");
  });

  it("keeps a thousands comma inside a number", () => {
    expect(normalizeUtterance("5,000")).toBe("5,000");
  });

  it("strips Ethiopic sentence punctuation to whitespace", () => {
    // ፣ ።
    expect(normalizeUtterance("a\u1363b\u1362c")).toBe("a b c");
  });

  it("lowercases Latin and collapses whitespace", () => {
    expect(normalizeUtterance("  Equb   TELebirr  ")).toBe("equb telebirr");
  });

  it("is idempotent", () => {
    const once = normalizeUtterance("\u1208\u1218\u1235\u12a8\u1228\u121d\u1363\u12a5\u1241\u1265 5,000 \u1265\u122d");
    expect(normalizeUtterance(once)).toBe(once);
  });

  it("survives non-string and empty input", () => {
    expect(normalizeUtterance(undefined as unknown as string)).toBe("");
    expect(normalizeUtterance("")).toBe("");
  });

  it("bounds an absurdly long utterance", () => {
    expect(normalizeUtterance("a".repeat(10_000)).length).toBeLessThanOrEqual(2_000);
  });
});

describe("tokenizeUtterance", () => {
  it("splits on whitespace and records offsets", () => {
    const tokens = tokenizeUtterance("equb 5000 birr");
    expect(tokens.map((token) => token.text)).toEqual(["equb", "5000", "birr"]);
    expect(tokens[1].index).toBe(1);
    expect(tokens[1].offset).toBe(5);
  });

  it("returns nothing for an empty utterance", () => {
    expect(tokenizeUtterance("")).toEqual([]);
  });
});

describe("tokenVariants — Amharic glues prepositions onto nouns", () => {
  it("strips a leading marker so a lookup can succeed", () => {
    // በቴሌብር → ቴሌብር
    expect(tokenVariants("\u1260\u1274\u120c\u1265\u122d")).toEqual([
      "\u1260\u1274\u120c\u1265\u122d",
      "\u1274\u120c\u1265\u122d"
    ]);
    // ለመስከረም → መስከረም
    expect(tokenVariants("\u1208\u1218\u1235\u12a8\u1228\u121d")).toContain("\u1218\u1235\u12a8\u1228\u121d");
    // በባንክ → ባንክ
    expect(tokenVariants("\u1260\u1265\u1295\u12ad")).toContain("\u1265\u1295\u12ad");
  });

  it("leaves a bare word untouched", () => {
    expect(tokenVariants("telebirr")).toEqual(["telebirr"]);
    expect(tokenVariants("birr")).toEqual(["birr"]);
  });

  it("never strips a variant below the minimum length", () => {
    const variants = tokenVariants("\u1208\u1208\u1208");
    expect(variants.every((variant) => variant.length >= 2)).toBe(true);
    expect(variants[0]).toBe("\u1208\u1208\u1208");
  });

  it("resolves the stripped variant through a lexicon predicate", () => {
    const hit = matchTokenVariant("\u1260\u1274\u120c\u1265\u122d", (candidate) =>
      providerFromToken(candidate) !== null
    );
    expect(hit).toBe("\u1274\u120c\u1265\u122d");
  });

  it("returns null when no variant matches", () => {
    expect(
      matchTokenVariant("\u1260\u1293\u1290\u1295", (candidate) => providerFromToken(candidate) !== null)
    ).toBeNull();
  });
});

describe("the Ethiopian calendar lexica", () => {
  it("covers all 13 months, Pagumen included", () => {
    expect(ETHIOPIAN_MONTH_IDS).toHaveLength(13);
    expect(ETHIOPIAN_MONTH_IDS[0]).toBe("meskerem");
    expect(ETHIOPIAN_MONTH_IDS[12]).toBe("pagumen");
  });

  it("renders the Amharic and Gecal month names correctly", () => {
    expect(monthFormsFor("meskerem")).toContain("መስከረም");
    expect(monthFormsFor("tikimt")).toContain("ጥቅምት");
    expect(monthFormsFor("hidar")).toContain("ኅዳር");
    expect(monthFormsFor("tahsas")).toContain("ታኅሣሥ");
    expect(monthFormsFor("tir")).toContain("ጥር");
    expect(monthFormsFor("yekatit")).toContain("የካቲት");
    expect(monthFormsFor("megabit")).toContain("መጋቢት");
    expect(monthFormsFor("miyazya")).toContain("ሚያዝያ");
    expect(monthFormsFor("ginbot")).toContain("ግንቦት");
    expect(monthFormsFor("sene")).toContain("ለካሲም");
    expect(monthFormsFor("hamle")).toContain("ሐምሌ");
    expect(monthFormsFor("nehase")).toContain("ነሐሴ");
    expect(monthFormsFor("pagumen")).toContain("ጳጉሜን");
    // Gecal, not the Maddale Walaam calendar.
    expect(monthFormsFor("meskerem")).toContain("gec'boorree");
    expect(monthFormsFor("pagumen")).toContain("wikiyaa");
  });

  it("distinguishes Tahsas (month 4) from Nehase (month 12)", () => {
    // AGENTWORK.md §2 lists ታኅሣሥ twice; only one of them is Tahsas.
    expect(monthFromToken("ታኅሣሥ")).toBe("tahsas");
    expect(monthFromToken("ታህሣሥ")).toBe("tahsas");
    expect(monthFromToken("ነሐሴ")).toBe("nehase");
    expect(monthFromToken("ነሃሴ")).toBe("nehase");
    expect(monthNumber("tahsas")).toBe(4);
    expect(monthNumber("nehase")).toBe(12);
  });

  it("resolves romanized forms a recognizer emits", () => {
    expect(monthFromToken("meskerem")).toBe("meskerem");
    expect(monthFromToken("MESKEREM")).toBeNull();
    expect(monthFromToken("sanyaa")).toBe("sene");
    expect(monthFromToken("gecboorree")).toBe("meskerem");
  });

  it("exposes labels and returns null-safe lookups", () => {
    expect(monthLabel("meskerem")).toBe("Meskerem");
    expect(monthLabel(null)).toBeNull();
    expect(monthNumber(null)).toBeNull();
  });

  it("never maps a non-month word to a month", () => {
    for (const word of ["birr", "telebirr", "equb", "\u1265\u122d", "\u12a5\u1241\u1265"]) {
      expect(monthFromToken(word)).toBeNull();
    }
  });
});
