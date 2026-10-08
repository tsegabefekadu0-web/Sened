"use client";

import React, { useState } from "react";

import { tallyMember, type ContributionCell, type ContributionMember, type CycleContributions } from "@/lib/draw/contributions";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { DRAW_CONTRIBUTION_GATES, type DrawContributionGate } from "@/lib/draw/types";

import "./draw.css";

export type ContributionsState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly view: CycleContributions };

export type GateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly key: MessageKey; readonly detail: string | null };

export interface ContributionGridProps {
  readonly locale: Locale;
  readonly state: ContributionsState;
  /** The signed-in member, to mark their own row. */
  readonly myUserId: string | null;
  /** Owner or treasurer: may change the contribution gate. */
  readonly isTreasurer: boolean;
  readonly labelFor: (memberId: string) => string;
  /** Changes the gate and resolves to the outcome (the caller reloads the grid). */
  readonly onSetGate: (gate: DrawContributionGate, reason: string) => Promise<GateOutcome>;
}

const CARD = "sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card";
const HEADING = "font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]";
const HINT = "mt-1 text-[11px] leading-4 text-[#6F625D]";
const FIELD = "mt-1 w-full rounded-xl border border-[#DCCFC7] bg-white px-3 py-2 font-sans text-[13px] text-[#1C1410]";
const LABEL = "block text-[11px] font-semibold text-[#6F625D]";
const PRIMARY =
  "min-h-9 rounded-xl bg-[#C6532B] px-3 font-sans text-[12px] font-bold text-[#FAF6F0] disabled:opacity-50";

/** Text AND a glyph carry the status, never colour alone. */
const CELL_STYLE: Record<ContributionCell["status"], { readonly glyph: string; readonly className: string }> = {
  met: { glyph: "✓", className: "bg-[#ECFDF5] text-[#065F46]" },
  flagged: { glyph: "!", className: "bg-[#FBF3E2] font-semibold text-[#863214]" },
  not_due: { glyph: "–", className: "bg-[#F5EFEB] text-[#6F625D]" }
};

/**
 * Every member by every round of the cycle: `met`, `flagged` or `not_due`, derived by the
 * database on each read (`get_draw_cycle_contributions_v1`); nothing here is a stored status.
 * The table scrolls sideways INSIDE its own region (the page does not), the member column stays
 * in view, and each cell says its status in words. Below it: the cycle's contribution gate and,
 * for an owner or treasurer, the way to change it (with a recorded reason).
 */
