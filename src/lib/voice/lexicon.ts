import type { BankProvider } from "@/lib/banking/types";
import { VOICE_PAYMENT_RAILS, type VoicePaymentRail } from "./types";

/**
 * Domain lexicon for Ethiopian contribution speech.
 *
 * Provider ids are **imported from A1's enum** (`BANK_PROVIDERS`), never
 * re-declared. A voice draft that names a provider A1 does not know about
 * would be unroutable, so the type system is the guard.
 */

export const SUPPORTED_PROVIDERS: readonly BankProvider[] = ["telebirr", "cbe", "awash"];

/** Words that name a specific bank/mobile-money provider. */
const PROVIDER_FORMS: Readonly<Record<BankProvider, readonly string[]>> = {
  telebirr: [
    "\u1274\u120c\u1265\u122d", // ቴሌብር
    "\u1274\u1208\u1265\u122d", // ቴለብር
    "\u1274\u120c\u1268\u122d", // ቴሌበር
    "telebirr",
    "telebir",
    "tellebir",
    "tellebirr",
    "teleebir",
    "tellebir"
  ],
  cbe: [
    "\u1232\u1262\u12a2", // ሲቢኢ
    "\u1232\u1262\u1265", // ሲቢብ
    "\u1232\u1262", // ሲቢ
    "cbe",
    "c.b.e",
    "si bee ee",
    "cbe birr",
    "cbe bir"
  ],
  awash: [
    "\u12a0\u12cb\u123d", // አዋሽ
    "\u12a0\u12cb\u1230", // አዋሰ
    "awash",
    "awaash",
    "awash bank",
    "awasa"
  ]
};

/** Words that mean "money moved, but not through a bank we can verify". */
const CASH_FORMS: readonly string[] = [
  "\u1325\u122c", // ጥሬ
  "\u1325\u122c\u1295", // ጥሬን
  "cash",
  "qeer",
  "qaar"
];

/** Words that mean "a bank" without saying which one. */
const GENERIC_BANK_FORMS: readonly string[] = [
  "\u1265\u1295\u12ad", // ባንክ
  "bank",
  "banki",
  "baanki"
];

/** Explicit birr denominations. */
const ETB_FORMS: readonly string[] = [
  "\u1265\u122d", // ብር
  "\u1265\u122e", // ብሮ
  "\u1265\u122d\u122e", // ብርሮ
  "birr",
  "bir",
  "birri",
  "etb"
];

/**
 * Currencies the ledger cannot accept. Detecting these is what stops a
 * "ዶላር 500" utterance from being read as a 500 birr contribution.
 */
const FOREIGN_CURRENCY_FORMS: readonly string[] = [
  "\u12f6\u120b\u122d", // ዶላር
  "\u12a2\u12ee\u122d", // ኢዮር
  "\u1333\u12cd\u1295", // ጳውንድ
  "\u12a0\u121e\u122d", // አሞር
  "\u1230\u12a2\u12f0\u1275", // ሰኢደት
  "dollar",
  "dollars",
  "usd",
  "euro",
  "eur",
  "pound",
  "gbp"
];

/** Words that mean "I paid / I deposited". */
const PAYMENT_VERB_FORMS: readonly string[] = [
  "\u12a0\u1235\u1308\u1265\u127b\u1208\u1201", // አስገብቻለሁ
  "\u12a0\u1235\u1308\u1263\u1208\u1201", // አስገባለሁ
  "\u12a0\u1235\u1308\u127b\u1208\u1201", // አስገባሁ
  "\u12a0\u1235\u1308\u127b\u121d", // አስገባን
  "\u12a0\u1235\u1308\u1263\u1208\u1201\u120f", // አስገባለን
  "\u1308\u12ad", // ገቢ
  "\u1308\u12d2", // ገቢ
  "\u1305\u1230", // ገብ
  "\u1308\u12ad\u129b", // ገባኛ
  "dabbadee",
  "dabbadhe",
  "hinkaafne",
  "hinkaawe",
  "gabsi",
  "gabsii",
  "gabsee",
  "gabsade",
  "dabade",
  "dabalee"
];

