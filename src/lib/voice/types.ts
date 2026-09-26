import type { BankProvider } from "@/lib/banking/types";

/**
 * Roadmap M3 — Zero-Trust Voice Pipeline.
 *
 * Everything in `src/lib/voice/**` is a *provisional* information-extraction
 * layer. Nothing here commits money. `docs/IDEATION.md` §5.1 and AGENTWORK.md
 * §12.4 are the contract: speech produces candidate entities; the bank
 * produces truth.
 */

/** Utterance language codes we attempt to parse. */
export const VOICE_LANGUAGES = ["am", "om"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** Which language(s) a transcript actually contained. */
export type VoiceLanguageDetection = VoiceLanguage | "mixed" | "unknown";

/**
 * The 13 months of the Ethiopian calendar. `AGENTWORK.md` §2 lists
 * `ታኅሣሥ` twice (it is Tahsas, month 4, *not* Nehase, month 12);
 * `docs/AGENT_BRIEFINGS.md` carries the corrected list and that is what is
 * implemented here. See `docs/architecture/voice.md`.
 */
export const ETHIOPIAN_MONTH_IDS = [
  "meskerem",
  "tikimt",
  "hidar",
  "tahsas",
  "tir",
  "yekatit",
  "megabit",
  "miyazya",
  "ginbot",
  "sene",
  "hamle",
  "nehase",
  "pagumen"
] as const;

export type EthiopianMonthId = (typeof ETHIOPIAN_MONTH_IDS)[number];

/** English label for each month, used in `ProvisionalContribution.monthLabel`. */
export const ETHIOPIAN_MONTH_LABELS: Readonly<Record<EthiopianMonthId, string>> = {
  meskerem: "Meskerem",
  tikimt: "Tikimt",
  hidar: "Hidar",
  tahsas: "Tahsas",
  tir: "Tir",
  yekatit: "Yekatit",
  megabit: "Megabit",
  miyazya: "Miyazya",
  ginbot: "Ginbot",
  sene: "Sene",
  hamle: "Hamle",
  nehase: "Nehase",
  pagumen: "Pagumen"
};

/** Position in the Ethiopian year. Pagumen is the short 13th month (5–6 days). */
export const ETHIOPIAN_MONTH_NUMBERS: Readonly<Record<EthiopianMonthId, number>> = {
  meskerem: 1,
  tikimt: 2,
  hidar: 3,
  tahsas: 4,
  tir: 5,
  yekatit: 6,
  megabit: 7,
  miyazya: 8,
  ginbot: 9,
  sene: 10,
  hamle: 11,
  nehase: 12,
  pagumen: 13
};

/**
 * How the money moved. `cash` is deliberately modelled as its own rail:
 * a cash contribution can never be settled by a bank provider, so it must
 * never be sent down the Telebirr/CBE verification path.
 */
export const VOICE_PAYMENT_RAILS = ["bank", "cash", "none"] as const;
export type VoicePaymentRail = (typeof VOICE_PAYMENT_RAILS)[number];

/**
 * Everything that can be wrong with an extraction. All of them are surfaced to
 * the treasurer; none of them are silently repaired.
 */
export const VOICE_ISSUE_CODES = [
  "UNPARSEABLE",
  "NO_AMOUNT",
  "AMBIGUOUS_AMOUNT",
  "CURRENCY_MISMATCH",
  "INFERRED_CURRENCY",
  "NO_CHANNEL",
  "AMBIGUOUS_CHANNEL",
  "CASH_CHANNEL",
  "NO_TX_REF",
  "UNRELIABLE_TX_REF",
  "MULTIPLE_MONTHS"
] as const;

export type VoiceIssueCode = (typeof VOICE_ISSUE_CODES)[number];

/**
 * Issues that make the draft unusable without a human. A draft carrying any of
 * these must not be offered to a bank provider.
 */
export const VOICE_BLOCKING_ISSUE_CODES: ReadonlySet<VoiceIssueCode> = new Set<VoiceIssueCode>([
  "UNPARSEABLE",
  "NO_AMOUNT",
  "AMBIGUOUS_AMOUNT",
  "CURRENCY_MISMATCH",
  "NO_CHANNEL",
  "AMBIGUOUS_CHANNEL"
]);

/**
 * The output of speech extraction.
 *
 * `status` and `verified` are **literal types with a single permitted value**.
 * There is no code path in this lane that can widen them, and a test asserts
 * that. A contribution assembled from an audio file is provisional forever,
 * regardless of how confident the transcription was.
 */
export interface ProvisionalContribution {
  /** Always `"PROVISIONAL"`. See `docs/IDEATION.md` §5.1. */
  readonly status: "PROVISIONAL";
  /** Always `false`. There is no code path in A2's lane that sets this true. */
  readonly verified: false;
  readonly language: VoiceLanguageDetection;
  /** Whole birr, or `null` when the utterance carried no usable amount. */
  readonly amount: number | null;
  /**
   * The same amount in A1's wire format (`WIRE_ETB_DECIMAL_PATTERN`,
   * e.g. `"5000.00"`), produced by `formatEtbAmount` so the two lanes cannot
   * disagree about the shape of a number.
   */
  readonly amountWire: string | null;
  /** Always `"ETB"` — the only currency the ledger schema accepts. */
  readonly currency: "ETB";
  /** Whether the utterance actually said a currency, or we assumed ETB. */
  readonly currencySource: "explicit" | "assumed";
  readonly month: EthiopianMonthId | null;
  readonly monthLabel: string | null;
  readonly rail: VoicePaymentRail;
  /** `BankProvider` from `src/lib/banking/types.ts` — never invented. */
  readonly provider: BankProvider | null;
  readonly txRef: string | null;
  readonly txRefSource: "labelled" | "bare" | null;
  /** Exactly what the recognizer heard, trimmed. */
  readonly utterance: string;
  /** Normalized form the parser actually worked on. */
  readonly normalized: string;
  readonly issues: readonly VoiceIssueCode[];
  /** True when at least one blocking issue is present. */
  readonly blocking: boolean;
}

export function isBlocking(extraction: ProvisionalContribution): boolean {
  return extraction.blocking;
}

/**
 * The minimum a treasurer must supply by hand before a draft can be offered
 * to a bank provider. Deliberately excludes `txRef`: a missing transaction
 * reference is a real-world condition that the bank can also tell us about,
 * so it is surfaced as `NO_TX_REF` but is not by itself a hard block.
 */
export function isSubmittableToBank(extraction: ProvisionalContribution): boolean {
  return (
    !extraction.blocking &&
    extraction.rail === "bank" &&
    extraction.provider !== null &&
    extraction.amount !== null &&
    extraction.amount > 0
  );
}

/** Human-facing labels for issue codes, keyed by code — not a UI string table. */
export const VOICE_ISSUE_DETAIL: Readonly<
  Record<VoiceIssueCode, { readonly blocking: boolean; readonly field: "transcript" | "amount" | "currency" | "channel" | "txRef" | "month" }>
> = {
  UNPARSEABLE: { blocking: true, field: "transcript" },
  NO_AMOUNT: { blocking: true, field: "amount" },
  AMBIGUOUS_AMOUNT: { blocking: true, field: "amount" },
  CURRENCY_MISMATCH: { blocking: true, field: "currency" },
  INFERRED_CURRENCY: { blocking: false, field: "currency" },
  NO_CHANNEL: { blocking: true, field: "channel" },
  AMBIGUOUS_CHANNEL: { blocking: true, field: "channel" },
  CASH_CHANNEL: { blocking: false, field: "channel" },
  NO_TX_REF: { blocking: false, field: "txRef" },
  UNRELIABLE_TX_REF: { blocking: false, field: "txRef" },
  MULTIPLE_MONTHS: { blocking: false, field: "month" }
};
