import { formatEtbAmount } from "@/lib/ledger/money";
import type { BankProvider } from "@/lib/banking/types";
import {
  isCashToken,
  isEtbToken,
  isForeignCurrencyToken,
  isGenericChannelToken,
  isGenericBankToken,
  isMoneyNounToken,
  isPaymentVerbToken,
  isTxRefTriggerToken,
  providerFromToken
} from "./lexicon";
import { monthFromToken, monthLabel } from "./months";
import { matchTokenVariant, normalizeUtterance, tokenizeUtterance, type UtteranceToken } from "./normalize";
import { composeNumeralWords, isNumeralWord, parseNumericToken, numeralPhraseToBirr } from "./numerals";
import {
  VOICE_BLOCKING_ISSUE_CODES,
  VOICE_PAYMENT_RAILS,
  type EthiopianMonthId,
  type ProvisionalContribution,
  type VoiceIssueCode,
  type VoiceLanguageDetection,
  type VoicePaymentRail
} from "./types";

/**
 * The Amharic / Afaan Oromoo entity-extraction parser.
 *
 * `"ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው"`
 * → `{ month: "meskerem", amount: 5000, provider: "telebirr", txRef: "9BF42" }`
 *
 * Pure and credential-free — no `fetch`, no `AudioContext`, no environment.
 * That is deliberate: it is the one part of M3 that can be *proved* to work
 * in CI, and `ROADMAP.md` §6.2 asks for it explicitly.
 *
 * ## Why it fails instead of guessing
 *
 * A speech parser that invents a number is a fraud tool, not a convenience.
 * Every ambiguity here resolves to `null` plus a reason, never to a
 * plausible-looking value: two amounts, a foreign currency, an unnamed
 * provider, a malformed reference. See `docs/architecture/voice.md`.
 */

/** Longest run of numeral words we will attempt to compose. */
const MAX_NUMERAL_RUN = 6;
const MAX_UTTERANCE_CHARS = 2_000;
/** Ethiopic and Latin range tests, so we can score a token's script. */
const ETHIOPIC_RANGE = /[\u1200-\u137f]/;
const LATIN_RANGE = /[a-z]/;

interface NumeralRun {
  readonly minorUnits: bigint;
  readonly firstToken: number;
  readonly lastToken: number;
  readonly source: "words" | "digits";
  readonly words: readonly string[];
}

interface ChannelSignal {
  readonly rail: VoicePaymentRail;
  readonly provider: BankProvider | null;
  /** `true` when the utterance said "bank" or "I paid" but never named a provider. */
  readonly genericBank: boolean;
  /** Every distinct provider named, for the ambiguity check. */
  readonly named: readonly BankProvider[];
}

interface RefSignal {
  readonly value: string;
  readonly source: "labelled" | "bare";
}

function isDigitOnly(token: string): boolean {
  return /^\d+$/.test(token);
}

/**
 * A token that is *trying* to be a number: digits plus grouping marks.
 *
 * `parseNumericToken` then decides whether it is well-formed. Going through
 * here means a malformed `12,34` is rejected as a whole instead of being split
 * into two plausible amounts, one of which would be read as the contribution.
 */
function isNumericLooking(token: string): boolean {
  return /^[0-9,.\u200c\u2019]+$/.test(token);
}

/** A standalone group of exactly three digits, i.e. a thousands continuation. */
function isDigitGroup(token: string): boolean {
  return /^\d{3}$/.test(token);
}

/* ── Lexicon resolution ────────────────────────────────────────────────────
 * Amharic glues prepositions onto nouns (`በቴሌብር`, `ለመስከረም`), so every
 * lookup has to consider the marker-stripped variants of a token. These
 * wrappers keep that detail in one place.
 */

function resolveProvider(token: string): BankProvider | null {
  let provider: BankProvider | null = null;
  matchTokenVariant(token, (candidate) => {
    const found = providerFromToken(candidate);
    if (found === null) {
      return false;
    }
    provider = found;
    return true;
  });
  return provider;
}

