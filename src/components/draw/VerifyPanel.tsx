"use client";

import React from "react";

import type { DrawVerificationTranscript } from "@/lib/draw/canonical";
import type { DrawVerificationResult } from "@/lib/draw/types";

import "./draw.css";

export interface VerifyPanelProps {
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
export function VerifyPanel({ transcript, verification, isRunning, error }: VerifyPanelProps) {
  const codes = new Set(verification.codes);
  const tampered = codes.has("commitment_mismatch") || codes.has("roster_mismatch");
  const selectionWrong = codes.has("selection_mismatch");

  return (
    <section
      className="sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card"
      aria-label="የእጣ ማረጋገጫ (Draw verification)"
      data-draw-panel="verify"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]">
          ደረጃ 3 — ነጻ በስልክህ ማረጋገጥ
        </h3>
        <span className="rounded-full bg-[#F5EFEB] px-2 py-1 text-[10px] font-semibold tracking-wide text-[#6F625D]">
          በመሣሪያዎ ብቻ
        </span>
      </header>

      <p className="mt-2 text-[12px] leading-5 text-[#6F625D]">
        ከዚህ በታች ያለውን አሃዞች አንድ ሰው ሌላ ሰው ሲል በእጅጉ ይርምራል። አገልግሎቱ በመኖሩ ላይ አይተካም።
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-[#C6532B] bg-[#FDEDE6] px-3 py-2 text-[12px] font-semibold text-[#863214]"
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
            ? "border-[#DCCFC7] bg-[#F5EFEB]"
            : tampered || selectionWrong
              ? "border-[#C6532B] bg-[#FDEDE6]"
              : verification.verified
                ? "border-[#A7F3D0] bg-[#ECFDF5]"
                : "border-[#E5B450] bg-[#FBF3E2]"
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
            isRunning
              ? "bg-[#D4A244]"
              : tampered || selectionWrong
                ? "bg-[#C6532B]"
                : verification.verified
                  ? "bg-[#16A34A]"
                  : "bg-[#D4A244]"
          ].join(" ")}
        />
        <span className="text-[13px] font-bold tracking-wide">
          {isRunning
            ? "በመሮጥን ላይ…"
            : tampered || selectionWrong
              ? "ማስተካከል ተለይቷል"
              : verification.verified
                ? "ተረጋግጧል"
                : "ገና አልተረጋግጠም"}
        </span>
      </div>

      {verification.errors.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {verification.errors.map((entry, index) => (
            <li key={index} className="text-[12px] leading-5 text-[#863214]">
              • {entry.detail}
            </li>
          ))}
        </ul>
      ) : null}

      {verification.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1.5 rounded-xl bg-[#FBF3E2] px-3 py-2">
          {verification.warnings.map((warning, index) => (
            <li key={index} className="text-[12px] leading-5 text-[#6B4E16]">
              • {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {verification.verified && !isRunning ? (
        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
          <dt className="font-ethiopic text-[#6F625D]">አሸናፊ</dt>
          <dd className="sened-hash font-sans font-semibold">{verification.winnerMemberId}</dd>
          <dt className="font-ethiopic text-[#6F625D]">ትሪት</dt>
          <dd className="sened-hash">{verification.winningTicket}</dd>
          <dt className="font-ethiopic text-[#6F625D]">የግል ድምር</dt>
          <dd className="sened-hash">{verification.transcriptDigest}</dd>
        </dl>
      ) : null}

      <details className="mt-3 rounded-xl border border-[#DCCFC7] bg-[#FAF7F2] px-3 py-2">
        <summary className="cursor-pointer select-text text-[12px] font-semibold text-[#1C1410]">
          የተወጡ ሁሉንም አሃዞች አሳይ (Show every published value)
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
            ["seed", transcript.seed || "(አልተገለጠም — not revealed)"],
            ["nonceDigest", verification.nonceDigest ?? "(n/a)"],
            ["transcriptDigest", verification.transcriptDigest ?? "(አልተሰላም)"]
          ].map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-[11px] font-semibold text-[#6F625D]">{label}</dt>
              <dd className="sened-hash">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="mt-2 text-[11px] leading-4 text-[#6F625D]">
          ትሪቶች — ለእያንዳንዱ አባላት ከስሙ ብቻ የሚለወጥ ናቸው።
        </p>
        <ul className="mt-1 space-y-1">
          {transcript.participants.map((participant) => {
            const isWinner = participant.memberId === verification.winnerMemberId;
            return (
              <li
                key={participant.memberId}
                className={[
                  "rounded-lg px-2 py-1.5",
                  isWinner ? "sened-ticket-glow bg-[#ECFDF5]" : "bg-[#F5EFEB]"
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
          ? "The draw verified on this device."
          : `The draw did not verify. ${verification.errors.map((entry) => entry.detail).join(" ")}`}
      </p>
    </section>
  );
}