/** Words that name an Equb saving cycle, or a monetary total. */
const MONEY_NOUN_FORMS: readonly string[] = [
  "\u12a5\u1241\u1265", // እቁብ
  "\u1308\u1295\u12d8\u1265", // ግንዘብ
  "\u1308\u1295\u12d8", // ግንዘ
  "\u1295\u12f6", // ንጉ
  "\u12ad\u134d\u12eb", // ክፍያ
  "\u12a0\u1235\u1308\u1265", // አስገብ
  "equb",
  "equb",
  "ididir",
  "iddir",
  "hinqaa",
  "hinqaawe",
  "jeemoo",
  "kinqumma"
];

/** Words that label a transaction reference. */
const TX_REF_TRIGGER_FORMS: readonly string[] = [
  "\u1261\u1325\u122d", // ቁጥር
  "\u1261\u1325\u1229", // ቁጥሩ
  "\u12a0\u12ed\u12f5", // አይድ
  "\u12a0\u12ed\u12f6", // አይዶ
  "\u1275\u12d5\u122d\u1295\u1235", // ትዕርንስ
  "\u1218\u1208\u12eb", // መለያ
  "\u1270\u1246\u1323\u1325", // ተከታታይ
  "\u121b\u1315", // ርፍ
  "\u1325\u1241\u122d", // ጥቁር
  "kutaa",
  "kuta",
  "hutum",
  "ayid",
  "ayido",
  "tikrns",
  "tikrinsi",
  "mellaya",
  "reference",
  "ref",
  "refno",
  "no",
  "num",
  "numb",
  "serial"
];

const PROVIDER_LOOKUP: ReadonlyMap<string, BankProvider> = (() => {
  const lookup = new Map<string, BankProvider>();
  for (const provider of SUPPORTED_PROVIDERS) {
    for (const form of PROVIDER_FORMS[provider]) {
      lookup.set(form, provider);
    }
  }
  return lookup;
})();

function toSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

const CASH_SET = toSet(CASH_FORMS);
const GENERIC_BANK_SET = toSet(GENERIC_BANK_FORMS);
const ETB_SET = toSet(ETB_FORMS);
const FOREIGN_CURRENCY_SET = toSet(FOREIGN_CURRENCY_FORMS);
const PAYMENT_VERB_SET = toSet(PAYMENT_VERB_FORMS);
const MONEY_NOUN_SET = toSet(MONEY_NOUN_FORMS);
const TX_REF_TRIGGER_SET = toSet(TX_REF_TRIGGER_FORMS);

export function providerFromToken(token: string): BankProvider | null {
  return PROVIDER_LOOKUP.get(token) ?? null;
}

export function isCashToken(token: string): boolean {
  return CASH_SET.has(token);
}

export function isGenericBankToken(token: string): boolean {
  return GENERIC_BANK_SET.has(token);
}

export function isEtbToken(token: string): boolean {
  return ETB_SET.has(token);
}

export function isForeignCurrencyToken(token: string): boolean {
  return FOREIGN_CURRENCY_SET.has(token);
}

export function isPaymentVerbToken(token: string): boolean {
  return PAYMENT_VERB_SET.has(token);
}

export function isMoneyNounToken(token: string): boolean {
  return MONEY_NOUN_SET.has(token);
}

export function isTxRefTriggerToken(token: string): boolean {
  return TX_REF_TRIGGER_SET.has(token);
}

/** "Generic bank but no provider" — the ambiguous-channel case. */
export function isGenericChannelToken(token: string): boolean {
  return isGenericBankToken(token) || isPaymentVerbToken(token);
}

export { VOICE_PAYMENT_RAILS };
export type { VoicePaymentRail };
