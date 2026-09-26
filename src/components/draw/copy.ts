export type Locale = "am" | "en";

/**
 * AGENT-3 lane-local copy.
 *
 * `src/lib/i18n.ts` is single-writer and belongs to AGENT-2 (AGENTWORK.md §4.1),
 * so this lane cannot add keys to it. I filed the full `draw.*` key triples in
 * `docs/requests/agent-3.md` (R-3) for A2 to fold in.
 *
 * Until then this table is the honest interim: **both** languages are present,
 * which is what §12.6 requires. The Gen A components (`DebterCard`,
 * `ContributionFeed`, `Header`) hard-code Ge'ez literals and never call `t()`,
 * so a locale table inside my own folder is consistent with the surrounding UI
 * rather than a workaround. When A2 lands the `draw.*` keys, delete this file
 * and switch `DrawBoard` to `createTranslator(locale)`.
 */

export interface DrawCopy {
  readonly localeName: string;
  readonly roundLabel: (round: number, total: number) => string;
  readonly ceremonyTitle: string;
  readonly stepCommit: string;
  readonly stepCommitIdle: string;
  readonly stepCommitDone: string;
  readonly stepReveal: string;
  readonly stepRevealIdle: string;
  readonly stepRevealDone: string;
  readonly stepVerify: string;
  readonly stepVerifyDetail: string;
  readonly actionCommit: string;
  readonly actionReveal: string;
  readonly actionNextRound: string;
  readonly tamperToggle: string;
  readonly rotationTitle: string;
  readonly rotationDetail: string;
  readonly alreadyWon: string;
  readonly eligible: string;
  readonly commitmentTitle: string;
  readonly commitmentIdle: string;
  readonly participants: string;
  readonly currency: string;
  readonly localNote: string;
}

const am: DrawCopy = {
  localeName: "አማርኛ",
  roundLabel: (round, total) => `ዙር ${round} / ${total}`,
  ceremonyTitle: "የመሶብ እጣ ሥርዓት",
  stepCommit: "ደረጃ 1 — ቃል መዋጮ",
  stepCommitIdle: "ዘመኑ ከመታወቁ በፊት በአጥር ላይ ይሸጣል።",
  stepCommitDone: "ቃል መዋጮው ተሸጥቷል፤ አባላቱ ተሸጥተዋል።",
  stepReveal: "ደረጃ 2 — መስበር",
  stepRevealIdle: "የመሶቡ ውስጥ እየተጨማረ አሸናፊው ይለያል።",
  stepRevealDone: "ዘመኑ ተገልጧል፤ አሸናፊው ተወስዷል።",
  stepVerify: "ደረጃ 3 — ማረጋገጥ",
  stepVerifyDetail: "እያንዳንዱ አባላት በስልክው ላይ ራሱ ይመልከታል።",
  actionCommit: "ቃል መዋጮ አስገባ",
  actionReveal: "ዘመኑን አሳይ",
  actionNextRound: "ወደ ቀጣይ ዙር ቀጥል",
  tamperToggle:
    "ለማሳያ ብቻ፦ ዘመኑን በአንድ ፊደል ማስተካከል። ማንኛውም አሸናፊ ሲከልን ይህ ራሱ ይሳዳል።",
  rotationTitle: "ዙር መኸረድ",
  rotationDetail: "በዚህ ዙር ያሸነፉ አባላት ከቀጣይ እጣዎች ውስጥ ይገገማሉ።",
  alreadyWon: "አሸናፊ ሆነዋል",
  eligible: "ይገባል",
  commitmentTitle: "የቃል መዋጮ መረጃ",
  commitmentIdle: "እጅግ ቃል መዋጮ አልተሰጠም።",
  participants: "ተሳታፊዎች",
  currency: "ብር",
  localNote:
    "ይህ ማሳያ በስልክህ ላይ ብቻ ይሠራል — SHA-256 በስልክህ WebCrypto እንደሚሰራ ነው። ለማስተካከል አገልግሎቱ ላይ አይተማርንም።"
};

const en: DrawCopy = {
  localeName: "English",
  roundLabel: (round, total) => `Round ${round} / ${total}`,
  ceremonyTitle: "Mesob draw ceremony",
  stepCommit: "Step 1 — Commit",
  stepCommitIdle: "The seed is fixed in wax before the draw begins.",
  stepCommitDone: "The commitment is sealed and the roster is published.",
  stepReveal: "Step 2 — Reveal",
  stepRevealIdle: "The winner is drawn as the mesob is turned.",
  stepRevealDone: "The seed is published and the winner is determined.",
  stepVerify: "Step 3 — Verify",
  stepVerifyDetail: "Any member can recompute this on their own phone.",
  actionCommit: "Seal the commitment",
  actionReveal: "Reveal the seed",
  actionNextRound: "Continue to the next round",
  tamperToggle:
    "Demonstration only: flip one character of the seed. The commitment check will catch it, and that is the entire point.",
  rotationTitle: "Rotation",
  rotationDetail: "Members who have already been drawn this cycle are excluded from the remaining draws.",
  alreadyWon: "Already won",
  eligible: "Eligible",
  commitmentTitle: "Commitment",
  commitmentIdle: "No commitment sealed yet.",
  participants: "Participants",
  currency: "ETB",
  localNote:
    "This demonstration runs entirely on your device using WebCrypto for SHA-256. Verifying the draw does not depend on the server."
};

const TABLES: Record<Locale, DrawCopy> = { am, en };

export function t(locale: Locale): DrawCopy {
  return TABLES[locale];
}
