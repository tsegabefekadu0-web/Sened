/**
 * Ethiopian numeral phrasing: Amharic and Afaan Oromoo numerals, digit-group
 * separators, and their composition.
 *
 * Both languages use a *decimal* (not sexagesimal) system, and both place the
 * unit either before or after the tens depending on the value:
 *
 *   - round tens take a unit prefix:  Amharic `አምስት አስራ` = 50,
 *     Oromo `shan digdama` = 50
 *   - everything else takes a unit suffix:  Amharic `ሃያ አንድ` = 21,
 *     Oromo `digdama tokkee` = 21
 *
 * Those two forms are genuinely ambiguous in the surface string — `አምስት አስራ`
 * cannot be distinguished from a mis-phrased 51 — so this module resolves the
 * prefix form to the round multiple and **refuses to guess anything else**. A
 * treasury parser that invents a digit is worse than one that returns `null`
 * and asks a human.
 *
 * All Ethiopic keys are written as `\uXXXX` escapes so the lexica cannot be
 * corrupted by an editor that does not round-trip Ge'ez. `test/voice.numerals.test.ts`
 * asserts the rendered forms so a typo in an escape is caught, not shipped.
 */

export type NumeralKind = "unit" | "tens" | "multiplier";

export interface NumeralWord {
  readonly kind: NumeralKind;
  readonly value: bigint;
}

const UNITS: Readonly<Record<string, bigint>> = {
  // Amharic
  "\u12a0\u1295\u12f5": 1n, // አንድ
  "\u1201\u1208\u1275": 2n, // ሁለት
  "\u1226\u1235\u1275": 3n, // ሦስት
  "\u12a0\u122b\u1275": 4n, // አራት
  "\u12a0\u121d\u1235\u1275": 5n, // አምስት
  "\u1235\u12f5\u1235\u1275": 6n, // ስድስት
  "\u1230\u1263\u1275": 7n, // ሰባት
  "\u1235\u121d\u1295\u1275": 8n, // ስምንት
  "\u12d8\u1320\u129d": 9n, // ዘጠኝ
  // Afaan Oromoo
  kana: 1n,
  kanaan: 1n,
  kanaa: 1n,
  lamaa: 2n,
  lama: 2n,
  sadii: 3n,
  sadi: 3n,
  afur: 4n,
  shan: 5n,
  shaan: 5n,
  jaha: 6n,
  jahaa: 6n,
  tokkee: 7n,
  tokko: 7n,
  sadde: 8n,
  sade: 8n,
  saga: 9n,
  sagaa: 9n
};

const TENS: Readonly<Record<string, bigint>> = {
  // Amharic
  "\u12a0\u1235\u122b": 10n, // አስራ
  "\u1203\u12eb": 20n, // ሃያ
  "\u1230\u120b\u1233": 30n, // ሰላሳ
  "\u12a0\u122d\u1263": 40n, // አርባ
  "\u1203\u121d\u1233": 50n, // ሃምሳ
  "\u1235\u12f5\u1233": 60n, // ስድሳ
  "\u1230\u1263": 70n, // ሰባ
  "\u1230\u121b\u1295\u12eb": 80n, // ሰማንያ
  "\u1230\u12f5\u1233": 90n, // ሰድሳ
  // Afaan Oromoo
  dha: 10n,
  daa: 10n,
  digdama: 20n,
  diggama: 20n,
  digama: 20n,
  digdamee: 20n,
  sodoma: 30n,
  sodomaa: 30n,
  sodomee: 30n,
  hajjama: 40n,
  hajama: 40n,
  hunjama: 40n,
  shantama: 50n,
  shaantama: 50n,
  mootuma: 60n,
  mutuma: 60n,
  tokkoma: 70n,
  tokoma: 70n
};

/**
 * Multipliers. A bare multiplier means the multiplier itself (`ሺህ` = 1000);
 * combined with a pending unit it multiplies it (`አምስት ሺህ` = 5000).
 */
