"use client";

import React from "react";

import type { DrawRiskAssessment, DrawRiskNote } from "@/lib/draw/types";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { formatEtbDisplay } from "@/lib/ledger/money";


export interface RiskPanelProps {
  /** Amharic unless told otherwise, as the panel has always been. */
  readonly locale?: Locale;
  readonly risk: DrawRiskAssessment;
  readonly currencyLabel: string;
}

/**
 * M4.2 — why the payout is not the whole pot.
 *
 * The classic ROSCA collapse is not a rigged draw; it is a member who takes the
 * pot and then stops, leaving the remaining rounds unfunded. This panel exists
 * so the treasurer can see that reasoning instead of trusting a number. Every
 * figure here is recomputable by hand from the published round values.
 */
export function RiskPanel({ locale = "am", risk, currencyLabel }: RiskPanelProps) {
  const tr = (key: MessageKey, variables?: Record<string, string | number>): string => translate(locale, key, variables);
  const noteText = (note: DrawRiskNote): string => {
    switch (note.code) {
      case "base_reserve":
        return tr("drawRisk.note.base_reserve", { amount: formatEtbDisplay(note.amount), bps: note.bps, currency: currencyLabel });
      case "member_exposure":
        return tr("drawRisk.note.member_exposure", { amount: formatEtbDisplay(note.amount), currency: currencyLabel });
      case "final_round":
        return tr("drawRisk.note.final_round");
      case "capped":
        return tr("drawRisk.note.capped", { needed: formatEtbDisplay(note.needed), bps: note.ceilingBps, currency: currencyLabel });
      case "coverage":
        return tr("drawRisk.note.coverage", { percent: note.percent, owed: formatEtbDisplay(note.owed), currency: currencyLabel });
      case "cannot_absorb":
        return tr("drawRisk.note.cannot_absorb");
      case "exposure_uncovered":
        return tr("drawRisk.note.exposure_uncovered", { exposure: formatEtbDisplay(note.exposure), reserve: formatEtbDisplay(note.reserve), currency: currencyLabel });
    }
  };
  return (
    <section
      className="sened-draw-shell rounded-[22px] border border-hair p-4 "
      aria-label={tr("drawRisk.aria")}
      data-draw-panel="risk"
    >
      <h3 className="font-ethiopic text-base font-bold  text-ink">
        {tr("drawRisk.title")}
      </h3>

      <dl className="mt-3 space-y-2.5">
        <Row
          label={tr("drawRisk.pot")}
          value={`${formatEtbDisplay(risk.potAmount)} ${currencyLabel}`}
          muted
        />
        <Row
          label={tr("drawRisk.payout")}
          value={`${formatEtbDisplay(risk.payoutAmount)} ${currencyLabel}`}
          emphasis
        />
        <Row
          label={tr("drawRisk.reserve")}
          value={`${formatEtbDisplay(risk.reserveAmount)} ${currencyLabel}`}
        />
      </dl>

      <div
        className={[
          "mt-3 rounded-xl border px-3 py-2.5",
          risk.reserveAdequate
            ? "border-shop bg-[var(--tint)]"
            : "border-[var(--chipcol)] bg-[var(--chipcol-bg)]"
        ].join(" ")}
      >
        <p className="text-base font-bold text-ink">
          {risk.reserveAdequate ? tr("drawRisk.adequate") : tr("drawRisk.inadequate")}
        </p>
        <p className="mt-1 text-base leading-relaxed text-shop">
          {tr("drawRisk.covers", {
            count: risk.reserveCoversDefaults >= Number.MAX_SAFE_INTEGER ? "∞" : risk.reserveCoversDefaults
          })}
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {/* Said in the member's language when the assessment carries structured
            notes; the engine's English strings are the fallback. */}
        {(risk.noteItems && risk.noteItems.length > 0
          ? risk.noteItems.map(noteText)
          : risk.notes
        ).map((note, index) => (
          <li key={index} className="text-base leading-relaxed text-soft">
            • {note}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({
  label,
  value,
  emphasis,
  muted
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
  readonly muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-hair pb-2 last:border-0">
      <dt className="font-ethiopic text-base text-soft">{label}</dt>
      <dd
        className={[
          "font-body text-base tabular-nums",
          emphasis ? "font-bold text-dng" : "font-semibold",
          muted ? "text-soft" : "text-ink"
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
