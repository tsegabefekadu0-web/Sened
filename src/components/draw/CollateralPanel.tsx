"use client";

import React, { useState } from "react";

import {
  planNextReserve,
  summarizeCollateral,
  type CollateralWinner,
  type CycleCollateral,
  type Guarantee,
  type OwedRound
} from "@/lib/draw/collateral";
import type { GuaranteeCommand } from "@/lib/draw/clientDraw";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { formatEtbDisplay, formatEtbMinorUnits } from "@/lib/ledger/money";

import "./draw.css";

export type CollateralState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly view: CycleCollateral };

export type CollateralOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly key: MessageKey; readonly detail: string | null };

export interface CollateralPanelProps {
  readonly locale: Locale;
  readonly state: CollateralState;
  readonly currencyLabel: string;
  /** The signed-in member. Only they can confirm or decline a guarantee naming them. */
  readonly myUserId: string | null;
  /** Owner or treasurer: may propose, replace and release. */
  readonly isTreasurer: boolean;
  /** Active members, for the guarantor choices. */
  readonly members: readonly { readonly userId: string }[];
  readonly labelFor: (memberId: string) => string;
  /** Runs a guarantee command and resolves to its outcome (the caller reloads the view). */
  readonly onCommand: (command: GuaranteeCommand) => Promise<CollateralOutcome>;
}

type Form =
  | { readonly kind: "propose"; readonly winnerId: string }
  | { readonly kind: "decline"; readonly guaranteeId: string }
  | { readonly kind: "release"; readonly guaranteeId: string }
  | { readonly kind: "supersede"; readonly guaranteeId: string; readonly winnerId: string; readonly guarantorId: string };

const CARD = "sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card";
const HEADING = "font-ethiopic text-base font-bold  text-[#1C1410]";
const HINT = "mt-1 text-base leading-relaxed text-[#4F4137]";
const FIELD = "mt-1 w-full rounded-xl border border-[#DCCFC7] bg-white px-3 py-2 font-sans text-base text-[#1C1410]";
const LABEL = "block text-base font-semibold text-[#4F4137]";
const SECONDARY =
  "min-h-12 rounded-xl border border-[#453630] px-3 font-sans text-base font-semibold text-[#1C1410] disabled:opacity-50";
const PRIMARY =
  "min-h-12 rounded-xl bg-[#C6532B] px-3 font-sans text-base font-bold text-[#FAF6F0] disabled:opacity-50";
const OPEN_STATES: readonly Guarantee["state"][] = ["proposed", "accepted"];

/**
 * M4.2 — who vouches for each winner, and which of their later rounds the ledger
 * can show as contributed.
 *
 * ADVISORY ONLY, and the panel says so first. It never moves money, debits a
 * guarantor or writes the ledger: a guarantee is a recorded promise made with the
 * guarantor's own consent (the confirm and decline controls render only for the
 * guarantor, and the database refuses anyone else), and a "flagged" round is what
 * the ledger cannot show, not a finding that someone did not pay. Every figure is
 * derived on read by the database; nothing here is a stored status.
 */
