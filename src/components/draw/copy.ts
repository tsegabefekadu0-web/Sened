import { translate, type Locale, type MessageKey, type TranslationVariables } from "@/lib/i18n";

/**
 * AGENT-3's ceremonial copy, sourced from the shared dictionary.
 *
 * This table used to be the lane's own `en`/`am` pair, mirroring the
 * `draw.*` triples filed in `docs/requests/agent-3.md` R-3, for the same reason
 * A4 had one: `src/lib/i18n.ts` belongs to A2 alone. Those keys are in the
 * dictionary now, so the strings are read from there instead of being kept a
 * second time.
 *
 * The `DrawCopy` shape is unchanged so `DrawBoard`, `MesobCeremony`,
 * `VerifyPanel` and `RiskPanel` are untouched. A3's note that this file should
 * be deleted once the keys land is satisfied in substance — the duplication is
 * gone; what remains is the field-name adapter the components import.
 */

export type { Locale };

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
  readonly demoBanner: string;
}

const FIELDS = {
  localeName: "draw.localeName",
  ceremonyTitle: "draw.ceremonyTitle",
  stepCommit: "draw.stepCommit",
  stepCommitIdle: "draw.stepCommitIdle",
  stepCommitDone: "draw.stepCommitDone",
  stepReveal: "draw.stepReveal",
  stepRevealIdle: "draw.stepRevealIdle",
  stepRevealDone: "draw.stepRevealDone",
  stepVerify: "draw.stepVerify",
  stepVerifyDetail: "draw.stepVerifyDetail",
  actionCommit: "draw.actionCommit",
  actionReveal: "draw.actionReveal",
  actionNextRound: "draw.actionNextRound",
  tamperToggle: "draw.tamperToggle",
  rotationTitle: "draw.rotationTitle",
  rotationDetail: "draw.rotationDetail",
  alreadyWon: "draw.alreadyWon",
  eligible: "draw.eligible",
  commitmentTitle: "draw.commitmentTitle",
  commitmentIdle: "draw.commitmentIdle",
  participants: "draw.participants",
  currency: "draw.currency",
  localNote: "draw.localNote",
  demoBanner: "draw.demoBanner"
} as const satisfies Record<Exclude<keyof DrawCopy, "roundLabel">, string>;

export function t(locale: Locale): DrawCopy {
  const read = (key: string): string => translate(locale, key as never);

  return {
    localeName: read(FIELDS.localeName),
    roundLabel: (round: number, total: number): string =>
      translate(locale, "draw.roundLabel" as never, { round, total }),
    ceremonyTitle: read(FIELDS.ceremonyTitle),
    stepCommit: read(FIELDS.stepCommit),
    stepCommitIdle: read(FIELDS.stepCommitIdle),
    stepCommitDone: read(FIELDS.stepCommitDone),
    stepReveal: read(FIELDS.stepReveal),
    stepRevealIdle: read(FIELDS.stepRevealIdle),
    stepRevealDone: read(FIELDS.stepRevealDone),
    stepVerify: read(FIELDS.stepVerify),
    stepVerifyDetail: read(FIELDS.stepVerifyDetail),
    actionCommit: read(FIELDS.actionCommit),
    actionReveal: read(FIELDS.actionReveal),
    actionNextRound: read(FIELDS.actionNextRound),
    tamperToggle: read(FIELDS.tamperToggle),
    rotationTitle: read(FIELDS.rotationTitle),
    rotationDetail: read(FIELDS.rotationDetail),
    alreadyWon: read(FIELDS.alreadyWon),
    eligible: read(FIELDS.eligible),
    commitmentTitle: read(FIELDS.commitmentTitle),
    commitmentIdle: read(FIELDS.commitmentIdle),
    participants: read(FIELDS.participants),
    currency: read(FIELDS.currency),
    localNote: read(FIELDS.localNote),
    demoBanner: read(FIELDS.demoBanner)
  };
}

/** Keys of the signed-in ceremony (`drawLive.*`), kept apart from the demo's `draw.*`. */
export type DrawLiveKey = Extract<MessageKey, `drawLive.${string}`>;

/** Translator for the signed-in ceremony, through the same adapter as the demo. */
export function liveCopy(locale: Locale): (key: DrawLiveKey, variables?: TranslationVariables) => string {
  return (key, variables) => translate(locale, key, variables);
}
