import {
  ETHIOPIAN_MONTH_IDS,
  ETHIOPIAN_MONTH_LABELS,
  ETHIOPIAN_MONTH_NUMBERS,
  type EthiopianMonthId
} from "./types";

/**
 * Ethiopian calendar month names in Amharic, Afaan Oromoo (Gecal) and the
 * romanized forms a recognizer emits when it half-switches languages.
 *
 * The Oromo names are the **Gecal** names — the calendar Ethiopia actually
 * administers — not the Maddale Walaam (GREG) names used in Oromia for
 * January–December. A treasurer in Dire Dawa saying "sente" means month 10.
 *
 * Ge'ez forms are `\uXXXX` escapes so the lexica cannot be silently corrupted
 * by an editor that does not round-trip the script; `test/voice.months.test.ts`
 * asserts the rendered forms.
 */
const MONTH_FORMS: Readonly<Record<EthiopianMonthId, readonly string[]>> = {
  meskerem: [
    "\u1218\u1235\u12a8\u1228\u121d", // መስከረም
    "\u1218\u1235\u12a8\u1228\u121b", // መስከረም
    "meskerem",
    "meskerem1",
    "gec'boorree",
    "gecboorree",
    "gec boorree"
  ],
  tikimt: [
    "\u1325\u1245\u121d\u1275", // ጥቅምት
    "\u1325\u1245\u121b", // ጥቅምብ
    "tikimt",
    "tikimt1",
    "gumaagesa",
    "gumageesa",
    "gumaagesha"
  ],
  hidar: [
    "\u1285\u12f3\u122d", // ኅዳር
    "\u128d\u12f3\u122d", // ኍዳር
    "hidar",
    "sadaaro",
    "sadarr",
    "sadara"
  ],
  tahsas: [
    "\u1273\u1285\u1223\u1225", // ታኅሣሥ
    "\u1273\u1205\u1223\u1225", // ታህሣሥ
    "\u1273\u122d\u1233", // ታርስ
    "tahsas",
    "abbaati",
    "abbati",
    "abaati"
  ],
  tir: [
    "\u1325\u122d", // ጥር
    "\u1325\u1229", // ጥሩ
    "tir",
    "gammadaa",
    "gammada"
  ],
  yekatit: [
    "\u12e8\u12ab\u1272\u1275", // የካቲት
    "\u12e8\u12ab\u1272\u121b", // የካቲብ
    "\u12e8\u12ab\u1272", // የካቲ
    "yekatit",
    "biraatanii",
    "birraatani",
    "biratanii"
  ],
  megabit: [
    "\u1218\u130b\u1262\u1275", // መጋቢት
    "\u1218\u130a\u1262\u1275", // መጋቤት
    "megabit",
    "megabitt",
    "yakaalitii",
    "yokaallitii",
    "yakaaliti"
  ],
  miyazya: [
    "\u121a\u12eb\u12dd\u12eb", // ሚያዝያ
    "\u1219\u12eb\u12dd\u12eb", // ሙያዝያ
    "miyazya",
    "miyaziya",
    "miyaazya",
    "waaqiinee",
    "waacciinee",
    "waaqeenee"
  ],
  ginbot: [
    "\u130d\u1295\u1266\u1275", // ግንቦት
    "\u130d\u1295\u1266\u121b", // ግንቦብ
    "ginbot",
    "ginnbot",
    "akeekkoo",
    "akiikko",
    "akeekko"
  ],
  sene: [
    "\u1208\u12ab\u1232\u121d", // ለካሲም
    "\u1230\u1294", // ሰኔ
    "\u1208\u1232\u121d", // ለሲን
    "sene",
    "sanyaa",
    "sanya",
    "senaa",
    "sennee"
  ],
  hamle: [
    "\u1210\u121d\u120c", // ሐምሌ
    "\u1200\u121d\u120c", // ሀምሌ
    "\u1203\u121d\u120c", // ሃምሌ
    "hamle",
    "hamaa",
    "hama"
  ],
  nehase: [
    "\u1290\u1210\u1234", // ነሐሴ
    "\u1290\u1200\u1234", // ነሃሴ
    "\u1290\u1203\u1234", // ነሃሴ
    "\u1290\u1210\u1233", // ነሐሳ
    "nehase",
    "nehase1",
    "gedaa",
    "geda"
  ],
  pagumen: [
    "\u1333\u1309\u121c\u1295", // ጳጉሜን
    "\u1333\u1309\u1218\u1295", // ጳጉመን
    "pagumen",
    "pagumme",
    "wikiyaa",
    "wikiaa",
    "wikia"
  ]
};

/** word → month id, precomputed once. */
const MONTH_LOOKUP: ReadonlyMap<string, EthiopianMonthId> = (() => {
  const lookup = new Map<string, EthiopianMonthId>();
  for (const month of ETHIOPIAN_MONTH_IDS) {
    for (const form of MONTH_FORMS[month]) {
      lookup.set(form, month);
    }
  }
  return lookup;
})();

export function monthFromToken(token: string): EthiopianMonthId | null {
  return MONTH_LOOKUP.get(token) ?? null;
}

export function monthLabel(month: EthiopianMonthId | null): string | null {
  return month === null ? null : ETHIOPIAN_MONTH_LABELS[month];
}

export function monthNumber(month: EthiopianMonthId | null): number | null {
  return month === null ? null : ETHIOPIAN_MONTH_NUMBERS[month];
}

/** Every accepted surface form, for tests and for the `/voice` debug table. */
export function monthFormsFor(month: EthiopianMonthId): readonly string[] {
  return MONTH_FORMS[month];
}

export { ETHIOPIAN_MONTH_IDS, ETHIOPIAN_MONTH_LABELS, ETHIOPIAN_MONTH_NUMBERS };
export type { EthiopianMonthId };
