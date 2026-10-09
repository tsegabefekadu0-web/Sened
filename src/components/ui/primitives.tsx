"use client";

import React, { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";

/* ---------------------------------------------------------------- Pills */

export type PillKind = "paid" | "draft" | "due" | "saved" | "fixed" | "void";

const PILL_LIGHT: Record<PillKind, readonly [string, string]> = {
  paid: ["#1F6B3F", "#E3F1E8"],
  draft: ["#8A5A00", "#F8EBCB"],
  due: ["#8F3A2E", "#F6E2DE"],
  saved: ["#2B3A6B", "#E4E8F3"],
  fixed: ["#2B3A6B", "#E4E8F3"],
  void: ["#615A50", "#ECE9E2"]
};
const PILL_DARK: Record<PillKind, readonly [string, string]> = {
  paid: ["#86DBA6", "rgba(134,219,166,0.14)"],
  draft: ["#F2C86E", "rgba(242,200,110,0.14)"],
  due: ["#F4A59C", "rgba(244,165,156,0.14)"],
  saved: ["#B1BEF2", "rgba(177,190,242,0.14)"],
  fixed: ["#B1BEF2", "rgba(177,190,242,0.14)"],
  void: ["#B9AFA0", "rgba(255,255,255,0.07)"]
};

/** A status pill: a dot and a word. Colours switch with the theme through CSS variables. */
export function StatusPill({ kind, label }: { readonly kind: PillKind; readonly label: string }) {
  return (
    <span
      className="snd-pill inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[14px] px-3 text-[13px] font-bold"
      data-kind={kind}
      style={
        {
          "--pc": PILL_LIGHT[kind][0],
          "--pb": PILL_LIGHT[kind][1],
          "--pcd": PILL_DARK[kind][0],
          "--pbd": PILL_DARK[kind][1]
        } as React.CSSProperties
      }
    >
      <span className="snd-pill-dot h-[7px] w-[7px] rounded-full" />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------------- Card */

export function Card({
  children,
  className = "",
  style,
  as: Tag = "section",
  ...rest
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly as?: "section" | "div" | "article" | "li";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      {...(rest as object)}
      className={`snd-cotton relative rounded-[22px] border border-hair bg-card ${className}`}
      style={{ boxShadow: "var(--lift)", ...style }}
    >
      {children}
    </Tag>
  );
}

/* ---------------------------------------------------------------- Button */

export type AsyncState = "idle" | "loading" | "success" | "error";

/**
 * The pill button. `variant` prim (filled), ghost (outlined), shop (brand fill).
 * With `onPress` returning a promise it runs the loading, success and error
 * states from the design: a two-arc spinner, a drawn check, a shake and red tint.
 */
export function Button({
  children,
  onPress,
  variant = "prim",
  href,
  disabled,
  type = "button",
  successLabel,
  errorLabel,
  icon,
  className = "",
  style,
  ariaLabel
}: {
  readonly children?: React.ReactNode;
  readonly onPress?: () => void | boolean | Promise<unknown>;
  readonly variant?: "prim" | "ghost" | "shop";
  readonly href?: string;
  readonly disabled?: boolean;
  readonly type?: "button" | "submit";
  readonly successLabel?: string;
  readonly errorLabel?: string;
  readonly icon?: IconName;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly ariaLabel?: string;
}) {
  const [state, setState] = useState<AsyncState>("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    if (state === "loading" || disabled || !onPress) return;
    setState("loading");
    try {
      const result = await onPress();
      if (!mounted.current) return;
      if (result === false) {
        setState("error");
        setTimeout(() => mounted.current && setState("idle"), 1700);
      } else {
        setState("success");
        setTimeout(() => mounted.current && setState("idle"), 900);
      }
    } catch {
      if (!mounted.current) return;
      setState("error");
      setTimeout(() => mounted.current && setState("idle"), 1700);
    }
  };

  const loading = state === "loading";
  const base =
    variant === "ghost"
      ? "border-[1.5px] border-prim bg-card text-ink"
      : variant === "shop"
        ? "border-none bg-shop text-white"
        : "border-none bg-prim text-primt";
  const stateStyle: React.CSSProperties =
    state === "success"
      ? { backgroundColor: "#23703F", color: "#FFFFFF", borderColor: "transparent" }
      : state === "error"
        ? { backgroundColor: "#8F2A22", color: "#FFFFFF", borderColor: "transparent", animation: "snd-shake 420ms ease-in-out both" }
        : {};
  const cls = `relative flex h-[54px] w-full items-center justify-center gap-2.5 rounded-[27px] text-[17px] font-bold ${base} ${className} ${loading ? "pointer-events-none cursor-progress" : "cursor-pointer"} disabled:cursor-not-allowed disabled:opacity-50`;
  const shadow = variant === "ghost" ? undefined : "0 8px 16px -10px rgba(0,0,0,0.7)";
  const inner = (
    <>
      {loading ? (
        <span aria-hidden="true" className="absolute left-1/2 top-1/2 -ml-[11px] -mt-[11px] flex h-[22px] w-[22px]" style={{ animation: "snd-spin360 900ms linear infinite" }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" strokeWidth="3" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" stroke="#D8473B" strokeDasharray="19 60" />
            <circle cx="11" cy="11" r="8" stroke="#E3B23C" strokeDasharray="19 60" strokeDashoffset="-25" />
          </svg>
        </span>
      ) : null}
      <span className="flex items-center gap-2" style={loading ? { opacity: 0 } : { animation: "snd-fade 240ms var(--snd-ease) both" }}>
        {state === "success" ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5.2 12.6 4.4 4.4L19 7.6" strokeDasharray="24" style={{ animation: "snd-check 320ms var(--snd-ease) 80ms both" }} />
          </svg>
        ) : icon ? (
          <Icon name={icon} size={22} />
        ) : null}
        <span lang="am">{state === "error" && errorLabel ? errorLabel : state === "success" && successLabel ? successLabel : children}</span>
      </span>
    </>
  );

  if (href && !onPress) {
    return (
      <a href={href} className={cls} style={{ boxShadow: shadow, ...style }} aria-label={ariaLabel}>
        {inner}
      </a>
    );
  }
  return (
    <button
      type={type}
      onClick={() => void run()}
      disabled={disabled}
      aria-busy={loading}
      aria-label={ariaLabel}
      className={cls}
      style={{ boxShadow: shadow, transition: "background-color 240ms var(--snd-ease), color 240ms var(--snd-ease), transform 280ms var(--snd-spring)", ...style, ...stateStyle }}
    >
      {inner}
    </button>
  );
}

/* ---------------------------------------------------------------- Count up */

/** A number that counts up once on mount (900ms ease-out cubic), instant under reduced motion. */
export function CountUp({ to, className, style }: { readonly to: number; readonly className?: string; readonly style?: React.CSSProperties }) {
  const [shown, setShown] = useState(to);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduce || !Number.isFinite(to)) {
      setShown(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    setShown(0);
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - t0 - 300) / 900));
      setShown(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return (
    <span className={className} style={style}>
      {shown.toLocaleString("en-US")}
    </span>
  );
}

/* ---------------------------------------------------------------- Screen shell */

/** The skeleton wrapper: while `loading`, every text and icon turns into a woven bone. */
export function Screen({
  children,
  loading = false,
  className = ""
}: {
  readonly children: React.ReactNode;
  readonly loading?: boolean;
  readonly className?: string;
}) {
  return (
    <div className={`snd-screen mx-auto flex min-h-[100dvh] w-full max-w-[480px] flex-col bg-bg text-ink ${loading ? "snd-loading" : ""} ${className}`} aria-busy={loading || undefined}>
      {children}
    </div>
  );
}
