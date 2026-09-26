/**
 * Text normalization for Amharic / Afaan Oromoo transcripts.
 *
 * Pure, synchronous, dependency-free. The parser is the crown jewel of this
 * lane precisely because it needs no credentials, so everything here is
 * exercised directly by `test/voice.parser.test.ts`.
 */

/**
 * Ethiopic digits (U+1360–U+137C) → ASCII, plus Arabic-Indic digits
 * (U+0660–U+0669) which still appear in pasted telebirr receipts.
 */
const DIGIT_FOLD: Readonly<Record<string, string>> = {
  "\u1360": "0",
  "\u1369": "1",
  "\u136a": "2",
  "\u136b": "3",
  "\u136c": "4",
  "\u136d": "5",
  "\u136e": "6",
  "\u136f": "7",
  "\u1370": "8",
  "\u1371": "9",
  "\u1372": "10",
  "\u1373": "20",
  "\u1374": "30",
  "\u1375": "40",
  "\u1376": "50",
  "\u1377": "60",
  "\u1378": "70",
  "\u1379": "80",
  "\u137a": "90",
  "\u137b": "100",
  "\u137c": "10000",
  "\u0660": "0",
  "\u0661": "1",
  "\u0662": "2",
  "\u0663": "3",
  "\u0664": "4",
  "\u0665": "5",
  "\u0666": "6",
  "\u0667": "7",
  "\u0668": "8",
  "\u0669": "9"
};

/**
 * Ethiopic punctuation that separates phrases. These carry no parsing signal,
 * so they become whitespace. Ethiopic *digits* (U+1360–U+137C) are not listed
 * here — they are folded to ASCII first, so a reference such as `፬፪` reaches
 * the number parser intact.
 */
const PUNCTUATION_FOLD: Readonly<Record<string, string>> = {
  "\u1361": " ", //  ፡
  "\u1362": " ", //  ።
  "\u1363": " ", //  ፣
  "\u1364": " ", //  ፤
  "\u1365": " ", //  ፥
  "\u1366": " ", //  ፦
  "\u1367": " ", //  ፧
  "\u1368": " " //  ፨
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const ASCII_PUNCTUATION = /^[,;:!?()[\]{}"«»"'“”‘’…/\\|]$/;
const DIGIT = /^[0-9]$/;

const MAX_UTTERANCE_LENGTH = 2_000;

const ETHIOPIC = /[\u1200-\u137f]/;

/**
 * Fold Ethiopic/Arabic digits to ASCII.
 *
 * Digits are folded *before* punctuation is stripped, so `፬፣፪` (4,2)
 * becomes `42` and not `4 2`.
 */
export function normalizeDigits(text: string): string {
  let output = "";
  for (const character of text) {
    const folded = DIGIT_FOLD[character];
    output += folded ?? character;
  }
  return output;
}

/**
 * Replace Ethiopic and ASCII punctuation that separates phrases with a space.
 * Hyphens and underscores survive: they occur inside transaction references.
 *
 * A comma **between two digits** is kept, so `5,000` stays one token. Turning
 * it into a space would turn a malformed `12,34` into two plausible amounts —
 * the parser would then read the tail of a typo as the real figure.
 */
export function normalizePunctuation(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const folded = PUNCTUATION_FOLD[character];
    if (folded !== undefined) {
      output += folded;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      output += " ";
      continue;
    }
    if (character === "," && DIGIT.test(text[index - 1] ?? "") && DIGIT.test(text[index + 1] ?? "")) {
      output += ",";
      continue;
    }
    if (ASCII_PUNCTUATION.test(character)) {
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

/** Latin text is case-insensitive; Ethiopic has no case. */
export function foldCase(text: string): string {
  return text.toLowerCase();
}

/**
 * Full normalization pass. Idempotent: `normalizeUtterance(normalizeUtterance(x))`
 * equals `normalizeUtterance(x)`.
 */
export function normalizeUtterance(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  const bounded = input.slice(0, MAX_UTTERANCE_LENGTH);
  return foldCase(normalizePunctuation(normalizeDigits(bounded)))
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A single whitespace-delimited token of a normalized utterance. */
export interface UtteranceToken {
  readonly text: string;
  /** Index of the token within the token list. */
  readonly index: number;
  /** Character offset of the token within the normalized utterance. */
  readonly offset: number;
}

const MAX_TOKENS = 512;

/**
 * Split a normalized utterance into whitespace tokens.
 *
 * Tokens are kept whole: grouping characters are meaningful in transaction
 * references (`9BF 42A6`), so digit-group splitting is the number parser's
 * job, not the tokenizer's.
 */
export function tokenizeUtterance(normalized: string): UtteranceToken[] {
  const tokens: UtteranceToken[] = [];
  let offset = 0;
  for (const raw of normalized.split(" ")) {
    if (raw.length === 0) {
      offset += 1;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) {
      break;
    }
    tokens.push({ text: raw, index: tokens.length, offset });
    offset += raw.length + 1;
  }
  return tokens;
}

/**
 * Amharic attaches case and preposition markers directly to the noun:
 * `ለመስከረም` (for Meskerem), `በቴሌብር` (via Telebirr), `በባንክ` (at the bank).
 * There is no space to split on, so a lexicon lookup on the raw token misses
 * the very words a treasurer actually says.
 *
 * `tokenVariants` returns the token itself followed by the same token with any
 * number of leading markers stripped, longest-first. Lookups try each in order
 * and take the first hit, so `በቴሌብር` resolves to `ቴሌብር` → `telebirr`.
 */
const LEADING_MARKERS: readonly string[] = [
  "\u1235\u1208", // ስለ
  "\u12d8\u12f0", // ወደ
  "\u12a8", // ከ
  "\u1260", // በ
  "\u1208", // ለ
  "\u12e8", // የ
  "\u12a8\u1295", // ክን
  "\u12a8\u1230" // ክሰ
];

const MIN_VARIANT_LENGTH = 2;
const MAX_VARIANTS = 4;

export function tokenVariants(token: string): string[] {
  if (token.length < MIN_VARIANT_LENGTH || !ETHIOPIC.test(token)) {
    return [token];
  }
  const variants = [token];
  let current = token;
  for (let round = 0; round < MAX_VARIANTS; round += 1) {
    const marker = LEADING_MARKERS.find((candidate) => current.startsWith(candidate));
    if (marker === undefined) {
      break;
    }
    const stripped = current.slice(marker.length);
    if (stripped.length < MIN_VARIANT_LENGTH) {
      break;
    }
    variants.push(stripped);
    current = stripped;
  }
  return variants;
}

/** The first variant of `token` that satisfies `predicate`. */
export function matchTokenVariant(
  token: string,
  predicate: (candidate: string) => boolean
): string | null {
  for (const variant of tokenVariants(token)) {
    if (predicate(variant)) {
      return variant;
    }
  }
  return null;
}