const MULTIPLIERS: Readonly<Record<string, bigint>> = {
  // Amharic
  "\u1218\u1276": 100n, // መቶ
  "\u12a0\u1218\u1276": 100n, // አመቶ
  "\u12a0\u123d\u1275": 1000n, // አሽት
  "\u123a\u1205": 1000n, // ሺህ
  "\u12a3\u1225\u122d": 10_000n, // ኣሥር
  "\u12a0\u123d\u1270\u129b": 2000n, // አሽተኛ
  "\u12a3\u123d\u1270\u129b": 2000n, // ኣሽተኛ
  "\u123a\u1205\u129b": 1000n, // ሺህኛ
  // Afaan Oromoo
  kuu: 100n,
  dugum: 1000n,
  dugummee: 1000n,
  dhugum: 1000n,
  kumaa: 1_000_000n
};

/**
 * Two-word compounds the generic rule cannot derive. Oromo builds 80 and 90 as
 * `8 × 10` *after* a tens word (`sadde tokkoma`), which the generic rule would
 * read as 78.
 */
const COMPOSITES: Readonly<Record<string, NumeralWord>> = {
  "sadde tokkoma": { kind: "tens", value: 80n },
  "sadde digdama": { kind: "tens", value: 80n },
  "sadde mootuma": { kind: "tens", value: 80n },
  "sade tokkoma": { kind: "tens", value: 80n },
  "sade digdama": { kind: "tens", value: 80n },
  "saga tokkoma": { kind: "tens", value: 90n },
  "saga digdama": { kind: "tens", value: 90n },
  "saga mootuma": { kind: "tens", value: 90n }
};

/** Refuse to compose anything no Ethiopian treasury could plausibly mean. */
export const MAX_NUMERAL_VALUE = 1_000_000_000n;

function classify(word: string): NumeralWord | null {
  const unit = UNITS[word];
  if (unit !== undefined) {
    return { kind: "unit", value: unit };
  }
  const tens = TENS[word];
  if (tens !== undefined) {
    return { kind: "tens", value: tens };
  }
  const multiplier = MULTIPLIERS[word];
  if (multiplier !== undefined) {
    return { kind: "multiplier", value: multiplier };
  }
  return null;
}

export function isNumeralWord(word: string): boolean {
  return classify(word) !== null;
}

/**
 * Compose a run of numeral *words* into a value in whole units.
 *
 * Returns `null` — never a guess — when the run is not a well-formed
 * Ethiopian numeral. See the module comment for the ambiguity that forces the
 * prefix/suffix rule.
 */
interface Part {
  readonly value: bigint;
  /** May a following multiplier scale this? */
  readonly scalable: boolean;
  /** Did a multiplier produce this? A unit may not follow one. */
  readonly fromMultiplier: boolean;
}

function part(value: bigint, scalable: boolean, fromMultiplier = false): Part {
  return { value, scalable, fromMultiplier };
}

/**
 * Compose a run of numeral *words* into a value in whole units.
 *
 * Returns `null` — never a guess — when the run is not a well-formed
 * Ethiopian numeral. See the module comment for the ambiguity that forces the
 * prefix/suffix rule.
 *
 * The unit is resolved against the **following** word, not by carrying state
 * forward, because that is the only way to tell `አህሪ ሺህ` (50 × 1,000) from
 * `ሃያ አንድ` (20 + 1) without a second pass. Lookahead also keeps a
 * tens-plus-unit pair — a finished number — from being scaled by a later
 * multiplier, which is how `tokkoma dugum` would otherwise become 70,070.
 */
