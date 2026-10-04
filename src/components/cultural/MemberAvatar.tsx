import React from "react";
import Image from "next/image";
import { User } from "lucide-react";

import { isMemberAttire, pickTibebFrame, type MemberAttire, type TibebFrame } from "@/lib/memberAvatarStyle";

/**
 * A member's portrait inside a Tibeb (ጥበብ) embroidered border, optionally
 * wearing the shawl they chose: Gabi (white cotton) or Netela (lighter, with a
 * woven border).
 *
 * The frame is picked from the member id alone (`pickTibebFrame`), so it is
 * neutral and stable; the shawl is drawn only when `attire` is passed, which
 * today is never, because no profile field records a choice. See
 * `memberAvatarStyle.ts` for why nothing is inferred.
 *
 * Accessibility: the SVG is decoration (`aria-hidden`). What a person needs is
 * in text: the photo's alt text, or, with no photo, a labelled image role. The
 * four frames and the two shawls differ in *shape* (diamonds, crosses, zigzag,
 * checker; a left versus a right drape), never in colour alone. Only design
 * tokens (coffee, parchment, terracotta, gold) are used, through Tailwind
 * classes. The app's feed sits on a light parchment surface in both system
 * themes, so there is no separate dark palette to switch to.
 */

const BAND_TOP = 64;
const COLUMNS = [7, 21, 35, 49, 63] as const;

function Diamonds() {
  return (
    <g>
      {COLUMNS.map((x) => (
        <polygon
          key={x}
          points={`${x},${BAND_TOP + 3} ${x + 5},${BAND_TOP + 7} ${x},${BAND_TOP + 11} ${x - 5},${BAND_TOP + 7}`}
          className="fill-terracotta-500 stroke-gold-400"
          strokeWidth="1"
        />
      ))}
    </g>
  );
}

function Crosses() {
  return (
    <g className="fill-gold-400">
      {COLUMNS.map((x) => (
        <g key={x}>
          <rect x={x - 1.2} y={BAND_TOP + 2.5} width="2.4" height="9" rx="0.5" />
          <rect x={x - 4.5} y={BAND_TOP + 5.8} width="9" height="2.4" rx="0.5" />
          <rect x={x - 1.6} y={BAND_TOP + 5.4} width="3.2" height="3.2" className="fill-terracotta-500" />
        </g>
      ))}
    </g>
  );
}

function Zigzag() {
  const points = Array.from({ length: 11 }, (_, index) => `${index * 7},${BAND_TOP + (index % 2 === 0 ? 4 : 10)}`).join(" ");
  return (
    <g fill="none" strokeLinejoin="miter">
      <polyline points={points} className="stroke-terracotta-500" strokeWidth="2.4" />
      <polyline points={points} className="stroke-gold-400" strokeWidth="0.9" />
    </g>
  );
}

function Weave() {
  const cells: React.ReactNode[] = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const terracotta = (row + column) % 2 === 0;
      cells.push(
        <rect
          key={`${row}-${column}`}
          x={column * 6}
          y={BAND_TOP + 2 + row * 5}
          width="5"
          height="4"
          className={terracotta ? "fill-terracotta-500" : "fill-gold-400"}
        />
      );
    }
  }
  return <g>{cells}</g>;
}

const BAND: Record<TibebFrame, () => React.ReactElement> = {
  diamond: Diamonds,
  meskel: Crosses,
  zigzag: Zigzag,
  weave: Weave
};

/** Gabi: a white cotton shawl drawn over the lower left, edged with one terracotta and one gold stripe. */
function Gabi() {
  return (
    <g data-attire="gabi">
      <path d="M0 62 L0 36 C12 40 24 48 34 62 Z" className="fill-parchment-50 stroke-parchment-300" strokeWidth="1" />
      <path d="M0 36 C12 40 24 48 34 62" fill="none" className="stroke-terracotta-500" strokeWidth="2" />
      <path d="M0 40 C11 44 21 51 29 62" fill="none" className="stroke-gold-400" strokeWidth="1" />
    </g>
  );
}

/** Netela: a lighter shawl over the lower right, its hem a woven border of small diamonds between two stripes. */
function Netela() {
  return (
    <g data-attire="netela">
      <path d="M70 62 L70 38 C58 42 46 50 36 62 Z" className="fill-parchment-100 stroke-parchment-300" strokeWidth="1" />
      <path d="M70 38 C58 42 46 50 36 62" fill="none" className="stroke-gold-500" strokeWidth="1.4" />
      <path d="M70 43 C60 47 51 54 43 62" fill="none" className="stroke-terracotta-500" strokeWidth="1.4" />
      {[
        [66, 46],
        [58, 50.5],
        [51, 55.5]
      ].map(([x, y]) => (
        <polygon key={`${x}-${y}`} points={`${x},${y - 2.2} ${x + 2.2},${y} ${x},${y + 2.2} ${x - 2.2},${y}`} className="fill-terracotta-500" />
      ))}
    </g>
  );
}

export function MemberAvatar({
  memberId,
  name,
  photo,
  attire,
  attireLabel,
  photoAlt,
  className = "w-[70px] h-[76px]"
}: {
  /** Opaque stable id of the member. Absent (payer unknown): the neutral default frame. */
  memberId?: string | null;
  name: string;
  /** Absent when no photo is on record; a neutral silhouette is drawn. */
  photo?: string;
  /** The shawl the member chose. Never inferred from `name`; no source for it exists yet. */
  attire?: MemberAttire | null;
  /** Localised name of the chosen attire, for the accessible name. */
  attireLabel?: string;
  /** Overrides the photo's alt text (the feed's secondary portrait says so). */
  photoAlt?: string;
  className?: string;
}) {
  const frame = pickTibebFrame(memberId);
  const shawl = isMemberAttire(attire) ? attire : null;
  const Band = BAND[frame];
  const accessibleName = shawl && attireLabel ? `${name} — ${attireLabel}` : name;

  return (
    <div
      className={`relative ${className} rounded-[16px] overflow-hidden shrink-0 shadow-sm border border-line bg-parchment-200`}
      data-testid="member-avatar"
      data-frame={frame}
      data-attire={shawl ?? "none"}
      {...(photo ? {} : { role: "img", "aria-label": accessibleName })}
    >
      {photo ? (
        <Image src={photo} alt={photoAlt ?? accessibleName} fill sizes="70px" className="object-cover" priority />
      ) : (
        <div className="flex h-full w-full items-center justify-center pb-3 text-inkMuted" aria-hidden="true">
          <User className="w-8 h-8" />
        </div>
      )}
      <svg
        viewBox="0 0 70 76"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
        focusable="false"
        data-testid="member-avatar-frame"
      >
        {shawl === "gabi" ? <Gabi /> : shawl === "netela" ? <Netela /> : null}
        <rect x="0" y={BAND_TOP} width="70" height={76 - BAND_TOP} className="fill-coffee-900/90" />
        <line x1="0" y1={BAND_TOP} x2="70" y2={BAND_TOP} className="stroke-gold-500" strokeWidth="1.2" />
        <Band />
        <rect x="0.75" y="0.75" width="68.5" height="74.5" rx="15" fill="none" className="stroke-gold-500" strokeWidth="1.5" />
        <polygon points="6,2 10,6 6,10 2,6" className="fill-gold-400" />
        <polygon points="64,2 68,6 64,10 60,6" className="fill-gold-400" />
      </svg>
    </div>
  );
}
