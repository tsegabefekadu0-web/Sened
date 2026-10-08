"use client";

import React, { useEffect, useMemo, useState } from "react";

import { authedFetch, NotSignedInError } from "@/lib/auth/authedFetch";
import {
  CITATION_CATALOGUE,
  isCitationId,
  type CitationId
} from "@/lib/governance/citations";
import { formatBps, recommendGovernance } from "@/lib/governance/engine";
import {
  GROUP_TYPES,
  TRUST_LEVELS,
  type BylawClause,
  type ClauseParameter,
  type GovernanceInput,
  type GovernanceRecommendation,
  type GroupType,
  type TrustLevel
} from "@/lib/governance/types";
import { formatEtbGrouped, ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";

/**
 * M5.2 — the governance copilot dialog.
 *
 * A step-by-step questionnaire that ends in recommended bylaw clauses with
 * citation chips. The recommendations are computed on the device by the same
 * deterministic engine the API route uses, so the copilot works offline in a
 * Sunday meeting. Nothing is saved and nothing reaches the ledger.
 *
 * Citation chips come from the bundled catalogue. When a signed-in treasurer
 * opens the results and the server has a ScholarXIV key, the chips are also
 * marked "found / not found" — and when it does not, the page says plainly
 * that the list is the bundled one.
 */

export type CitationConfirmationState =
  | { readonly kind: "bundled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "scholarxiv"; readonly found: ReadonlySet<CitationId>; readonly total: number };

export interface GovernanceCopilotProps {
  readonly locale: Locale;
  /** Injectable for tests. Defaults to `GET /api/governance/citations`. */
  readonly loadConfirmations?: () => Promise<CitationConfirmationState>;
}

type StepId = "groupType" | "memberCount" | "contribution" | "cycleLength" | "trust" | "typicalClaim" | "fundBalance";

const EQUB_STEPS: readonly StepId[] = ["groupType", "memberCount", "contribution", "cycleLength", "trust"];
const IDDIR_STEPS: readonly StepId[] = [...EQUB_STEPS, "typicalClaim", "fundBalance"];

interface Answers {
  groupType: GroupType | null;
  memberCount: string;
  contribution: string;
  cycleLength: string;
  trust: TrustLevel | null;
  typicalClaim: string;
  fundBalance: string;
}

const EMPTY: Answers = {
  groupType: null,
  memberCount: "",
  contribution: "",
  cycleLength: "",
  trust: null,
  typicalClaim: "",
  fundBalance: ""
};

/** `1000` or `1000.5` to the canonical `1000.50`, or `null`. */
function normalizeAmount(raw: string, allowZero: boolean): string | null {
  const value = raw.trim();
  if (!ETB_DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const canonical = `${whole}.${(fraction + "00").slice(0, 2)}`;
  if (!allowZero && canonical === "0.00") {
    return null;
  }
  return canonical;
}

function wholeNumber(raw: string, min: number, max: number): number | null {
  const value = raw.trim();
  if (!/^\d{1,4}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

function stepError(step: StepId, answers: Answers): MessageKey | null {
  switch (step) {
    case "groupType":
      return answers.groupType === null ? "governance.q.groupType" : null;
    case "memberCount":
      return wholeNumber(answers.memberCount, 2, 500) === null ? "governance.error.memberCount" : null;
    case "contribution":
      return normalizeAmount(answers.contribution, false) === null ? "governance.error.amount" : null;
    case "cycleLength":
      return wholeNumber(answers.cycleLength, 1, 366) === null ? "governance.error.cycleLength" : null;
    case "trust":
      return answers.trust === null ? "governance.q.trust" : null;
    case "typicalClaim":
      return normalizeAmount(answers.typicalClaim, false) === null ? "governance.error.amount" : null;
    case "fundBalance":
      return normalizeAmount(answers.fundBalance, true) === null ? "governance.error.balance" : null;
  }
}

function toInput(answers: Answers): GovernanceInput | null {
  if (answers.groupType === null || answers.trust === null) {
    return null;
  }
  const memberCount = wholeNumber(answers.memberCount, 2, 500);
  const cycleLengthDays = wholeNumber(answers.cycleLength, 1, 366);
  const contributionAmount = normalizeAmount(answers.contribution, false);
  if (memberCount === null || cycleLengthDays === null || contributionAmount === null) {
    return null;
  }
  const base = { groupType: answers.groupType, memberCount, contributionAmount, cycleLengthDays, trust: answers.trust };
  if (answers.groupType === "equb") {
    return base;
  }
  const typicalClaimAmount = normalizeAmount(answers.typicalClaim, false);
  const currentFundBalance = normalizeAmount(answers.fundBalance, true);
  if (typicalClaimAmount === null || currentFundBalance === null) {
    return null;
  }
  return { ...base, typicalClaimAmount, currentFundBalance };
}

/** Default: ask the server, and degrade honestly. Never reports a guess as a confirmation. */
export async function fetchCitationConfirmations(): Promise<CitationConfirmationState> {
  try {
    const response = await authedFetch("/api/governance/citations", { method: "GET" });
    if (!response.ok) {
      return { kind: "unavailable" };
    }
    const body = (await response.json()) as {
      source?: unknown;
      confirmations?: unknown;
    };
    if (body.source !== "scholarxiv" || !Array.isArray(body.confirmations)) {
      return { kind: "bundled" };
    }
    const found = new Set<CitationId>();
    for (const entry of body.confirmations as { id?: unknown; status?: unknown }[]) {
      if (entry && isCitationId(entry.id) && entry.status === "confirmed") {
        found.add(entry.id);
      }
    }
    return { kind: "scholarxiv", found, total: body.confirmations.length };
  } catch (error) {
    return error instanceof NotSignedInError ? { kind: "bundled" } : { kind: "unavailable" };
  }
}

export function GovernanceCopilot({ locale, loadConfirmations = fetchCitationConfirmations }: GovernanceCopilotProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [stepIndex, setStepIndex] = useState(0);
  const [showError, setShowError] = useState(false);
  const [done, setDone] = useState(false);
  const [confirmation, setConfirmation] = useState<CitationConfirmationState | null>(null);

  const steps = answers.groupType === "iddir" ? IDDIR_STEPS : EQUB_STEPS;
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const isLast = stepIndex >= steps.length - 1;

  const recommendation: GovernanceRecommendation | null = useMemo(() => {
    if (!done) {
      return null;
    }
    const input = toInput(answers);
    if (input === null) {
      return null;
    }
    try {
      return recommendGovernance(input);
    } catch {
      return null;
    }
  }, [done, answers]);

  useEffect(() => {
    if (recommendation === null) {
      return;
    }
    let active = true;
    setConfirmation(null);
    loadConfirmations()
      .then((state) => active && setConfirmation(state))
      .catch(() => active && setConfirmation({ kind: "unavailable" }));
    return () => {
      active = false;
    };
    // The check runs once per set of results, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendation]);

  const update = <K extends keyof Answers>(key: K, value: Answers[K]) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    setShowError(false);
  };

  const advance = () => {
    if (stepError(step, answers) !== null) {
      setShowError(true);
      return;
    }
    setShowError(false);
    if (isLast) {
      setDone(true);
    } else {
      setStepIndex((index) => index + 1);
    }
  };

  const restart = () => {
    setAnswers(EMPTY);
    setStepIndex(0);
    setDone(false);
    setShowError(false);
    setConfirmation(null);
  };

  const goBack = () => {
    setShowError(false);
    setStepIndex((index) => Math.max(0, index - 1));
  };

  if (done) {
    return (
      <div className="flex-1 overflow-y-auto" data-governance-panel="results">
        {recommendation === null ? (
          <div className="p-4">
            <p role="alert" className="rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-2.5 text-base text-[#1C1410]">
              {t("governance.error.engine")}
            </p>
            <button type="button" onClick={restart} className={secondaryButton}>
              {t("governance.startOver")}
            </button>
          </div>
        ) : (
          <Results
            recommendation={recommendation}
            locale={locale}
            confirmation={confirmation}
            onRestart={restart}
          />
        )}
      </div>
    );
  }

  const error = showError ? stepError(step, answers) : null;
  return (
    <div className="flex-1 overflow-y-auto" data-governance-panel="dialog">
      <div className="mx-auto w-full max-w-xl px-4 py-5">
        <p className="rounded-xl border border-[#DCCFC7] bg-[#F5EFEB] px-3 py-2 text-base leading-relaxed text-[#4F4137]">
          {t("governance.advisory")}
        </p>

        <div className="mt-5 flex items-center justify-between">
          <p className="text-base font-semibold   text-[#6B4E0E]" data-testid="governance-progress">
            {t("governance.step.progress", { current: stepIndex + 1, total: steps.length })}
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((id, index) => (
              <span
                key={id}
                className={`h-1.5 w-5 rounded-full ${index <= stepIndex ? "bg-[#C6532B]" : "bg-[#DCCFC7]"}`}
              />
            ))}
          </div>
        </div>

        <form
          className="mt-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            advance();
          }}
        >
          <StepBody step={step} answers={answers} update={update} t={t} error={error} />

          <div className="mt-6 flex gap-3">
            {stepIndex > 0 ? (
              <button type="button" onClick={goBack} className={secondaryButton}>
                {t("governance.back")}
              </button>
            ) : null}
            <button type="submit" className={primaryButton}>
              {isLast ? t("governance.seeResults") : t("governance.next")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const primaryButton =
  "min-h-12 flex-1 rounded-xl bg-[#C6532B] px-4 font-sans text-base font-bold text-[#FAF6F0] transition-colors hover:bg-[#A9411D] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4A244]";
const secondaryButton =
  "min-h-12 rounded-xl border border-[#DCCFC7] bg-[#FAF6F0] px-4 font-sans text-base font-semibold text-[#3A2C22] transition-colors hover:border-[#C9B49C] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]";
const inputClass =
  "mt-3 block min-h-12 w-full rounded-xl border border-[#DCCFC7] bg-white px-3 font-sans text-[16px] text-[#1C1410] focus:border-[#C6532B] focus:outline-none focus:ring-2 focus:ring-[#C6532B]/30";

function StepBody({
  step,
  answers,
  update,
  t,
  error
}: {
  readonly step: StepId;
  readonly answers: Answers;
  readonly update: <K extends keyof Answers>(key: K, value: Answers[K]) => void;
  readonly t: ReturnType<typeof createTranslator>;
  readonly error: MessageKey | null;
}) {
  const errorId = "governance-step-error";
  const message = error === null ? null : t(error);
  const errorNode =
    message === null ? null : (
      <p id={errorId} role="alert" className="mt-2 text-base font-semibold text-[#A9411D]">
        {message}
      </p>
    );

  const numeric = (
    key: "memberCount" | "contribution" | "cycleLength" | "typicalClaim" | "fundBalance",
    question: MessageKey,
    hint: MessageKey,
    mode: "numeric" | "decimal",
    unit: MessageKey | null
  ) => (
    <div>
      <label htmlFor={`governance-${key}`} className="block font-ethiopic text-[18px] font-bold leading-relaxed text-[#1C1410]">
        {t(question)}
      </label>
      <p id={`governance-${key}-hint`} className="mt-1 text-base text-[#4F4137]">
        {t(hint)}
      </p>
      <div className="relative">
        <input
          id={`governance-${key}`}
          type="text"
          inputMode={mode}
          autoComplete="off"
          value={answers[key]}
          onChange={(event) => update(key, event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={`governance-${key}-hint${error !== null ? ` ${errorId}` : ""}`}
          className={inputClass}
        />
        {unit !== null ? (
          <span className="pointer-events-none absolute right-3 top-1/2 mt-1.5 -translate-y-1/2 text-base font-semibold text-[#4F4137]">
            {t(unit)}
          </span>
        ) : null}
      </div>
      {errorNode}
    </div>
  );

  switch (step) {
    case "groupType":
      return (
        <Choice
          legend={t("governance.q.groupType")}
          hint={t("governance.q.groupType.hint")}
          options={GROUP_TYPES.map((value) => ({
            value,
            label: t(value === "equb" ? "governance.option.equb" : "governance.option.iddir")
          }))}
          selected={answers.groupType}
          onSelect={(value) => update("groupType", value)}
          error={errorNode}
        />
      );
    case "trust":
      return (
        <Choice
          legend={t("governance.q.trust")}
          hint={t("governance.q.trust.hint")}
          options={TRUST_LEVELS.map((value) => ({
            value,
            label: t(`governance.trust.${value}` as MessageKey),
            description: t(`governance.trust.${value}.desc` as MessageKey)
          }))}
          selected={answers.trust}
          onSelect={(value) => update("trust", value)}
          error={errorNode}
        />
      );
    case "memberCount":
      return numeric("memberCount", "governance.q.memberCount", "governance.q.memberCount.hint", "numeric", null);
    case "contribution":
      return numeric("contribution", "governance.q.contribution", "governance.q.contribution.hint", "decimal", "governance.unit.etb");
    case "cycleLength":
      return numeric("cycleLength", "governance.q.cycleLength", "governance.q.cycleLength.hint", "numeric", "governance.unit.days");
    case "typicalClaim":
      return numeric("typicalClaim", "governance.q.typicalClaim", "governance.q.typicalClaim.hint", "decimal", "governance.unit.etb");
    case "fundBalance":
      return numeric("fundBalance", "governance.q.fundBalance", "governance.q.fundBalance.hint", "decimal", "governance.unit.etb");
  }
}

function Choice<V extends string>({
  legend,
  hint,
  options,
  selected,
  onSelect,
  error
}: {
  readonly legend: string;
  readonly hint: string;
  readonly options: readonly { readonly value: V; readonly label: string; readonly description?: string }[];
  readonly selected: V | null;
  readonly onSelect: (value: V) => void;
  readonly error: React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="font-ethiopic text-[18px] font-bold leading-relaxed text-[#1C1410]">{legend}</legend>
      <p className="mt-1 text-base text-[#4F4137]">{hint}</p>
      <div role="radiogroup" aria-label={legend} className="mt-3 grid gap-2.5">
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSelect(option.value)}
              className={`min-h-12 rounded-xl border px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B] ${
                active
                  ? "border-[#C6532B] bg-[#C6532B]/10"
                  : "border-[#DCCFC7] bg-[#FAF6F0] hover:border-[#C9B49C]"
              }`}
            >
              <span className="block font-ethiopic text-base font-bold text-[#1C1410]">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-base text-[#4F4137]">{option.description}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {error}
    </fieldset>
  );
}

function formatParameter(parameter: ClauseParameter, t: ReturnType<typeof createTranslator>): string {
  switch (parameter.unit) {
    case "bps":
      return `${formatBps(Number(parameter.value))}%`;
    case "etb":
      return `${formatEtbGrouped(String(parameter.value))} ${t("governance.unit.etb")}`;
    case "days":
      return `${parameter.value} ${t("governance.unit.days")}`;
    case "rounds":
      return parameter.value === 0 ? "0" : `${parameter.value} ${t("governance.unit.rounds")}`;
    case "cycles":
      return `${parameter.value} ${t("governance.unit.cycles")}`;
    case "count":
      return String(parameter.value);
  }
}

function Results({
  recommendation,
  locale,
  confirmation,
  onRestart
}: {
  readonly recommendation: GovernanceRecommendation;
  readonly locale: Locale;
  readonly confirmation: CitationConfirmationState | null;
  readonly onRestart: () => void;
}) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { input } = recommendation;
  const summary = t(input.groupType === "equb" ? "governance.results.summaryEqub" : "governance.results.summaryIddir", {
    members: input.memberCount,
    amount: formatEtbGrouped(input.contributionAmount),
    days: input.cycleLengthDays
  });

  const statusFor = (id: CitationId): "confirmed" | "notFound" | null =>
    confirmation?.kind === "scholarxiv" ? (confirmation.found.has(id) ? "confirmed" : "notFound") : null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5">
      <h2 className="font-ethiopic text-[20px] font-bold text-[#1C1410]">{t("governance.results.title")}</h2>
      <p className="mt-1 text-base font-semibold text-[#4F4137]" data-testid="governance-summary">
        {summary}
      </p>
      <p className="mt-3 rounded-xl border border-[#DCCFC7] bg-[#F5EFEB] px-3 py-2 text-base leading-relaxed text-[#4F4137]">
        {t("governance.advisory")}
      </p>

      {recommendation.warnings.length > 0 ? (
        <section aria-label={t("governance.results.warnings")} className="mt-4 rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-2.5">
          <h3 className="text-base font-bold   text-[#6B4E0E]">
            {t("governance.results.warnings")}
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-base text-[#1C1410]">
            {recommendation.warnings.map((warning) => (
              <li key={warning.code}>{t(warning.messageKey, warning.vars)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-4 space-y-4">
        {recommendation.clauses.map((clause) => (
          <ClauseCard key={clause.id} clause={clause} t={t} statusFor={statusFor} />
        ))}
      </div>

      <section aria-label={t("governance.results.sources")} className="mt-6">
        <h3 className="text-base font-bold   text-[#6B4E0E]">
          {t("governance.results.sources")}
        </h3>
        <ul className="mt-2 space-y-2">
          {recommendation.citations.map((id) => (
            <li key={id} className="rounded-xl border border-[#DCCFC7] bg-white px-3 py-2">
              <p className="text-base font-bold text-[#1C1410]">
                {CITATION_CATALOGUE[id].authors} ({CITATION_CATALOGUE[id].year})
              </p>
              <p className="text-base italic text-[#3A2C22]">{CITATION_CATALOGUE[id].title}</p>
              <p className="text-base text-[#4F4137]">{CITATION_CATALOGUE[id].venue}</p>
              <p className="mt-1 text-base text-[#4F4137]">{t(`governance.cite.${id}.finding` as MessageKey)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-base text-[#4F4137]" data-testid="governance-source-status" role="status">
          {confirmation === null
            ? t("governance.source.checking")
            : confirmation.kind === "scholarxiv"
              ? t("governance.source.scholarxiv", {
                  confirmed: confirmation.found.size,
                  total: confirmation.total
                })
              : confirmation.kind === "unavailable"
                ? t("governance.source.unavailable")
                : t("governance.source.bundled")}
        </p>
      </section>

      <p className="mt-4 text-base leading-relaxed text-[#4F4137]">{t("governance.results.disclaimer")}</p>

      <button type="button" onClick={onRestart} className={`${secondaryButton} mt-5 w-full`}>
        {t("governance.startOver")}
      </button>
    </div>
  );
}

function ClauseCard({
  clause,
  t,
  statusFor
}: {
  readonly clause: BylawClause;
  readonly t: ReturnType<typeof createTranslator>;
  readonly statusFor: (id: CitationId) => "confirmed" | "notFound" | null;
}) {
  return (
    <article
      className="rounded-[22px] border border-[#DCCFC7] bg-[#FAF6F0] p-4 shadow-card"
      data-clause={clause.id}
      aria-labelledby={`clause-${clause.id}`}
    >
      <p className="text-base font-semibold   text-[#6B4E0E]">
        {t(`governance.topic.${clause.topic}` as MessageKey)}
      </p>
      <h3 id={`clause-${clause.id}`} className="mt-0.5 font-ethiopic text-[16px] font-bold text-[#1C1410]">
        {t(clause.titleKey)}
      </h3>
      <p className="mt-2 text-base leading-relaxed text-[#2C241E]">{t(clause.summaryKey, clause.vars)}</p>

      <dl className="mt-3 divide-y divide-[#EBE2D8] rounded-xl border border-[#EBE2D8] bg-white px-3">
        {clause.parameters.map((parameter) => (
          <div key={parameter.key} className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-base text-[#4F4137]">{t(`governance.param.${parameter.key}` as MessageKey)}</dt>
            <dd className="text-right text-base font-bold tabular-nums text-[#1C1410]">
              {formatParameter(parameter, t)}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-base leading-relaxed text-[#4F4137]">
        <span className="font-bold text-[#3A2C22]">{t("governance.results.rationale")}: </span>
        {t(clause.rationaleKey, clause.vars)}
      </p>

      <ul className="mt-3 flex flex-wrap gap-2" aria-label={t("governance.results.sources")}>
        {clause.citations.map((id) => (
          <li key={id}>
            <CitationChip id={id} t={t} status={statusFor(id)} />
          </li>
        ))}
      </ul>
    </article>
  );
}

function CitationChip({
  id,
  t,
  status
}: {
  readonly id: CitationId;
  readonly t: ReturnType<typeof createTranslator>;
  readonly status: "confirmed" | "notFound" | null;
}) {
  const citation = CITATION_CATALOGUE[id];
  const statusLabel =
    status === "confirmed"
      ? t("governance.cite.confirmed")
      : status === "notFound"
        ? t("governance.cite.notFound")
        : null;
  const className =
    "inline-flex min-h-12 items-center gap-1.5 rounded-full border border-[#D4A244]/60 bg-[#FBF3E2] px-3 text-base font-semibold text-[#6B4F14]";
  const body = (
    <>
      <span>{citation.label}</span>
      {status === "confirmed" ? <span aria-hidden="true">{"✓"}</span> : null}
      {status === "notFound" ? <span aria-hidden="true">?</span> : null}
    </>
  );
  const srStatus = statusLabel ? <span className="sr-only">{`, ${statusLabel}`}</span> : null;

  if (citation.url === null || citation.arxivId === null) {
    return (
      <span className={className} title={t("governance.cite.journal")} data-citation={id}>
        {body}
        <span className="sr-only">{`, ${t("governance.cite.journal")}`}</span>
        {srStatus}
      </span>
    );
  }
  return (
    <a
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      title={t("governance.cite.openArxiv", { id: citation.arxivId })}
      data-citation={id}
      className={`${className} hover:bg-[#F3E3BC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]`}
    >
      {body}
      <span className="sr-only">{`, ${t("governance.cite.openArxiv", { id: citation.arxivId })}`}</span>
      {srStatus}
    </a>
  );
}
