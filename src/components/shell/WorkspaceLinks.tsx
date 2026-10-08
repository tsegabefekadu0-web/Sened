"use client";

import React from "react";
import Link from "next/link";
import { ChevronRight, Mic, Scale, WifiOff } from "lucide-react";

import { translate, type Locale, type MessageKey } from "@/lib/i18n";

/**
 * The quieter places, listed plainly under the main actions.
 *
 * The things people do every week (speak a contribution, open the ledger, run a
 * draw) are the big button and the bottom bar. These three are used rarely, so
 * they sit at the bottom as ordinary full-width rows with their names written
 * out. Nothing here repeats the bottom bar.
 */
const DESTINATIONS: ReadonlyArray<{
  readonly href: string;
  readonly icon: typeof Mic;
  readonly labelKey: MessageKey;
}> = [
  { href: "/governance", icon: Scale, labelKey: "home.more.bylaws" },
  { href: "/offline", icon: WifiOff, labelKey: "home.more.offline" },
  { href: "/voice", icon: Mic, labelKey: "home.more.voice" }
];

export function WorkspaceLinks({ locale = "am" }: { readonly locale?: Locale } = {}) {
  return (
    <nav aria-label={translate(locale, "shell.builtTools")} className="w-full select-none px-4 pt-2">
      <h2 className="font-ethiopic text-[20px] font-bold leading-snug text-[#1C1410]">
        {translate(locale, "home.more.title")}
      </h2>
      <ul className="mt-2 divide-y divide-[#E0D2C4] overflow-hidden rounded-2xl border border-[#E0D2C4] bg-white">
        {DESTINATIONS.map(({ href, icon: Icon, labelKey }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-[60px] items-center gap-3 px-4 py-2 font-ethiopic text-[18px] font-bold leading-snug text-[#2A1D17] transition-colors hover:bg-[#F8F2E9] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C6532B]"
            >
              <Icon className="h-6 w-6 shrink-0 stroke-[2] text-[#A9411D]" aria-hidden="true" />
              <span className="flex-1">{translate(locale, labelKey)}</span>
              <ChevronRight className="h-5 w-5 shrink-0 text-[#6B4E0E]" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
