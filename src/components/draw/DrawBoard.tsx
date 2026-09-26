"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { toVerificationTranscript, webDrawHasher } from "@/lib/draw/canonical";
import { createCommitment, openReveal, verifyRound } from "@/lib/draw/engine";
import { excludePriorWinners } from "@/lib/draw/rotation";
import { formatEtbDisplay } from "@/lib/ledger/money";
import type {
  DrawCommitment,
  DrawMember,
  DrawReveal,
  DrawRiskAssessment,
  DrawRound,
  DrawVerificationResult
} from "@/lib/draw/types";

import { MesobCeremony, type CeremonyPhase } from "./MesobCeremony";
import { RiskPanel } from "./RiskPanel";
import { VerifyPanel } from "./VerifyPanel";
import { t, type Locale } from "./copy";
import "./draw.css";

const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const CYCLE_ID = "77777777-7777-4777-8777-777777777777";
const POT_AMOUNT = "25000.00";
const CONTRIBUTION = "5000.00";
const TOTAL_ROUNDS = 8;
const RESERVE_RATIO_BPS = 1000;

/** Cycle-progress indicators are demo data, exactly like the M1 shell's. */
const ROSTER: readonly DrawMember[] = [
  { memberId: "00014444-4444-8444-844444444444", displayName: "አባላት አለት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00024444-4444-8444-844444444444", displayName: "አባላት ሁለት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00034444-4444-8444-844444444444", displayName: "አባላት ሦስት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00044444-4444-8444-844444444444", displayName: "አባላት አራት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00054444-4444-8444-844444444444", displayName: "አባላት አምስት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00064444-4444-8444-844444444444", displayName: "አባላት ስድስት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00074444-4444-8444-844444444444", displayName: "አባላት ሰባት", status: "active", contributionAmount: CONTRIBUTION },
  { memberId: "00084444-4444-8444-844444444444", displayName: "አባላት ስምንት", status: "active", contributionAmount: CONTRIBUTION }
];

const PENDING_VERIFICATION: DrawVerificationResult = {
  verified: false,
  codes: [],
  warnings: [],
  winnerMemberId: null,
  winningTicket: null,
  selectedIndex: null,
  transcriptDigest: null,
  recomputedCommitment: null,
  errors: []
};

