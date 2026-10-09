"use client";

import Link from "next/link";
import React from "react";

import { useT } from "@/lib/ui/useT";
import { Icon } from "./Icon";
import { SlideSwitch } from "./SlideSwitch";
import { TibebRibbon } from "./Weave";

/** The language switch used on the brand header: አማ | EN. App-wide. */
export function LanguageSwitch({ onGreen = true, compact = true }: { readonly onGreen?: boolean; readonly compact?: boolean }) {
  const { t, locale, setLocale } = useT();
  return (
    <SlideSwitch
      checked={locale === "en"}
      onChange={(on) => setLocale(on ? "en" : "am")}
      label={t("ui.language")}
      left="አማ"
      right="EN"
      onGreen={onGreen}
      compact={compact}
    />
  );
}

/**
 * The green brand header with the tibeb ribbon on its lower edge. Content
 * overlaps below it by giving the next card a negative top margin.
 *  - `back`: a round back link at the left, title and subtitle beside it.
 *  - `children`: extra content under the title row (home puts the brand there).
 */
export function AppHeader({
  title,
  subtitle,
  back,
  backLabel,
  bottom = 48,
  ribbon = 0,
  children,
  right
}: {
  readonly title?: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  readonly back?: string;
  readonly backLabel?: string;
  /** Bottom padding; the ribbon sits 40px above the edge, cards overlap the rest. */
  readonly bottom?: number;
  /** Distance of the ribbon from the header bottom edge. */
  readonly ribbon?: number;
  readonly children?: React.ReactNode;
  readonly right?: React.ReactNode;
}) {
  return (
    <header
      className="relative flex flex-col overflow-hidden text-white"
      style={{ background: "var(--shop)", padding: `${back ? 10 : 18}px ${back ? 14 : 20}px ${bottom}px ${back ? 8 : 20}px`, gap: children ? 22 : 0, borderRadius: "0 0 28px 28px" }}
    >
      {title ? (
        <div className="flex items-center gap-2">
          {back ? (
            <Link href={back} aria-label={backLabel} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white">
              <Icon name="back" size={22} />
            </Link>
          ) : null}
          <div className="flex min-w-0 grow flex-col" style={{ gap: back ? 0 : 2 }}>
            <h1 lang="am" className="m-0 font-serif font-bold leading-[1.2]" style={{ fontSize: back ? 19 : 30 }}>
              {title}
            </h1>
            {subtitle ? (
              <span className="font-display font-semibold opacity-90" style={{ fontSize: back ? 13 : 14 }}>
                {subtitle}
              </span>
            ) : null}
          </div>
          {right}
        </div>
      ) : null}
      {children}
      <TibebRibbon style={{ bottom: ribbon }} />
    </header>
  );
}