function resolveMonth(token: string): EthiopianMonthId | null {
  let month: EthiopianMonthId | null = null;
  matchTokenVariant(token, (candidate) => {
    const found = monthFromToken(candidate);
    if (found === null) {
      return false;
    }
    month = found;
    return true;
  });
  return month;
}

const resolveEtb = (token: string): boolean => matchTokenVariant(token, isEtbToken) !== null;
const resolveForeignCurrency = (token: string): boolean =>
  matchTokenVariant(token, isForeignCurrencyToken) !== null;
const resolveCash = (token: string): boolean => matchTokenVariant(token, isCashToken) !== null;
const resolveGenericBank = (token: string): boolean =>
  matchTokenVariant(token, isGenericBankToken) !== null;
const resolvePaymentVerb = (token: string): boolean =>
  matchTokenVariant(token, isPaymentVerbToken) !== null;
const resolveMoneyNoun = (token: string): boolean =>
  matchTokenVariant(token, isMoneyNounToken) !== null;
const resolveTxRefTrigger = (token: string): boolean =>
  matchTokenVariant(token, isTxRefTriggerToken) !== null;

/**
 * A token that could be a transaction reference: 4–24 characters, uppercase
 * alphanumerics, and containing at least one letter *and* one digit.
 *
 * The mixed letter+digit requirement is what keeps ordinary words out. It also
 * means a purely numeric receipt number is not mistaken for a reference — that
 * is treated as an amount, which is the safe direction.
 */
function isReferenceCandidate(token: string): boolean {
  if (token.length < 4 || token.length > 24) {
    return false;
  }
  if (!/^[a-z0-9]+$/.test(token)) {
    return false;
  }
  const hasLetter = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  return hasLetter && hasDigit;
}

function detectLanguage(tokens: readonly UtteranceToken[]): VoiceLanguageDetection {
  let ethiopic = 0;
  let latin = 0;
  for (const token of tokens) {
    // A transaction reference or a bare number is not language evidence —
    // `9BF42` in the middle of a fully Amharic sentence must not make the
    // utterance look bilingual.
    if (isReferenceCandidate(token.text) || isNumericLooking(token.text)) {
      continue;
    }
    if (ETHIOPIC_RANGE.test(token.text)) {
      ethiopic += 1;
    } else if (LATIN_RANGE.test(token.text)) {
      latin += 1;
    }
  }
  if (ethiopic > 0 && latin > 0) {
    return "mixed";
  }
  if (ethiopic > 0) {
    return "am";
  }
  if (latin > 0) {
    return "om";
  }
  return "unknown";
}

/**
 * Collect every maximal numeral run in the token stream.
 *
 * A run is either a single digit-only token or a maximal sequence of numeral
 * words. Longest-match is tried first, so `አምስት አስራ` is one run of 50 and
 * not `5` followed by an unparsed `10`.
 */
function collectNumeralRuns(tokens: readonly UtteranceToken[]): NumeralRun[] {
  const runs: NumeralRun[] = [];
  let cursor = 0;

  while (cursor < tokens.length) {
    const token = tokens[cursor];

    if (isNumericLooking(token.text)) {
      // `5 000` and `5,000` are the same number once a recognizer has eaten
      // the comma. Absorb up to four following 3-digit groups.
      let lastToken = cursor;
      let joined = token.text;
      while (
        lastToken + 1 < tokens.length &&
        lastToken - cursor < 4 &&
        isDigitGroup(tokens[lastToken + 1].text)
      ) {
        joined += tokens[lastToken + 1].text;
        lastToken += 1;
      }
      const minorUnits = parseNumericToken(joined);
      if (minorUnits !== null) {
        runs.push({
          minorUnits,
          firstToken: cursor,
          lastToken,
          source: "digits",
          words: [joined]
        });
        cursor = lastToken + 1;
        continue;
      }
      // The whole run is unusable, typically because it exceeds the accepted
      // maximum. The run is consumed rather than re-parsed from its second
      // group: `1 234 567 890` used to yield 234,567,890, silently dropping the
      // leading `1` and inventing a plausible-looking amount. A treasurer
      // acting on a misread figure is worse off than one told to re-speak.
      cursor = lastToken + 1;
      continue;
    }

    if (isNumeralWord(token.text)) {
      for (let length = Math.min(MAX_NUMERAL_RUN, tokens.length - cursor); length >= 1; length -= 1) {
        const slice: string[] = [];
        for (let offset = 0; offset < length; offset += 1) {
          const candidate = tokens[cursor + offset];
          if (!candidate || !isNumeralWord(candidate.text)) {
            break;
          }
          slice.push(candidate.text);
        }
        if (slice.length !== length) {
          continue;
        }
        const minorUnits = composeNumeralWords(slice);
        if (minorUnits === null) {
          continue;
        }
        runs.push({
          minorUnits: minorUnits * 100n,
          firstToken: cursor,
          lastToken: cursor + length - 1,
          source: "words",
          words: slice
        });
        cursor += length;
        break;
      }
      continue;
    }

    cursor += 1;
  }

  return runs;
}