export function composeNumeralWords(words: readonly string[]): bigint | null {
  if (words.length === 0 || words.length > 6) {
    return null;
  }

  const parts: Part[] = [];
  let cursor = 0;

  while (cursor < words.length) {
    const pair = cursor + 1 < words.length ? `${words[cursor]} ${words[cursor + 1]}` : null;
    if (pair !== null && pair in COMPOSITES) {
      parts.push(part(COMPOSITES[pair].value, true));
      cursor += 2;
      continue;
    }

    const entry = classify(words[cursor]);
    if (!entry) {
      return null;
    }
    const next = cursor + 1 < words.length ? classify(words[cursor + 1]) : null;

    if (entry.kind === "unit") {
      const previous = parts[parts.length - 1];
      if (previous?.fromMultiplier === true) {
        // `አሽት ሁለት` must not become 1,002.
        return null;
      }
      if (next?.kind === "tens") {
        // Prefix form: `አምስት አስራ` = 50.
        parts.push(part(entry.value * 10n, true));
        cursor += 2;
        continue;
      }
      parts.push(part(entry.value, true));
      cursor += 1;
      continue;
    }

    if (entry.kind === "tens") {
      if (next?.kind === "unit") {
        // Suffix form: `ሃያ አንድ` = 21. Finished — a later multiplier must
        // not scale it.
        parts.push(part(entry.value + next.value, false));
        cursor += 2;
        continue;
      }
      parts.push(part(entry.value, true));
      cursor += 1;
      continue;
    }

    const previous = parts.pop();
    if (previous === undefined) {
      // A bare multiplier *is* the multiplier: `ሺህ` = 1,000.
      parts.push(part(entry.value, false, true));
    } else if (previous.fromMultiplier) {
      // `ሺህ አሽት` is not a number anyone says.
      return null;
    } else {
      parts.push(part(previous.value * entry.value, false, true));
    }
    cursor += 1;
  }

  if (parts.length === 0) {
    return null;
  }
  let total = 0n;
  for (const item of parts) {
    total += item.value;
    if (total > MAX_NUMERAL_VALUE) {
      return null;
    }
  }
  return total;
}

/**
 * Parse a token that is *only* digits and digit-group separators.
 *
 * Accepts `5000`, `5,000`, `5 000`, `5.000` (Ethiopians commonly write a
 * thousands dot) and `5,000.00`.
 *
 * Rejects any token containing a letter. A token with letters is a transaction
 * reference, not an amount, and conflating the two is how a reference becomes
 * a five-hundred-thousand-birr contribution.
 */
export function parseNumericToken(token: string): bigint | null {
  if (token.length === 0 || token.length > 24) {
    return null;
  }
  let digits = "";
  let fraction = "";
  let seenPoint = false;
  let separators = 0;
  for (const character of token) {
    if (character >= "0" && character <= "9") {
      if (seenPoint) {
        fraction += character;
      } else {
        digits += character;
      }
      continue;
    }
    if (character === "," || character === " " || character === "\u200c" || character === "\u2019") {
      separators += 1;
      continue;
    }
    if (character === ".") {
      if (seenPoint) {
        return null;
      }
      seenPoint = true;
      continue;
    }
    return null;
  }

  if (digits.length === 0 || digits.length > 18 || fraction.length > 2) {
    return null;
  }
  // A separator may only sit between groups of three digits.
  if (separators > 0 && !/^\d{1,3}([,\s]\d{3})*(\.\d{1,2})?$/.test(token)) {
    return null;
  }

  const value = BigInt(digits) * 100n + BigInt((fraction + "00").slice(0, 2));
  return value <= MAX_NUMERAL_VALUE * 100n ? value : null;
}

/** A number phrase found inside an utterance. */
export interface NumeralPhrase {
  /** Value in **birr minor units** (1 birr = 100), matching A1's wire scale. */
  readonly minorUnits: bigint;
  readonly firstToken: number;
  readonly lastToken: number;
  readonly source: "words" | "digits";
  /** The tokens the phrase was built from. */
  readonly words: readonly string[];
}

/** Read a phrase's whole-birr value. Minor units are dropped deliberately. */
export function numeralPhraseToBirr(minorUnits: bigint): number {
  return Number(minorUnits / 100n);
}
