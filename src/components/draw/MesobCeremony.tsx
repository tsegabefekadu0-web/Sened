"use client";

import React from "react";

import { MesobBasket } from "@/components/cultural/CulturalIcons";
import { MesobIcon } from "@/components/cultural/MesobIcon";

import "./draw.css";

export type CeremonyPhase = "idle" | "sealed" | "shaking" | "revealing" | "revealed";

export interface MesobCeremonyProps {
  readonly phase: CeremonyPhase;
  readonly reducedMotion: boolean;
  readonly winnerName?: string;
  readonly roundLabel: string;
  /** The word on the wax seal; localised by the caller (defaults to the English word). */
  readonly sealLabel?: string;
}

const CONFETTI_COLORS = ["#D4A244", "#E06438", "#16A34A", "#F3C769", "#C6532B"];

/**
 * Deterministic confetti positions.
 *
 * A fixed table rather than `Math.random()` at render time: this component
 * renders on the server too, and random values would produce a hydration
 * mismatch on every load.
 */
const CONFETTI: readonly { readonly left: string; readonly delay: string; readonly duration: string }[] =
  Array.from({ length: 24 }, (_, index) => ({
    left: `${(index * 41) % 100}%`,
    delay: `${((index * 137) % 900) / 10}s`,
    duration: `${1600 + ((index * 211) % 1400)}ms`
  }));

/**
 * The መሶብ ceremony.
 *
 * This adopts the two components AGENTWORK.md §2 (M4) told me to rescue:
 * `MesobIcon` and `MesobBasket`, which had **zero importers** at `main` and were
 * dead code waiting for exactly this. Neither file under
 * `src/components/cultural/**` is modified.
 *
 * One thing to know if you edit this: both components declare an SVG
 * `<linearGradient id="mesobStraw">` — different gradients, same DOM id. SVG
 * `id` is document-global, so mounting both at once makes one of them silently
 * render with the other's colours. They are therefore rendered in mutually
 * exclusive branches here. If a future change needs them simultaneously, copy
 * the SVGs into this folder and namespace the ids rather than reaching back
 * into the shared cultural folder.
 */
export function MesobCeremony({
  phase,
  reducedMotion,
  winnerName,
  roundLabel,
  sealLabel
}: MesobCeremonyProps) {
  const shaking = phase === "shaking" && !reducedMotion;
  const lidLifting = phase === "revealing" && !reducedMotion;
  const celebrating = phase === "revealed";

  return (
    <section
      className="sened-draw-ceremony select-none rounded-[28px] px-5 pb-6 pt-7 text-center"
      aria-live="polite"
      aria-label={`የእጣ ሥርዓት — ${roundLabel}`}
    >
      {celebrating && !reducedMotion ? (
        <div className="sened-confetti is-falling" aria-hidden="true">
          {CONFETTI.map((piece, index) => (
            <span
              key={index}
              style={{
                left: piece.left,
                backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                animationDelay: piece.delay,
                animationDuration: piece.duration
              }}
            />
          ))}
        </div>
      ) : null}

      <p className="font-ethiopic text-[13px] font-semibold tracking-[0.22em] text-[#F3C769]">
        {roundLabel}
      </p>

      <div className="relative mx-auto mt-4 flex h-[188px] w-full max-w-[260px] items-end justify-center">
        <div className={shaking ? "sened-mesob-shaking" : celebrating ? "sened-draw-pulsing" : undefined}>
          <div className="sened-mesob-basket w-[132px] sm:w-[150px]">
            {celebrating ? (
              <MesobBasket className="h-auto w-full" />
            ) : (
              <MesobIcon className="h-auto w-full" />
            )}
          </div>
        </div>

        {phase === "sealed" || phase === "shaking" ? (
          <div className="sened-seal absolute right-[14%] top-[6%] flex h-[46px] w-[46px] items-center justify-center rounded-full border-2 border-[#F3C769] bg-[#863214] text-[9px] font-bold leading-none tracking-tight text-[#F3C769]">
            <span className="font-ethiopic">ቃል</span>
            <span className="font-sans">{sealLabel ?? "SEALED"}</span>
          </div>
        ) : null}

        {lidLifting ? <div className="sened-mesob-lid sened-mesob-lid-lifting" aria-hidden="true" /> : null}
      </div>

      <div className="mx-auto mt-5 min-h-[76px] max-w-[320px]">
        {celebrating ? (
          <>
            <p className="font-ethiopic text-[26px] font-bold leading-tight text-[#FAF6F0]">
              {winnerName ?? "አሸናፊ"}
            </p>
            <p className="mt-1 text-[12px] font-medium tracking-[0.14em] text-[#D4A244]">
              እጣ ተጠናቋል
            </p>
          </>
        ) : phase === "shaking" ? (
          <p className="text-[13px] font-medium text-[#EBE2D8]">
            {reducedMotion ? "እጣዎች በመሶብ ውስጥ በመሆን ላይ እየተጠበቀ ነው" : "መሶቡ እየተጨማረ ነው…"}
          </p>
        ) : (
          <p className="text-[13px] font-medium text-[#DDD0C2]">
            {phase === "sealed"
              ? "ቃል መዋጮው ተዘጋጅቷል፤ ዘመኑ እስኪተገልጥ አልተቻለም"
              : "ሦስት ደረጃዎች — ቃል መዋጮ · መስበር · ማረጋገጥ"}
          </p>
        )}
      </div>
    </section>
  );
}
