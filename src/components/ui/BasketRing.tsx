import React, { useMemo } from "react";

export type RingKind = "paid" | "draft" | "due";

interface Layer {
  readonly d: string;
  readonly s: string;
  readonly w: number;
  readonly da: string;
  readonly dl: number;
}

const DYE: Record<RingKind, string> = { paid: "#2A6B47", draft: "#E7AE3A", due: "#D8BC88" };

/** The woven basket: one coil segment per member, dyed by payment state. */
export function basketLayers(order: readonly RingKind[]): Layer[] {
  const C = 88;
  const rm = 60;
  const bw = 28;
  const gap = 5;
  const PI = Math.PI;
  const step = 360 / Math.max(order.length, 1);
  const pt = (r: number, a: number) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
  const arc = (r: number, a0: number, a1: number) => `M${pt(r, a0)} A${r} ${r} 0 0 1 ${pt(r, a1)}`;
  const circ = (r: number) => `M${C - r} ${C} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const layers: Layer[] = [{ d: circ(rm), s: "#5E3E22", w: bw + 4, da: "none", dl: 0 }];
  let seg = -1;
  const push = (o: Omit<Layer, "dl">) => layers.push({ ...o, dl: seg < 0 ? 0 : 260 + seg * 60 });
  order.forEach((k, i) => {
    seg = i;
    const a0 = ((-90 + i * step + gap / 2) * PI) / 180;
    const a1 = ((-90 + (i + 1) * step - gap / 2) * PI) / 180;
    push({ d: arc(rm, a0, a1), s: DYE[k], w: bw, da: "none" });
    push({ d: arc(rm, a0, a1), s: "rgba(0,0,0,0.18)", w: bw, da: "1.3 4.5" });
    [-10.5, -3.5, 3.5, 10.5].forEach((o) => {
      push({ d: arc(rm + o, a0, a1), s: "rgba(0,0,0,0.30)", w: 1.1, da: "none" });
      push({ d: arc(rm + o + 1.2, a0, a1), s: "rgba(255,255,255,0.26)", w: 1, da: "none" });
    });
    push({ d: arc(rm - 5, a0, a1), s: "rgba(255,255,255,0.10)", w: 7, da: "none" });
    push({ d: arc(rm - 11.6, a0, a1), s: "#8E2A22", w: 2.4, da: "none" });
    push({ d: arc(rm + 11.6, a0, a1), s: "#1C1A17", w: 2.4, da: "none" });
    push({ d: arc(rm + 11.6, a0, a1), s: "rgba(255,255,255,0.35)", w: 2.4, da: "1.2 3.6" });
  });
  [rm + bw / 2 + 3, rm - bw / 2 - 3].forEach((r, ri) => {
    seg = -1;
    push({ d: circ(r), s: ri ? "#8E2A22" : "#6B4426", w: 6, da: "none" });
    push({ d: circ(r), s: "rgba(255,255,255,0.30)", w: 6, da: "1.4 3.8" });
    push({ d: circ(r), s: "rgba(0,0,0,0.25)", w: 1, da: "none" });
  });
  return layers;
}

export function BasketRing({
  order,
  label,
  centerTop,
  centerBottom,
  size = 176
}: {
  readonly order: readonly RingKind[];
  readonly label: string;
  readonly centerTop: string;
  readonly centerBottom: string;
  readonly size?: number;
}) {
  const layers = useMemo(() => basketLayers(order), [order]);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size, filter: "drop-shadow(0 10px 10px rgba(60,40,20,0.28))" }}>
      <svg width={size} height={size} viewBox="0 0 176 176" fill="none" role="img" aria-label={label}>
        {layers.map((l, i) => (
          <path
            key={i}
            d={l.d}
            fill="none"
            stroke={l.s}
            strokeWidth={l.w}
            strokeDasharray={l.da}
            style={{
              transformBox: "view-box",
              transformOrigin: "50% 50%",
              animation: "snd-seg 420ms var(--snd-ease) both",
              animationDelay: `${l.dl}ms`
            }}
          />
        ))}
      </svg>
      <div
        className="absolute flex flex-col items-center justify-center"
        style={{
          left: "27.27%",
          top: "27.27%",
          width: "45.45%",
          height: "45.45%",
          borderRadius: "50%",
          background: "radial-gradient(circle at 50% 28%, #FFFFFF, #EFEAE0)",
          boxShadow: "inset 0 5px 10px rgba(60,40,20,0.38), inset 0 -1px 0 rgba(255,255,255,0.9)",
          color: "#1C1A17"
        }}
      >
        <span className="font-display font-extrabold leading-[1.1]" style={{ fontSize: 22, letterSpacing: "-0.02em" }}>
          {centerTop}
        </span>
        <span lang="am" style={{ fontSize: 13, color: "#615A50" }}>
          {centerBottom}
        </span>
      </div>
    </div>
  );
}
