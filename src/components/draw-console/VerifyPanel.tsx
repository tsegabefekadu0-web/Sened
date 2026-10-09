"use client";

import React from "react";

import type { DrawVerificationTranscript } from "@/lib/draw/canonical";
import type { DrawVerificationResult } from "@/lib/draw/types";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";


export interface VerifyPanelProps {
  /** Amharic unless told otherwise, as the panel has always been. */
  readonly locale?: Locale;
  readonly transcript: DrawVerificationTranscript;
  readonly verification: DrawVerificationResult;
  readonly isRunning: boolean;
  readonly error: string | null;
}

/**
 * The verification half of the product, and the part that makes an Equb tick.
 *
 * Everything here runs **on the member's own device** with `crypto.subtle` —
 * the server is not consulted, and nothing on this screen depends on trusting
 * it. The published digests are rendered as selectable monospace text so two
 * members standing together can read them aloud and compare.
 */
export function VerifyPanel({ locale = "am", transcript, verification, isRunning, error }: VerifyPanelProps) {
  const tr = (key: MessageKey, variables?: Record<string, string | number>): string => translate(locale, key, variables);
  const codes = new Set(verification.codes);
  const tampered = codes.has("commitment_mismatch") || codes.has("roster_mismatch");
  const selectionWrong = codes.has("selection_mismatch");

  return (
    <section
      className="sened-draw-shell rounded-[22px] border border-hair p-4 "
      aria-label={tr("drawVerify.aria")}
      data-draw-panel="verify"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="font-ethiopic text-base font-bold  text-ink">
          {tr("drawVerify.title")}
        </h3>
        <span className="rounded-full bg-hair2 px-2 py-1 text-base font-semibold  text-soft">
          {tr("drawVerify.badge")}
        </span>
      </header>

      <p className="mt-2 text-base leading-relaxed text-soft">
        {tr("drawVerify.intro")}
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-dng bg-[color-mix(in_srgb,var(--dng)_14%,transparent)] px-3 py-2 text-base font-semibold text-dng"
        >
          {error}
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        className={[
          "mt-3 flex items-center gap-2 rounded-xl border px-3 py-3",
          isRunning
            ? "border-hair bg-hair2"
            : tampered || selectionWrong
              ? "border-dng bg-[color-mix(in_srgb,var(--dng)_14%,transparent)]"
              : verification.verified
                ? "border-shop bg-[var(--tint)]"
                : "border-[var(--chipcol)] bg-[var(--chipcol-bg)]"
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
            isRunning
              ? "bg-hair2"
              : tampered || selectionWrong
                ? "bg-prim"
                : verification.verified
                  ? "bg-hair2"
                  : "bg-hair2"
          ].join(" ")}
        />
        <span className="text-base font-bold ">
          {isRunning
            ? tr("drawVerify.running")
            : tampered || selectionWrong
              ? tr("drawVerify.tampered")
              : verification.verified
                ? tr("drawVerify.verified")
                : tr("drawVerify.unverified")}
        </span>
      </div>

      {verification.errors.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {verification.errors.map((entry, index) => (
            <li key={index} className="text-base leading-relaxed text-dng">
              • {tr(`drawVerify.err.${entry.code}` as MessageKey)}
              {/* The engine's own wording, kept as technical detail: it names the exact value that failed. */}
              <span lang="en" className="block pl-3 text-base leading-relaxed text-soft">
                {entry.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {verification.warnings.length > 0 || (verification.warningItems?.length ?? 0) > 0 ? (
        <ul className="mt-2 space-y-1.5 rounded-xl bg-[var(--chipcol-bg)] px-3 py-2">
          {/* Structured warnings are said in the member's language; a result that
              carries only the engine's English strings falls back to those. */}
          {verification.warningItems && verification.warningItems.length > 0
            ? verification.warningItems.map((item, index) => (
                <li key={index} className="text-base leading-relaxed text-[var(--chipcol)]">
                  •{" "}
                  {item.code === "abandoned_commitments"
                    ? tr("drawVerify.warn.abandoned_commitments", { count: item.count })
                    : tr(`drawVerify.warn.${item.code}` as MessageKey)}
                </li>
              ))
            : verification.warnings.map((warning, index) => (
                <li key={index} className="text-base leading-relaxed text-[var(--chipcol)]">
                  • {warning}
                </li>
              ))}
        </ul>
      ) : null}

      {verification.verified && !isRunning ? (
        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-base">
          <dt className="font-ethiopic text-soft">{tr("drawVerify.winner")}</dt>
          <dd className="sened-hash font-body font-semibold">{verification.winnerMemberId}</dd>
          <dt className="font-ethiopic text-soft">{tr("drawVerify.ticket")}</dt>
          <dd className="sened-hash">{verification.winningTicket}</dd>
          <dt className="font-ethiopic text-soft">{tr("drawVerify.digest")}</dt>
          <dd className="sened-hash">{verification.transcriptDigest}</dd>
        </dl>
      ) : null}

      <details className="mt-3 rounded-xl border border-hair bg-hair2 px-3 py-2">
        <summary className="cursor-pointer select-text text-base font-semibold text-ink">
          {tr("drawVerify.showAll")}
        </summary>
        <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
          {[
            ["drawId", transcript.drawId],
            ["groupId", transcript.groupId],
            ["cycleId", transcript.cycleId],
            ["round", String(transcript.round)],
            ["commitment", transcript.commitment],
            ["protocolVersion", transcript.protocolVersion ?? "v2"],
            ["rosterDigest", transcript.rosterDigest],
            ["commitmentNonce", transcript.commitmentNonce],
            ["seed", transcript.seed || tr("drawVerify.notRevealed")],
            ["nonceDigest", verification.nonceDigest ?? tr("drawVerify.notApplicable")],
            ["transcriptDigest", verification.transcriptDigest ?? tr("drawVerify.notComputed")]
          ].map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-base font-semibold text-soft">{label}</dt>
              <dd className="sened-hash">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="mt-2 text-base leading-relaxed text-soft">
          {tr("drawVerify.ticketsNote")}
        </p>
        <ul className="mt-1 space-y-1">
          {transcript.participants.map((participant) => {
            const isWinner = participant.memberId === verification.winnerMemberId;
            return (
              <li
                key={participant.memberId}
                className={[
                  "rounded-lg px-2 py-1.5",
                  isWinner ? "sened-ticket-glow bg-[var(--tint)]" : "bg-hair2"
                ].join(" ")}
              >
                <p className="sened-hash font-semibold">{participant.memberId}</p>
                <p className="sened-hash">{participant.ticket}</p>
              </li>
            );
          })}
        </ul>
      </details>

      <p className="sr-only" aria-live="polite">
        {verification.verified
          ? tr("drawVerify.srVerified")
          : `${tr("drawVerify.srFailed")} ${verification.errors.map((entry) => entry.detail).join(" ")}`}
      </p>
    </section>
  );
}
