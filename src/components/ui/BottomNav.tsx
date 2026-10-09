"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { useEffect, useRef } from "react";

import { useT } from "@/lib/ui/useT";
import { openVoiceSheet } from "@/lib/ui/voiceSheet";
import { Icon, type IconName } from "./Icon";
import { VoiceSheet } from "./VoiceSheet";

type Tab = "home" | "ledger" | "chat" | "account";

const TAB_ICON: Record<Tab, IconName> = { home: "home", ledger: "book", chat: "chat", account: "account" };
const TAB_HREF: Record<Tab, string> = { home: "/", ledger: "/ledger", chat: "/chat", account: "/account" };

/** Which tab a path belongs to (the draw and members screens hang off Home). */
export function tabForPath(path: string): Tab | null {
  if (path === "/" || path.startsWith("/draw") || path.startsWith("/members") || path.startsWith("/voice")) return "home";
  if (path.startsWith("/ledger")) return "ledger";
  if (path.startsWith("/chat")) return "chat";
  if (path.startsWith("/account")) return "account";
  return null;
}

/**
 * The bottom bar: ቤት · ደብተር · [voice dock] · ውይይት · እኔ. The centre is a woven
 * ring around a dark button that opens the voice sheet. The cotton bar has a
 * round cut-out for the dock; a tibeb strip slides under the current tab.
 */
export function BottomNav({ active }: { readonly active?: Tab | null }) {
  const pathname = usePathname() ?? "/";
  const { t } = useT();
  const current = active === undefined ? tabForPath(pathname) : active;
  const navRef = useRef<HTMLElement | null>(null);

  // Slide the strip from the previous tab to this one.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const cur = nav.querySelector<HTMLElement>("a[aria-current]");
    if (!cur) return;
    const links = Array.from(nav.querySelectorAll<HTMLElement>("a"));
    const idx = links.indexOf(cur);
    let prev = NaN;
    try {
      prev = parseInt(sessionStorage.getItem("snd-tab") ?? "", 10);
      sessionStorage.setItem("snd-tab", String(idx));
    } catch {
      // No session storage: no slide.
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const strip = cur.querySelector<HTMLElement>(".snd-strip");
    if (strip && !reduce && !Number.isNaN(prev) && prev !== idx && strip.animate && links[prev]) {
      const dx = links[prev].getBoundingClientRect().left - cur.getBoundingClientRect().left;
      strip.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }, [current]);

  const tab = (key: Tab, label: string) => {
    const on = current === key;
    return (
      <Link
        key={key}
        href={TAB_HREF[key]}
        className="snd-tab relative flex min-h-[56px] flex-col items-center justify-center gap-[3px] text-sm font-bold"
        aria-current={on ? "page" : undefined}
        style={{ color: on ? "var(--ink)" : "var(--muted)" }}
      >
        <span className="flex items-center justify-center" style={{ width: 52, height: 30, borderRadius: 15, background: on ? "var(--tint)" : undefined, color: on ? "var(--shop)" : undefined }}>
          <Icon name={TAB_ICON[key]} size={24} variant="tab" />
        </span>
        {label}
        {on ? (
          <span
            aria-hidden="true"
            className="snd-strip snd-weave-tex absolute"
            style={{
              top: -6,
              left: "50%",
              marginLeft: -17,
              width: 34,
              height: 7,
              boxSizing: "border-box",
              borderBottom: "2px solid var(--rred)",
              borderRadius: "0 0 3px 3px",
              boxShadow: "0 2px 3px -1px rgba(0,0,0,0.4)",
              backgroundSize: "6px 6px"
            }}
          />
        ) : null}
      </Link>
    );
  };

  return (
    <>
      <nav ref={navRef} aria-label={t("ui.nav.main")} className="sticky bottom-0 z-[5] mt-auto grid grid-cols-5" style={{ padding: "6px 4px 10px" }}>
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full w-full"
          style={{
            backgroundColor: "var(--card)",
            borderTop: "1px solid var(--hair)",
            WebkitMask: "radial-gradient(circle 40px at 50% 14px, transparent 39px, #000 40px)",
            mask: "radial-gradient(circle 40px at 50% 14px, transparent 39px, #000 40px)"
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ left: "50%", top: -26, marginLeft: -40, width: 80, height: 80, boxSizing: "border-box", borderRadius: "50%", border: "1px solid var(--hair)", clipPath: "inset(26px 0 0 0)" }}
        />
        {tab("home", t("ui.nav.home"))}
        {tab("ledger", t("ui.nav.ledger"))}
        <span aria-hidden="true" style={{ minHeight: 56 }} />
        {tab("chat", t("ui.nav.chat"))}
        {tab("account", t("ui.nav.account"))}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ left: "50%", top: -18, marginLeft: -32, width: 64, height: 64, borderRadius: "50%", backgroundColor: "var(--shop)", opacity: 0.3, animation: "snd-glow 3.2s ease-in-out infinite" }}
        />
        <button
          type="button"
          className="snd-dock snd-conic absolute cursor-pointer"
          data-nobloom="1"
          aria-label={t("ui.voice.dockLabel")}
          onClick={openVoiceSheet}
          style={{
            left: "50%",
            top: -18,
            marginLeft: -32,
            width: 64,
            height: 64,
            padding: 3,
            boxSizing: "border-box",
            border: "none",
            borderRadius: "50%",
            boxShadow: "0 12px 20px -8px rgba(28,26,23,0.65), 0 2px 4px rgba(28,26,23,0.3)"
          }}
        >
          <span
            className="flex h-full w-full items-center justify-center"
            style={{ borderRadius: "50%", backgroundImage: "radial-gradient(circle at 36% 26%, #3B362F, #1C1A17 72%)", color: "#F3EEE4", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)" }}
          >
            <Icon name="mic" size={28} />
          </span>
          <span
            lang="en"
            className="absolute flex items-center justify-center font-display font-extrabold"
            style={{ right: -6, top: -4, minWidth: 30, height: 22, padding: "0 6px", boxSizing: "border-box", borderRadius: 11, backgroundColor: "#F3EEE4", color: "#1C1A17", fontSize: 13, boxShadow: "0 0 0 2px var(--card)" }}
          >
            EN
          </span>
        </button>
      </nav>
      <VoiceSheet />
    </>
  );
}
