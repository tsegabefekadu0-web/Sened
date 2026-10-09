import React from "react";

/**
 * The tibeb ribbon: green, gold, red stripes around a woven cream band, with
 * yarn texture and a soft sheen. It weaves in left to right on mount.
 */
export function TibebRibbon({
  className = "",
  style,
  animate = true,
  vertical = false
}: {
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly animate?: boolean;
  /** A ribbon down the left edge (the receipt), 22px wide. */
  readonly vertical?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`${animate ? (vertical ? "snd-weavey" : "snd-weave") : ""} flex ${vertical ? "flex-row" : "flex-col"} overflow-hidden ${className}`}
      style={vertical ? { position: "absolute", left: 0, top: 0, bottom: 0, width: 22, boxShadow: "5px 0 8px -3px rgba(0,0,0,0.5)", ...style } : { position: "absolute", left: 0, right: 0, height: 22, boxShadow: "0 5px 8px -3px rgba(0,0,0,0.5)", ...style }}
    >
      <span style={{ flex: "0 0 2px", background: "var(--rgreen)" }} />
      <span style={{ flex: "0 0 1px", background: "var(--rgold)" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rred)" }} />
      <span className="snd-weave-tex" style={{ flex: "1 1 auto", backgroundSize: "12px 12px" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rred)" }} />
      <span style={{ flex: "0 0 1px", background: "var(--rgold)" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rgreen)" }} />
      <span className="snd-yarn" style={{ position: "absolute", inset: 0 }} />
      <span
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, rgba(255,255,255,var(--sheen)), rgba(255,255,255,0) 38%, rgba(0,0,0,0.20))"
        }}
      />
    </span>
  );
}

/** A tiny woven swatch used as a legend mark in notes. */
export function WeaveSwatch({ className = "" }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`snd-weave-tex shrink-0 ${className}`}
      style={{ width: 34, height: 12, border: "1px solid var(--hair)", boxSizing: "border-box", backgroundSize: "6px 6px" }}
    />
  );
}

/** The woven emblem ring around an avatar or the voice dock. */
export function WovenRing({
  size,
  dim = false,
  children,
  className = ""
}: {
  readonly size: number;
  readonly dim?: boolean;
  readonly children?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`snd-conic shrink-0 ${className}`}
      style={{
        filter: dim ? "grayscale(1)" : "var(--ringf)",
        opacity: dim ? 0.45 : 1,
        width: size,
        height: size,
        padding: 3.5,
        boxSizing: "border-box",
        borderRadius: "50%",
        boxShadow: "0 2px 5px -1px rgba(0,0,0,0.4)"
      }}
    >
      {children}
    </span>
  );
}

/** Avatar: initial in Noto Serif Ethiopic inside the woven ring. */
export function WovenAvatar({
  initial,
  size = 48,
  dim = false,
  fontSize
}: {
  readonly initial: string;
  readonly size?: number;
  readonly dim?: boolean;
  readonly fontSize?: number;
}) {
  return (
    <WovenRing size={size} dim={dim}>
      <span
        lang="am"
        className="flex h-full w-full items-center justify-center rounded-full font-serif font-bold"
        style={{ background: "var(--bg)", color: "var(--ink)", fontSize: fontSize ?? Math.round(size * 0.375) }}
      >
        {initial}
      </span>
    </WovenRing>
  );
}
