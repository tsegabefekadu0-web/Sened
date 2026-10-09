import React from "react";

import { ICONS, type IconName } from "./icons-data";

export type { IconName };

export type IconVariant = "line" | "duo" | "tab";

/**
 * The Sened icon family: 24px grid, 1.75 stroke, round caps. `duo` adds a tinted
 * body fill and the tibeb accent; `tab` renders both layers and lets CSS reveal
 * them on `[aria-current]` (see `.snd-tab` in globals.css).
 */
export function Icon({
  name,
  size = 22,
  variant = "line",
  strokeWidth = 1.75,
  className,
  style
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly variant?: IconVariant;
  readonly strokeWidth?: number;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}) {
  const def = ICONS[name];
  const showFill = variant === "duo" || variant === "tab";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {showFill && def.f ? (
        <g
          className={variant === "tab" ? "snd-fillg" : undefined}
          fill="currentColor"
          fillOpacity={variant === "tab" ? 0.18 : 0.16}
          stroke="none"
          dangerouslySetInnerHTML={{ __html: def.f }}
        />
      ) : null}
      <g dangerouslySetInnerHTML={{ __html: def.l }} />
      {showFill && def.a ? <g className={variant === "tab" ? "snd-accg" : undefined} dangerouslySetInnerHTML={{ __html: def.a }} /> : null}
    </svg>
  );
}