export function CollateralPanel({
  locale,
  state,
  currencyLabel,
  myUserId,
  isTreasurer,
  members,
  labelFor,
  onCommand
}: CollateralPanelProps) {
  const tr = (key: MessageKey, variables?: Record<string, string | number>): string => translate(locale, key, variables);
  const [form, setForm] = useState<Form | null>(null);
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string; readonly detail?: string | null } | null>(null);

  const closeForm = () => {
    setForm(null);
    setChoice("");
    setReason("");
  };

  const run = async (command: GuaranteeCommand) => {
    setBusy(true);
    setMessage(null);
    const outcome = await onCommand(command);
    setBusy(false);
    if (outcome.ok) {
      setMessage({ ok: true, text: tr("collateral.done") });
      closeForm();
    } else {
      setMessage({ ok: false, text: tr(outcome.key), detail: outcome.detail });
    }
  };

  const guard = (needsReason: boolean, needsMember: boolean): boolean => {
    if (needsMember && choice === "") {
      setMessage({ ok: false, text: tr("collateral.pickMember") });
      return false;
    }
    if (needsReason && reason.trim().length < 10) {
      setMessage({ ok: false, text: tr("collateral.reasonTooShort") });
      return false;
    }
    return true;
  };

  const who = (memberId: string): string => `${labelFor(memberId)}${memberId === myUserId ? ` ${tr("collateral.you")}` : ""}`;

  const header = (
    <>
      <h3 className={HEADING}>{tr("collateral.title")}</h3>
      <p data-testid="collateral-advisory" className="mt-1 text-base font-semibold leading-relaxed text-[#6B4E16]">
        {tr("collateral.advisory")}
      </p>
    </>
  );

  if (state.kind !== "ready") {
    return (
      <section className={CARD} aria-label={tr("collateral.aria")} data-draw-panel="collateral" data-testid="collateral-panel">
        {header}
        <p data-testid="collateral-status" className={HINT}>
          {tr(state.kind === "loading" ? "collateral.loading" : "collateral.unavailable")}
        </p>
      </section>
    );
  }

  const view = state.view;
  const summary = summarizeCollateral(view);
  const next = planNextReserve(view);
  const winnerExposure = new Map(summary.winners.map((entry) => [entry.memberId, entry]));

  const roundLabel = (entry: OwedRound): string => {
    const base = `${tr("collateral.round", { round: entry.round })}: ${tr(`collateral.status.${entry.status}` as MessageKey)}`;
    return entry.status === "met" && entry.source ? `${base} (${tr(`collateral.source.${entry.source}` as MessageKey)})` : base;
  };

  const statusTone = (status: OwedRound["status"]): string =>
    status === "met"
      ? "border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]"
      : status === "flagged"
        ? "border-[#E5B450] bg-[#FBF3E2] text-[#6B4E16]"
        : "border-[#DCCFC7] bg-[#F5EFEB] text-[#4F4137]";

  const candidatesFor = (winner: CollateralWinner, excludeGuarantor?: string): readonly string[] => {
    const open = new Set(
      winner.guarantees.filter((entry) => OPEN_STATES.includes(entry.state)).map((entry) => entry.guarantorMemberId)
    );
    return members
      .map((member) => member.userId)
      .filter((id) => id !== winner.memberId && id !== excludeGuarantor && !open.has(id));
  };

  const guaranteeRow = (winner: CollateralWinner, guarantee: Guarantee) => {
    const open = OPEN_STATES.includes(guarantee.state);
    const isGuarantor = myUserId !== null && guarantee.guarantorMemberId === myUserId;
    const canRelease = open && (isGuarantor || isTreasurer);
    const editing = form !== null && "guaranteeId" in form && form.guaranteeId === guarantee.guaranteeId ? form : null;
    return (
      <li
        key={guarantee.guaranteeId}
        data-testid="guarantee-row"
        data-guarantee-state={guarantee.state}
        className={`rounded-lg px-2.5 py-2 text-base ${open ? "bg-[#F5EFEB]" : "bg-[#F5EFEB] opacity-70"}`}
      >
        <p className="font-semibold text-[#1C1410]">
          {tr("collateral.guarantorRow", { member: who(guarantee.guarantorMemberId), winner: labelFor(winner.memberId) })}
        </p>
        <p data-testid="guarantee-state" className="text-base text-[#4F4137]">
          {tr(`collateral.state.${guarantee.state}` as MessageKey)}
        </p>
        {guarantee.reason && !open ? (
          <p className="text-base text-[#4F4137]">{tr("collateral.state.reason", { reason: guarantee.reason })}</p>
        ) : null}

        {/* Only the guarantor is offered the confirm/decline controls: it is their promise. */}
        {guarantee.state === "proposed" && isGuarantor ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" data-testid="guarantee-accept" className={PRIMARY} disabled={busy} onClick={() => void run({ action: "accept", guaranteeId: guarantee.guaranteeId })}>
              {tr("collateral.accept")}
            </button>
            <button
              type="button"
              data-testid="guarantee-decline"
              className={SECONDARY}
              disabled={busy}
              onClick={() => {
                setMessage(null);
                setForm({ kind: "decline", guaranteeId: guarantee.guaranteeId });
              }}
            >
              {tr("collateral.decline")}
            </button>
          </div>
        ) : null}
        {open && (canRelease || isTreasurer) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {canRelease ? (
              <button
                type="button"
                data-testid="guarantee-release"
                className={SECONDARY}
                disabled={busy}
                onClick={() => {
                  setMessage(null);
                  setForm({ kind: "release", guaranteeId: guarantee.guaranteeId });
                }}
              >
                {tr("collateral.release")}
              </button>
            ) : null}
            {isTreasurer ? (
              <button
                type="button"
                data-testid="guarantee-supersede"
                className={SECONDARY}
                disabled={busy}
                onClick={() => {
                  setMessage(null);
                  setChoice("");
                  setForm({
                    kind: "supersede",
                    guaranteeId: guarantee.guaranteeId,
                    winnerId: winner.memberId,
                    guarantorId: guarantee.guarantorMemberId
                  });
                }}
              >
                {tr("collateral.supersede")}
              </button>
            ) : null}
          </div>
        ) : null}

        {editing?.kind === "decline" ? (
          <div className="mt-2" data-testid="guarantee-decline-form">
            <label className="block">
              <span className={LABEL}>{tr("collateral.declineReason")}</span>
              <input className={FIELD} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={() =>
                  void run({
                    action: "decline",
                    guaranteeId: guarantee.guaranteeId,
                    ...(reason.trim() === "" ? {} : { reason: reason.trim() })
                  })
                }
              >
                {tr("collateral.decline")}
              </button>
              <button type="button" className={SECONDARY} onClick={closeForm}>
                {tr("collateral.cancel")}
              </button>
            </div>
          </div>
        ) : null}
        {editing?.kind === "release" ? (
          <div className="mt-2" data-testid="guarantee-release-form">
            <label className="block">
              <span className={LABEL}>{tr("collateral.releaseReason")}</span>
              <input className={FIELD} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                data-testid="guarantee-release-confirm"
                className={PRIMARY}
                disabled={busy}
                onClick={() => {
                  if (guard(true, false)) void run({ action: "release", guaranteeId: guarantee.guaranteeId, reason: reason.trim() });
                }}
              >
                {tr("collateral.releaseConfirm")}
              </button>
              <button type="button" className={SECONDARY} onClick={closeForm}>
                {tr("collateral.cancel")}
              </button>
            </div>
          </div>
        ) : null}
        {editing?.kind === "supersede" ? (
          <div className="mt-2" data-testid="guarantee-supersede-form">
            <label className="block">
              <span className={LABEL}>{tr("collateral.supersedeMember")}</span>
              <select className={FIELD} value={choice} onChange={(event) => setChoice(event.target.value)} data-testid="guarantee-supersede-member">
                <option value="">{tr("collateral.proposeChoose")}</option>
                {candidatesFor(winner, guarantee.guarantorMemberId).map((id) => (
                  <option key={id} value={id}>
                    {labelFor(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 block">
              <span className={LABEL}>{tr("collateral.supersedeReason")}</span>
              <input className={FIELD} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                data-testid="guarantee-supersede-confirm"
                className={PRIMARY}
                disabled={busy}
                onClick={() => {
                  if (guard(true, true)) {
                    void run({
                      action: "supersede",
                      guaranteeId: guarantee.guaranteeId,
                      newGuarantorMemberId: choice,
                      reason: reason.trim()
                    });
                  }
                }}
              >
                {tr("collateral.supersedeConfirm")}
              </button>
              <button type="button" className={SECONDARY} onClick={closeForm}>
                {tr("collateral.cancel")}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className={CARD} aria-label={tr("collateral.aria")} data-draw-panel="collateral" data-testid="collateral-panel">
      {header}

      {view.winners.length === 0 ? (
        <p data-testid="collateral-empty" className={HINT}>
          {tr("collateral.empty")}
        </p>
      ) : (
        <>
          {view.contributionAmount === null ? (
            <p className={HINT}>{tr("collateral.noContribution")}</p>
          ) : (
            <dl className="mt-3 space-y-1.5" data-testid="collateral-figures">
              <Figure label={tr("collateral.reserveRetained")} value={`${formatEtbDisplay(summary.reserveRetained)} ${currencyLabel}`} testId="collateral-retained" />
              <Figure label={tr("collateral.outstanding")} value={`${formatEtbDisplay(summary.totalOutstanding ?? "0.00")} ${currencyLabel}`} testId="collateral-outstanding" />
              <Figure label={tr("collateral.overdue")} value={`${formatEtbDisplay(summary.totalOverdue ?? "0.00")} ${currencyLabel}`} testId="collateral-overdue" />
              {next ? (
                <Figure
                  label={tr("collateral.nextReserve")}
                  value={`${formatEtbDisplay(formatEtbMinorUnits(next.reserveMinor))} ${currencyLabel}`}
                  testId="collateral-next-reserve"
                />
              ) : null}
            </dl>
          )}
          {summary.reserveCoversOverdue !== null && summary.flaggedCount > 0 ? (
            <p data-testid="collateral-covers" className={`mt-2 text-base font-semibold ${summary.reserveCoversOverdue ? "text-[#065F46]" : "text-[#863214]"}`}>
              {tr(summary.reserveCoversOverdue ? "collateral.reserveCovers" : "collateral.reserveShort")}
            </p>
          ) : null}
          {summary.flaggedCount > 0 ? (
            <p data-testid="collateral-flag-explain" className={HINT}>
              {tr("collateral.flaggedExplain")}
            </p>
          ) : null}
          <p className={HINT}>{tr("collateral.consentNote")}</p>

          <ul className="mt-3 space-y-3">
            {view.winners.map((winner) => {
              const exposure = winnerExposure.get(winner.memberId);
              const proposing = form?.kind === "propose" && form.winnerId === winner.memberId;
              const candidates = candidatesFor(winner);
              return (
                <li key={winner.memberId} data-testid="collateral-winner" data-winner-id={winner.memberId} className="rounded-xl border border-[#E4D9CE] p-3">
                  <p className="text-base font-bold text-[#1C1410]">
                    {tr("collateral.winnerTitle", { member: who(winner.memberId), round: winner.round })}
                  </p>
                  {winner.owed.length === 0 ? (
                    <p className={HINT}>{tr("collateral.winnerNoRounds")}</p>
                  ) : (
                    <>
                      <p data-testid="collateral-remaining" className={HINT}>
                        {tr("collateral.winnerRemaining", {
                          owed: exposure?.roundsOwed ?? winner.owed.length,
                          met: exposure?.roundsMet ?? 0,
                          flagged: exposure?.roundsFlagged ?? 0,
                          notDue: exposure?.roundsNotDue ?? 0
                        })}
                      </p>
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {winner.owed.map((entry) => (
                          <li
                            key={entry.round}
                            data-testid="collateral-round"
                            data-round-status={entry.status}
                            className={`rounded-full border px-2 py-0.5 text-base font-semibold ${statusTone(entry.status)}`}
                          >
                            {roundLabel(entry)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <p className="mt-3 text-base font-bold   text-[#4F4137]">{tr("collateral.guarantors")}</p>
                  {winner.guarantees.length === 0 ? (
                    <p data-testid="collateral-no-guarantor" className={HINT}>
                      {tr("collateral.noGuarantor")}
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-1.5">{winner.guarantees.map((guarantee) => guaranteeRow(winner, guarantee))}</ul>
                  )}

                  {isTreasurer && winner.owed.length > 0 ? (
                    proposing ? (
                      <div className="mt-2" data-testid="guarantee-propose-form">
                        <label className="block">
                          <span className={LABEL}>{tr("collateral.proposeMember")}</span>
                          <select className={FIELD} value={choice} onChange={(event) => setChoice(event.target.value)} data-testid="guarantee-propose-member">
                            <option value="">{tr("collateral.proposeChoose")}</option>
                            {candidates.map((id) => (
                              <option key={id} value={id}>
                                {labelFor(id)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className={HINT}>{tr("collateral.proposeNote")}</p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            data-testid="guarantee-propose-confirm"
                            className={PRIMARY}
                            disabled={busy}
                            onClick={() => {
                              if (guard(false, true)) {
                                void run({
                                  action: "propose",
                                  cycleId: view.cycleId,
                                  winnerMemberId: winner.memberId,
                                  guarantorMemberId: choice
                                });
                              }
                            }}
                          >
                            {tr("collateral.proposeConfirm")}
                          </button>
                          <button type="button" className={SECONDARY} onClick={closeForm}>
                            {tr("collateral.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid="guarantee-propose"
                        className={`${SECONDARY} mt-2`}
                        disabled={busy || candidates.length === 0}
                        onClick={() => {
                          setMessage(null);
                          setChoice("");
                          setReason("");
                          setForm({ kind: "propose", winnerId: winner.memberId });
                        }}
                      >
                        {tr("collateral.propose")}
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {busy ? (
        <p role="status" className={HINT}>
          {tr("collateral.working")}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          data-testid="collateral-message"
          className={`mt-2 text-base font-semibold ${message.ok ? "text-[#065F46]" : "text-[#863214]"}`}
        >
          {message.text}
          {message.detail ? <span className="mt-1 block font-mono text-base font-normal">{message.detail}</span> : null}
        </p>
      ) : null}
    </section>
  );
}

function Figure({ label, value, testId }: { readonly label: string; readonly value: string; readonly testId: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-[#E4D9CE] pb-1.5 last:border-0">
      <dt className="font-ethiopic text-base text-[#4F4137]">{label}</dt>
      <dd data-testid={testId} className="font-sans text-base font-semibold tabular-nums text-[#1C1410]">
        {value}
      </dd>
    </div>
  );
}