/** Was this token consumed by a numeral run or a reference? */
function buildConsumedMask(tokens: readonly UtteranceToken[]): boolean[] {
  return tokens.map(() => false);
}

function markSpan(mask: boolean[], first: number, last: number): void {
  for (let index = first; index <= last; index += 1) {
    if (index < mask.length) {
      mask[index] = true;
    }
  }
}

function detectChannel(tokens: readonly UtteranceToken[]): ChannelSignal {
  const named: BankProvider[] = [];
  let cash = false;
  let generic = false;

  for (const token of tokens) {
    const provider = resolveProvider(token.text);
    if (provider !== null && !named.includes(provider)) {
      named.push(provider);
    }
    if (resolveCash(token.text)) {
      cash = true;
    }
    if (resolveGenericBank(token.text) || resolvePaymentVerb(token.text)) {
      generic = true;
    }
  }

  if (named.length > 1) {
    // Two providers in one utterance: refuse to pick. This is the
    // `AMBIGUOUS_CHANNEL` case, and it is a real phishing shape — "I paid via
    // Telebirr, send it to CBE".
    return { rail: "none", provider: null, genericBank: true, named };
  }
  if (named.length === 1) {
    return { rail: "bank", provider: named[0], genericBank: false, named };
  }
  if (cash) {
    return { rail: "cash", provider: null, genericBank: false, named };
  }
  if (generic) {
    return { rail: "bank", provider: null, genericBank: true, named };
  }
  return { rail: "none", provider: null, genericBank: false, named };
}

/**
 * Find the transaction reference, preferring one a speaker *labelled*.
 *
 * Telebirr and CBE references are 8–10 uppercase alphanumerics, so a bare
 * run of 4 mixed alphanumerics in a contribution utterance is a weak signal
 * at best — which is why `bare` refs are flagged `UNRELIABLE_TX_REF` and a
 * treasurer is asked to confirm.
 */