function entropy(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export interface DrawBoardProps {
  readonly locale?: Locale;
  /** Rotated out by A1 during integration to link the real ceremony. */
  readonly defaultLocale?: Locale;
}

export function DrawBoard({ locale = "am" }: DrawBoardProps) {
  const copy = useMemo(() => t(locale), [locale]);
  const reducedMotion = usePrefersReducedMotion();

  const [phase, setPhase] = useState<CeremonyPhase>("idle");
  const [roundNumber, setRoundNumber] = useState(1);
  const [commitment, setCommitment] = useState<DrawCommitment | null>(null);
  /**
   * The treasurer's sealed note. Generated on-device at commit time, never
   * published, and handed over only at the reveal. Modelling it explicitly is
   * what makes the ceremony honest: the draw is fixed by the commitment *before*
   * anyone knows the seed, not by a seed we happen to still be holding.
   */
  const [sealedSeed, setSealedSeed] = useState<string | null>(null);
  const [reveal, setReveal] = useState<DrawReveal | null>(null);
  const [risk, setRisk] = useState<DrawRiskAssessment | null>(null);
  const [verification, setVerification] = useState<DrawVerificationResult>(PENDING_VERIFICATION);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tampersSeed, setTampersSeed] = useState(false);
  const [winners, setWinners] = useState<readonly string[]>([]);

  const eligible = useMemo(() => excludePriorWinners(ROSTER, winners), [winners]);

  const commit = useCallback(async () => {
    setError(null);
    setVerification(PENDING_VERIFICATION);
    const seed = entropy();
    try {
      const created = await createCommitment(
        {
          groupId: GROUP_ID,
          cycleId: CYCLE_ID,
          round: roundNumber,
          totalRounds: TOTAL_ROUNDS,
          drawId: globalThis.crypto.randomUUID(),
          commitmentNonce: entropy(),
          seed,
          potAmount: POT_AMOUNT,
          reserveRatioBps: RESERVE_RATIO_BPS,
          members: [...eligible],
          priorWinnerIds: [...winners],
          committedBy: "local-treasurer",
          committedAt: new Date().toISOString(),
          idempotencyKey: `local-commit-${roundNumber}`
        },
        webDrawHasher
      );
      setCommitment(created);
      setSealedSeed(seed);
      setPhase("sealed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("idle");
    }
  }, [eligible, roundNumber, winners]);

  const doReveal = useCallback(
    async (source: DrawCommitment, seed: string) => {
      setError(null);
      setPhase(reducedMotion ? "revealed" : "revealing");
      try {
        const opened = await openReveal(
          source,
          { seed, revealedBy: "local-treasurer", revealedAt: new Date().toISOString() },
          webDrawHasher
        );
        setReveal(opened.reveal);
        setRisk(opened.risk);
        setPhase("revealed");

        setIsVerifying(true);
        const asRound: DrawRound = { ...source, state: "revealed", reveal: opened.reveal, payout: null };
        const checked = await verifyRound(asRound, {}, webDrawHasher);
        setVerification(checked);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("sealed");
      } finally {
        setIsVerifying(false);
      }
    },
    [reducedMotion]
  );

  const revealSeed = useCallback(async () => {
    if (commitment === null || sealedSeed === null) return;
    setPhase(reducedMotion ? "revealed" : "shaking");
    // The tamper switch flips one character. Nothing in the pipeline can tell it
    // was flipped — the commitment check is what catches it, and that is the
    // whole demonstration.
    const published = tampersSeed
      ? `${sealedSeed.slice(0, -1)}${sealedSeed.endsWith("a") ? "b" : "a"}`
      : sealedSeed;
    await doReveal(commitment, published);
  }, [commitment, doReveal, reducedMotion, sealedSeed, tampersSeed]);

  const nextRound = useCallback(() => {
    if (reveal !== null) {
      setWinners((current) =>
        current.includes(reveal.winnerMemberId) ? current : [...current, reveal.winnerMemberId]
      );
    }
    setRoundNumber((value) => value + 1);
    setCommitment(null);
    setSealedSeed(null);
    setReveal(null);
    setRisk(null);
    setVerification(PENDING_VERIFICATION);
    setPhase("idle");
    setTampersSeed(false);
  }, [reveal]);

  const rosterDigest = commitment === null ? null : commitment.rosterDigest;
  const transcript = commitment === null ? null : toVerificationTranscript(
    reveal === null
      ? { ...commitment, state: "committed", reveal: null, payout: null }
      : { ...commitment, state: "revealed", reveal, payout: null }
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden no-scrollbar">
      <MesobCeremony
        phase={phase}
        reducedMotion={reducedMotion}
        roundLabel={copy.roundLabel(roundNumber, TOTAL_ROUNDS)}
        winnerName={
          reveal === null
            ? undefined
            : (eligible.find((member) => member.memberId === reveal.winnerMemberId)?.displayName ?? reveal.winnerMemberId)
        }
      />

      <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6">
        <div className="sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card">
          <h3 className="font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]">
            {copy.ceremonyTitle}
          </h3>

          <ol className="mt-3 space-y-2">
            <Step
              index={1}
              label={copy.stepCommit}
              detail={commitment === null ? copy.stepCommitIdle : copy.stepCommitDone}
              done={commitment !== null}
              active={commitment === null}
            />
            <Step
              index={2}
              label={copy.stepReveal}
              detail={reveal === null ? copy.stepRevealIdle : copy.stepRevealDone}
              done={reveal !== null}
              active={commitment !== null && reveal === null}
            />
            <Step
              index={3}
              label={copy.stepVerify}
              detail={copy.stepVerifyDetail}
              done={verification.verified}
              active={reveal !== null && !verification.verified}
            />
          </ol>

          {error ? (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-[#C6532B] bg-[#FDEDE6] px-3 py-2 text-[12px] font-semibold text-[#863214]"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex flex-col gap-2">
            {commitment === null ? (
              <ActionButton onClick={() => void commit()} label={copy.actionCommit} />
            ) : reveal === null ? (
              <ActionButton onClick={() => void revealSeed()} label={copy.actionReveal} />
            ) : (
              <ActionButton onClick={nextRound} label={copy.actionNextRound} />
            )}

            {commitment !== null && reveal === null ? (
              <label className="flex items-start gap-2 rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={tampersSeed}
                  onChange={(event) => setTampersSeed(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#C6532B]"
                />
                <span className="text-[11px] leading-4 text-[#6B4E16]">
                  {copy.tamperToggle}
                </span>
              </label>
            ) : null}
          </div>
        </div>

        {risk !== null ? <RiskPanel risk={risk} currencyLabel={copy.currency} /> : null}

        {transcript !== null ? (
          <VerifyPanel
            transcript={transcript}
            verification={verification}
            isRunning={isVerifying}
            error={null}
          />
        ) : null}

        <section
          className="sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card"
          aria-label={copy.rotationTitle}
          data-draw-panel="rotation"
        >
          <h3 className="font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]">
            {copy.rotationTitle}
          </h3>
          <p className="mt-1.5 text-[12px] leading-5 text-[#6F625D]">{copy.rotationDetail}</p>
          <ul className="mt-3 space-y-1.5">
            {ROSTER.map((member) => {
              const hasWon = winners.includes(member.memberId);
              const isEligible = eligible.some((entry) => entry.memberId === member.memberId);
              return (
                <li
                  key={member.memberId}
                  className={[
                    "flex items-center justify-between gap-2 rounded-lg px-2.5 py-2",
                    hasWon
                      ? "bg-[#F5EFEB] text-[#A0A0A0] line-through"
                      : isEligible
                        ? "bg-[#ECFDF5] text-[#065F46]"
                        : "bg-[#FBF3E2] text-[#6B4E16]"
                  ].join(" ")}
                >
                  <span className="font-ethiopic text-[13px] font-semibold">{member.displayName}</span>
                  <span className="font-sans text-[11px] font-semibold">
                    {hasWon ? copy.alreadyWon : copy.eligible}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className="sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card"
          aria-label={copy.commitmentTitle}
          data-draw-panel="commitment"
        >
          <h3 className="font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]">
            {copy.commitmentTitle}
          </h3>
          {commitment === null ? (
            <p className="mt-2 text-[12px] text-[#6F625D]">{copy.commitmentIdle}</p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
              <dt className="text-[11px] font-semibold text-[#6F625D]">commitment</dt>
              <dd className="sened-hash">{commitment.commitment}</dd>
              <dt className="text-[11px] font-semibold text-[#6F625D]">rosterDigest</dt>
              <dd className="sened-hash">{rosterDigest}</dd>
              <dt className="text-[11px] font-semibold text-[#6F625D]">{copy.participants}</dt>
              <dd className="font-sans text-[12px] font-semibold">{commitment.participants.length}</dd>
              <dt className="text-[11px] font-semibold text-[#6F625D]">pot</dt>
              <dd className="font-sans text-[12px] font-semibold">
                {formatEtbDisplay(POT_AMOUNT)} {copy.currency}
              </dd>
            </dl>
          )}
        </section>

        <p className="px-1 text-[11px] leading-4 text-[#8A7C74]">{copy.localNote}</p>
      </div>
    </div>
  );
}

function Step({
  index,
  label,
  detail,
  done,
  active
}: {
  readonly index: number;
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
  readonly active: boolean;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className={[
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
          done
            ? "bg-[#16A34A] text-white"
            : active
              ? "bg-[#C6532B] text-white"
              : "bg-[#E4D9CE] text-[#8A7C74]"
        ].join(" ")}
      >
        {done ? "✓" : index}
      </span>
      <span className="min-w-0">
        <span className="block font-ethiopic text-[13px] font-bold text-[#1C1410]">{label}</span>
        <span className="block text-[11px] leading-4 text-[#6F625D]">{detail}</span>
      </span>
    </li>
  );
}

function ActionButton({
  onClick,
  label
}: {
  readonly onClick: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 w-full rounded-2xl bg-[#C6532B] px-4 py-3 font-ethiopic text-[15px] font-bold tracking-wide text-[#FAF6F0] shadow-[0_8px_20px_rgba(198,83,43,0.32)] transition-transform active:scale-[0.98]"
    >
      {label}
    </button>
  );
}