export function ContributionGrid({ locale, state, myUserId, isTreasurer, labelFor, onSetGate }: ContributionGridProps) {
  const tr = (key: MessageKey, variables?: Record<string, string | number>): string => translate(locale, key, variables);
  const [nextGate, setNextGate] = useState<DrawContributionGate | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string; readonly detail?: string | null } | null>(null);

  const policyName = (gate: DrawContributionGate): string => tr(`contributions.gate.policy.${gate}` as MessageKey);

  const header = <h3 className={HEADING}>{tr("contributions.title")}</h3>;

  if (state.kind !== "ready") {
    return (
      <section className={CARD} aria-label={tr("contributions.aria")} data-draw-panel="contributions" data-testid="contribution-grid">
        {header}
        <p data-testid="contribution-grid-status" className={HINT}>
          {tr(state.kind === "loading" ? "contributions.loading" : "contributions.unavailable")}
        </p>
      </section>
    );
  }

  const view = state.view;
  const members = [...view.members].sort((left, right) => {
    const a = labelFor(left.memberId);
    const b = labelFor(right.memberId);
    return a === b ? (left.memberId < right.memberId ? -1 : 1) : a.localeCompare(b);
  });
  const selectable = DRAW_CONTRIBUTION_GATES.filter((gate) => gate !== view.contributionGate);
  const chosen: DrawContributionGate = nextGate === "" ? (selectable[0] as DrawContributionGate) : nextGate;

  const submitGate = async () => {
    if (reason.trim().length < 10) {
      setMessage({ ok: false, text: tr("contributions.gate.reasonShort") });
      return;
    }
    setBusy(true);
    setMessage(null);
    const outcome = await onSetGate(chosen, reason.trim());
    setBusy(false);
    if (outcome.ok) {
      setMessage({ ok: true, text: tr("contributions.gate.saved") });
      setReason("");
      setNextGate("");
    } else {
      setMessage({ ok: false, text: tr(outcome.key), detail: outcome.detail });
    }
  };

  const memberName = (member: ContributionMember): string =>
    `${labelFor(member.memberId)}${member.memberId === myUserId ? ` ${tr("contributions.you")}` : ""}`;
  const who = (memberId: string): string => `${labelFor(memberId)}${memberId === myUserId ? ` ${tr("contributions.you")}` : ""}`;
  const day = (iso: string): string => iso.slice(0, 10);

  return (
    <section className={CARD} aria-label={tr("contributions.aria")} data-draw-panel="contributions" data-testid="contribution-grid">
      {header}
      <p data-testid="contribution-grid-explain" className={HINT}>
        {tr("contributions.explain")}
      </p>

      {members.length === 0 ? (
        <p className={HINT}>{tr("contributions.empty")}</p>
      ) : (
        <>
          <p className={HINT}>{tr("contributions.scrollHint")}</p>
          {/*
            The page never scrolls sideways: only this region does. It is `relative` on purpose: the
            screen-reader-only text inside the table is absolutely positioned, and without a positioned
            ancestor it escapes this region's clipping and widens the whole page.
          */}
          <div
            role="region"
            tabIndex={0}
            aria-label={tr("contributions.tableCaption")}
            data-testid="contribution-grid-scroll"
            className="relative mt-2 max-w-full overflow-x-auto rounded-xl border border-[#DCCFC7]"
          >
            <table className="w-max min-w-full border-collapse text-[11px]">
              <caption className="sr-only">{tr("contributions.tableCaption")}</caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 min-w-[7.5rem] max-w-[9rem] border-b border-[#DCCFC7] bg-[#F5EFEB] px-2 py-1.5 text-left font-semibold text-[#453630]"
                  >
                    {tr("contributions.memberHeader")}
                  </th>
                  {view.rounds.map((round) => (
                    <th
                      key={round.round}
                      scope="col"
                      title={tr("contributions.roundHeader", { round: round.round })}
                      className="min-w-[4.75rem] border-b border-l border-[#DCCFC7] bg-[#F5EFEB] px-2 py-1.5 text-center font-semibold text-[#453630]"
                    >
                      <span aria-hidden="true">{tr("contributions.roundShort", { round: round.round })}</span>
                      <span className="sr-only">{tr("contributions.roundHeader", { round: round.round })}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const tally = tallyMember(member);
                  return (
                    <tr key={member.memberId} data-testid={`grid-row-${member.memberId}`}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 min-w-[7.5rem] max-w-[9rem] border-t border-[#DCCFC7] bg-white px-2 py-1.5 text-left align-top font-normal"
                      >
                        <span className="block truncate font-semibold text-[#1C1410]" title={memberName(member)}>
                          {memberName(member)}
                        </span>
                        {member.winRound !== null ? (
                          <span className="block text-[10px] text-[#6F625D]">{tr("contributions.won", { round: member.winRound })}</span>
                        ) : null}
                        {!member.active ? <span className="block text-[10px] text-[#6F625D]">{tr("contributions.inactive")}</span> : null}
                        <span className="block text-[10px] text-[#6F625D]">
                          {tr("contributions.tally", { met: tally.met, flagged: tally.flagged })}
                        </span>
                      </th>
                      {member.cells.map((cell) => {
                        const style = CELL_STYLE[cell.status];
                        const status = tr(`contributions.status.${cell.status}` as MessageKey);
                        const source = cell.source === null ? null : tr(`contributions.sourceShort.${cell.source}` as MessageKey);
                        return (
                          <td
                            key={cell.round}
                            data-testid={`grid-cell-${member.memberId}-${cell.round}`}
                            data-status={cell.status}
                            data-source={cell.source ?? undefined}
                            className={`border-l border-t border-[#DCCFC7] px-1.5 py-1.5 text-center align-top ${style.className}`}
                          >
                            <span aria-hidden="true" className="mr-0.5">
                              {style.glyph}
                            </span>
                            <span>{status}</span>
                            {source !== null ? <span className="block text-[10px] opacity-80">{source}</span> : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {view.flaggedCount > 0 ? (
            <p data-testid="contribution-grid-flagged" className="mt-2 text-[12px] font-semibold text-[#863214]">
              {tr("contributions.flaggedSummary", { count: view.flaggedCount })}
            </p>
          ) : null}
          <ul className="mt-2 space-y-0.5 text-[11px] leading-4 text-[#6F625D]" data-testid="contribution-grid-legend">
            <li>{tr("contributions.legendMet")}</li>
            <li>{tr("contributions.legendFlagged")}</li>
            <li>{tr("contributions.legendNotDue")}</li>
            <li>{tr("contributions.sourceNote")}</li>
            <li>{tr("contributions.noPartial")}</li>
            <li>{tr("contributions.assignNote")}</li>
          </ul>
        </>
      )}

      <div className="mt-3 border-t border-[#DCCFC7] pt-3" data-testid="gate-policy">
        <h4 className="text-[12px] font-bold text-[#1C1410]">{tr("contributions.gate.title")}</h4>
        <p data-testid="gate-policy-current" className="mt-1 text-[12px] font-semibold text-[#1C1410]">
          {tr("contributions.gate.current", { policy: policyName(view.contributionGate) })}
        </p>
        <p className={HINT}>{tr(`contributions.gate.explain.${view.contributionGate}` as MessageKey)}</p>

        <details className="mt-2" data-testid="gate-history">
          <summary className="cursor-pointer text-[12px] font-semibold text-[#1C1410]">{tr("contributions.gate.history")}</summary>
          {view.gateEvents.length === 0 && view.overrides.length === 0 ? (
            <p className={HINT}>{tr("contributions.gate.historyEmpty")}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[11px] leading-4 text-[#453630]">
              {view.gateEvents.map((event) => (
                <li key={`${event.at}-${event.to}`} data-testid="gate-event">
                  {tr("contributions.gate.eventRow", {
                    date: day(event.at),
                    actor: who(event.actorId),
                    from: policyName(event.from),
                    to: policyName(event.to),
                    reason: event.reason
                  })}
                </li>
              ))}
              {view.overrides.map((override) => (
                <li key={`${override.drawId}-${override.stage}`} data-testid="gate-override" data-stage={override.stage}>
                  {tr(override.stage === "commit" ? "contributions.gate.commitOverrideRow" : "contributions.gate.overrideRow", {
                    date: day(override.at),
                    actor: who(override.actorId),
                    round: override.round,
                    count: override.flagged.length,
                    who: [...new Set(override.flagged.map((flag) => labelFor(flag.memberId)))].join(", "),
                    reason: override.reason
                  })}
                </li>
              ))}
            </ul>
          )}
        </details>

        {isTreasurer ? (
          <details className="mt-2 rounded-xl border border-[#DCCFC7] bg-[#FAF7F2] px-3 py-2" data-testid="gate-change">
            <summary className="cursor-pointer text-[12px] font-semibold text-[#1C1410]">{tr("contributions.gate.change")}</summary>
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className={LABEL}>{tr("contributions.gate.changeTo")}</span>
                <select
                  className={FIELD}
                  data-testid="gate-change-select"
                  value={chosen}
                  onChange={(event) => setNextGate(event.target.value as DrawContributionGate)}
                >
                  {selectable.map((gate) => (
                    <option key={gate} value={gate}>
                      {policyName(gate)}
                    </option>
                  ))}
                </select>
              </label>
              <p className={HINT}>{tr(`contributions.gate.explain.${chosen}` as MessageKey)}</p>
              <label className="block">
                <span className={LABEL}>{tr("contributions.gate.reason")}</span>
                <textarea
                  className={FIELD}
                  data-testid="gate-change-reason"
                  rows={2}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button type="button" data-testid="gate-change-save" className={PRIMARY} disabled={busy} onClick={() => void submitGate()}>
                {busy ? tr("contributions.working") : tr("contributions.gate.save")}
              </button>
            </div>
          </details>
        ) : null}
        {message !== null ? (
          <p
            role={message.ok ? "status" : "alert"}
            data-testid="gate-change-message"
            className={`mt-2 text-[12px] font-semibold ${message.ok ? "text-[#065F46]" : "text-[#863214]"}`}
          >
            {message.text}
            {message.detail ? <span className="block text-[11px] font-normal text-[#6F625D]">{message.detail}</span> : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
