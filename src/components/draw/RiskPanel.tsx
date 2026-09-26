"use client";

import React from "react";

import type { DrawRiskAssessment } from "@/lib/draw/types";
import { formatEtbDisplay } from "@/lib/ledger/money";

import "./draw.css";

export interface RiskPanelProps {
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
export function RiskPanel({ risk, currencyLabel }: RiskPanelProps) {
  return (
    <section
      className="sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card"
      aria-label="የክምት አደጋ ምዘና (Default risk assessment)"
      data-draw-panel="risk"
    >
      <h3 className="font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]">
        የክምት አደጋ ምዘና
      </h3>

      <dl className="mt-3 space-y-2.5">
        <Row
          label="የመሶብ ጠቅላላ"
          value={`${formatEtbDisplay(risk.potAmount)} ${currencyLabel}`}
          muted
        />
        <Row
          label="የሚከፈለው"
          value={`${formatEtbDisplay(risk.payoutAmount)} ${currencyLabel}`}
          emphasis
        />
        <Row
          label="የተጠበቀ ማስጠንቀቂያ"
          value={`${formatEtbDisplay(risk.reserveAmount)} ${currencyLabel}`}
        />
      </dl>

      <div
        className={[
          "mt-3 rounded-xl border px-3 py-2.5",
          risk.reserveAdequate
            ? "border-[#A7F3D0] bg-[#ECFDF5]"
            : "border-[#E5B450] bg-[#FBF3E2]"
        ].join(" ")}
      >
        <p className="text-[12px] font-bold text-[#1C1410]">
          {risk.reserveAdequate
            ? "ማስጠንቀቂያው አንድ አባላት የሚልበውን ገንዘብ ያሽላል"
            : "ማስጠንቀቂያው አይበቃም — ዙሩ በአባላት ውስጥ ይገመገማል"}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-[#065F46]">
          አንድ አባላት ካልተከፈለ የሚያዘግየውን ለይቶ በ{" "}
          {risk.reserveCoversDefaults >= Number.MAX_SAFE_INTEGER ? "∞" : risk.reserveCoversDefaults} ይችላል።
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {risk.notes.map((note, index) => (
          <li key={index} className="text-[11px] leading-4 text-[#6F625D]">
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
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-[#E4D9CE] pb-2 last:border-0">
      <dt className="font-ethiopic text-[13px] text-[#6F625D]">{label}</dt>
      <dd
        className={[
          "font-sans text-[14px] tabular-nums",
          emphasis ? "font-bold text-[#C6532B]" : "font-semibold",
          muted ? "text-[#6F625D]" : "text-[#1C1410]"
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