function detectTxRef(tokens: readonly UtteranceToken[]): RefSignal | null {
  const candidates: { token: number; value: string }[] = [];
  for (const token of tokens) {
    if (isReferenceCandidate(token.text)) {
      candidates.push({ token: token.index, value: token.text.toUpperCase() });
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    return null;
  }

  const [candidate] = candidates;
  const previous = candidate.token > 0 ? tokens[candidate.token - 1] : null;
  const next = tokens[candidate.token + 1] ?? null;
  const labelled =
    (previous !== null && resolveTxRefTrigger(previous.text)) ||
    (next !== null && resolveTxRefTrigger(next.text)) ||
    (next !== null && /^[\u1290\u12cd]$/u.test(next.text)); // ነው / ነው።
  return { value: candidate.value, source: labelled ? "labelled" : "bare" };
}

function isCurrencyAdjacent(
  tokens: readonly UtteranceToken[],
  mask: readonly boolean[],
  run: NumeralRun
): boolean {
  const before = run.firstToken - 1;
  const after = run.lastToken + 1;
  if (before >= 0 && !mask[before] && resolveEtb(tokens[before].text)) {
    return true;
  }
  if (after < tokens.length && !mask[after] && resolveEtb(tokens[after].text)) {
    return true;
  }
  return false;
}

function isForeignCurrencyAdjacent(
  tokens: readonly UtteranceToken[],
  mask: readonly boolean[],
  run: NumeralRun
): boolean {
  const before = run.firstToken - 1;
  const after = run.lastToken + 1;
  if (before >= 0 && !mask[before] && resolveForeignCurrency(tokens[before].text)) {
    return true;
  }
  if (after < tokens.length && !mask[after] && resolveForeignCurrency(tokens[after].text)) {
    return true;
  }
  return false;
}

function isMoneyAdjacent(
  tokens: readonly UtteranceToken[],
  mask: readonly boolean[],
  run: NumeralRun
): boolean {
  for (let offset = -2; offset <= 2; offset += 1) {
    const index = offset < 0 ? run.firstToken + offset : run.lastToken + offset;
    if (index < 0 || index >= tokens.length || mask[index]) {
      continue;
    }
    if (resolveMoneyNoun(tokens[index].text) || resolvePaymentVerb(tokens[index].text)) {
      return true;
    }
  }
  return false;
}

/** Was this run immediately introduced by a reference label? e.g. `ቁጥር 5`. */
function isReferenceLabelledRun(
  tokens: readonly UtteranceToken[],
  mask: readonly boolean[],
  run: NumeralRun
): boolean {
  const before = run.firstToken - 1;
  return before >= 0 && !mask[before] && resolveTxRefTrigger(tokens[before].text);
}

export interface ParseOptions {
  /**
   * Currency to record when the utterance never said one. Defaults to `"ETB"`,
   * the only currency `bankVerificationRequestSchema` accepts. When it is used
   * the result carries `INFERRED_CURRENCY` so the UI can say so.
   */
  readonly assumedCurrency?: "ETB";
}

/**
 * Parse one spoken (or typed) contribution sentence.
 *
 * Never throws. A garbage input returns a `ProvisionalContribution` with
 * `amount: null` and a blocking issue.
 */
export function parseContributionUtterance(
  input: string,
  options: ParseOptions = {}
): ProvisionalContribution {
  const utterance = typeof input === "string" ? input.trim().slice(0, MAX_UTTERANCE_CHARS) : "";
  const normalized = normalizeUtterance(input);
  const tokens = tokenizeUtterance(normalized);
  const issues = new Set<VoiceIssueCode>();

  if (tokens.length === 0) {
    issues.add("UNPARSEABLE");
    return build({
      utterance,
      normalized,
      language: "unknown",
      amount: null,
      monthId: null,
      rail: "none",
      provider: null,
      txRef: null,
      txRefSource: null,
      currencySource: "assumed",
      issues
    });
  }

  const language = detectLanguage(tokens);
  const mask = buildConsumedMask(tokens);
  const runs = collectNumeralRuns(tokens);
  for (const run of runs) {
    markSpan(mask, run.firstToken, run.lastToken);
  }

  // --- transaction reference -------------------------------------------
  // Detect before scoring amounts so a bare numeric receipt number that sits
  // next to a reference label is not read as a second amount.
  const txRef = detectTxRef(tokens);

  // --- amount -----------------------------------------------------------
  const usableRuns = runs.filter((run) => !isReferenceLabelledRun(tokens, mask, run));
  const currencyRuns = usableRuns.filter((run) =>
    isCurrencyAdjacent(tokens, mask, run)
  );
  const foreignCurrencyRuns = usableRuns.filter((run) =>
    isForeignCurrencyAdjacent(tokens, mask, run)
  );
  const moneyRuns = usableRuns.filter((run) => isMoneyAdjacent(tokens, mask, run));

  let amount: number | null = null;
  let currencySource: "explicit" | "assumed" = "assumed";

  if (foreignCurrencyRuns.length > 0 && currencyRuns.length === 0) {
    // `ዶላር 500` must never become a 500 birr contribution.
    issues.add("CURRENCY_MISMATCH");
    issues.add("NO_AMOUNT");
  } else if (currencyRuns.length === 1) {
    amount = numeralPhraseToBirr(currencyRuns[0].minorUnits);
    currencySource = "explicit";
  } else if (currencyRuns.length > 1) {
    issues.add("AMBIGUOUS_AMOUNT");
  } else if (moneyRuns.length === 1) {
    amount = numeralPhraseToBirr(moneyRuns[0].minorUnits);
  } else if (moneyRuns.length > 1) {
    issues.add("AMBIGUOUS_AMOUNT");
  } else if (usableRuns.length === 1) {
    amount = numeralPhraseToBirr(usableRuns[0].minorUnits);
  } else if (usableRuns.length > 1) {
    issues.add("AMBIGUOUS_AMOUNT");
  } else {
    issues.add("NO_AMOUNT");
  }

  if (amount !== null && amount <= 0) {
    amount = null;
    issues.add("NO_AMOUNT");
  }
  if (currencySource === "assumed" && amount !== null) {
    issues.add("INFERRED_CURRENCY");
  }

  // --- month -------------------------------------------------------------
  const monthIds = new Set<EthiopianMonthId>();
  for (const token of tokens) {
    const month = resolveMonth(token.text);
    if (month !== null) {
      monthIds.add(month);
    }
  }
  if (monthIds.size > 1) {
    issues.add("MULTIPLE_MONTHS");
  }
  const [firstMonth] = [...monthIds];
  const monthId = firstMonth ?? null;

  // --- channel -----------------------------------------------------------
  const channel = detectChannel(tokens);
  if (channel.named.length > 1) {
    issues.add("AMBIGUOUS_CHANNEL");
  } else if (channel.rail === "cash") {
    // A cash contribution is real money, but no bank can ever settle it, so it
    // is surfaced rather than quietly routed to a provider.
    issues.add("CASH_CHANNEL");
  } else if (channel.rail === "bank" && channel.provider === null) {
    issues.add("AMBIGUOUS_CHANNEL");
  } else if (channel.rail === "none") {
    issues.add("NO_CHANNEL");
  }

  // --- reference ---------------------------------------------------------
  let txRefValue: string | null = null;
  let txRefSource: "labelled" | "bare" | null = null;
  if (txRef === null) {
    issues.add("NO_TX_REF");
  } else {
    txRefValue = txRef.value;
    txRefSource = txRef.source;
    if (txRef.source === "bare") {
      issues.add("UNRELIABLE_TX_REF");
    }
  }

  return build({
    utterance,
    normalized,
    language,
    amount,
    monthId,
    rail: channel.rail,
    provider: channel.provider,
    txRef: txRefValue,
    txRefSource,
    currencySource,
    issues
  });
}

function build(input: {
  readonly utterance: string;
  readonly normalized: string;
  readonly language: VoiceLanguageDetection;
  readonly amount: number | null;
  readonly monthId: EthiopianMonthId | null;
  readonly rail: VoicePaymentRail;
  readonly provider: BankProvider | null;
  readonly txRef: string | null;
  readonly txRefSource: "labelled" | "bare" | null;
  readonly currencySource: "explicit" | "assumed";
  readonly issues: ReadonlySet<VoiceIssueCode>;
}): ProvisionalContribution {
  const issues = [...input.issues].sort();
  const blocking = issues.some((issue) => VOICE_BLOCKING_ISSUE_CODES.has(issue));
  return {
    status: "PROVISIONAL",
    verified: false,
    language: input.language,
    amount: input.amount,
    amountWire: toWireAmount(input.amount),
    currency: "ETB",
    currencySource: input.currencySource,
    month: input.monthId,
    monthLabel: monthLabel(input.monthId),
    rail: input.rail,
    provider: input.provider,
    txRef: input.txRef,
    txRefSource: input.txRefSource,
    utterance: input.utterance,
    normalized: input.normalized,
    issues,
    blocking
  };
}

/**
 * Format through A1's own money module so the two lanes cannot disagree about
 * the shape of a number. Returns `null` rather than throwing: a value A1's
 * ledger would reject is a value the treasurer must see, not a crash.
 */
function toWireAmount(amount: number | null): string | null {
  if (amount === null || !Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  try {
    return formatEtbAmount(`${amount}.00`);
  } catch {
    return null;
  }
}

export { VOICE_PAYMENT_RAILS };
