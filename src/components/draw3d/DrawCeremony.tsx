"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";

export interface CeremonyProps {
  readonly winnerName: string;
  readonly roundLabel: string;
  readonly groupName: string;
  readonly letters: readonly string[];
  readonly replayLabel: string;
  readonly canvasLabel: string;
  /** Called when the visible step (0..3) or the "winner revealed" flag changes. */
  readonly onProgress: (step: number, won: boolean) => void;
  /** Bumped by the parent to restart the ceremony. */
  readonly replayKey?: number;
  /** Extra classes for the stage (the draw screen places it in a grid cell on desktop). */
  readonly className?: string;
}

const stepFor = (t: number) => (t > 5.0 ? 3 : t > 3.4 ? 2 : t > 1.9 ? 1 : 0);

/**
 * The mesob ceremony: a lazily loaded three.js scene with a CSS ceremony beneath
 * it. The CSS version runs until (and unless) the 3D scene draws its first frame,
 * so a device without WebGL still sees the full ceremony. Reduced motion shows
 * the finished state without animation.
 */
export function DrawCeremony(props: CeremonyProps) {
  const { winnerName, roundLabel, groupName, letters, replayLabel, canvasLabel, onProgress } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fbRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{ start: (still: boolean) => void; dispose: () => void } | null>(null);
  const glRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRef = useRef({ step: -1, won: false });
  const [gl, setGl] = useState(false);
  const [localKey, setLocalKey] = useState(0);
  const progress = useRef(onProgress);
  progress.current = onProgress;

  const emit = useCallback((t: number) => {
    const step = stepFor(t);
    const won = t > 5.9;
    if (step !== lastRef.current.step || won !== lastRef.current.won) {
      lastRef.current = { step, won };
      progress.current(step, won);
    }
  }, []);

  const restartFallback = useCallback(() => {
    const els = fbRef.current?.querySelectorAll<HTMLElement>(".fb-a");
    els?.forEach((el) => {
      el.style.animation = "none";
    });
    void document.body.offsetWidth;
    els?.forEach((el) => {
      el.style.animation = "";
    });
  }, []);

  const key = (props.replayKey ?? 0) * 1000 + localKey;

  useEffect(() => {
    let cancelled = false;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    lastRef.current = { step: -1, won: false };
    emit(0);

    const runFallback = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (reduce) {
        emit(99);
        return;
      }
      const t0 = performance.now();
      const tick = () => {
        if (cancelled || glRef.current) return;
        const t = (performance.now() - t0) / 1000;
        emit(t);
        if (t < 6.5) timerRef.current = setTimeout(tick, 100);
        else emit(99);
      };
      tick();
    };

    if (sceneRef.current) {
      // Replay on an existing scene.
      sceneRef.current.start(reduce);
      if (!glRef.current) {
        restartFallback();
        runFallback();
      }
      return () => {
        cancelled = true;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }

    runFallback();
    const canvas = canvasRef.current;
    void (async () => {
      if (!canvas) return;
      try {
        const test = document.createElement("canvas");
        if (!(test.getContext("webgl2") || test.getContext("webgl"))) return;
        const { MesobScene } = await import("@/lib/ui/mesobScene");
        if (cancelled) return;
        const scene = new MesobScene({ canvas, letters, winnerName, roundLabel, groupName });
        scene.onProgress = (t) => {
          if (!glRef.current) {
            glRef.current = true;
            setGl(true);
            if (timerRef.current) clearTimeout(timerRef.current);
          }
          emit(t);
        };
        scene.onLost = () => {
          scene.dispose();
          sceneRef.current = null;
          glRef.current = false;
          setGl(false);
          restartFallback();
          runFallback();
        };
        sceneRef.current = scene;
        scene.start(reduce);
      } catch {
        // No usable WebGL: the CSS ceremony keeps running.
        glRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // The scene is created once; later key changes replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(
    () => () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    },
    []
  );

  return (
    <div className={`relative z-[1] ${props.className ?? ""}`} style={{ height: 330, margin: "-6px -20px 0" }}>
      <div ref={fbRef} id="snd-fb" aria-hidden="true" data-testid="draw-fallback" style={gl ? { display: "none" } : { position: "absolute", left: "50%", marginLeft: -125, bottom: 0, width: 250, height: 232 }}>
        <Fallback winnerName={winnerName} />
      </div>
      <canvas ref={canvasRef} id="sened-draw3d" data-testid="draw-canvas" role="img" aria-label={canvasLabel} className="absolute left-0 top-0 block h-full w-full" />
      <button
        type="button"
        onClick={() => setLocalKey((k) => k + 1)}
        aria-label={replayLabel}
        className="absolute flex h-12 w-12 items-center justify-center rounded-full border-none bg-white/95 text-[#1C1A17]"
        style={{ right: 20, bottom: 10, boxShadow: "0 6px 12px -6px rgba(0,0,0,0.5)" }}
      >
        <Icon name="replay" size={22} />
      </button>
    </div>
  );
}

const WEAVE =
  "repeating-linear-gradient(90deg, rgba(70,34,14,0.16) 0 1px, transparent 1px 7px), repeating-linear-gradient(0deg, rgba(70,34,14,0.38) 0 1.5px, transparent 1.5px 6px), repeating-linear-gradient(0deg, rgba(255,236,190,0.22) 0 2px, transparent 2px 6px)";
const SHADE = "linear-gradient(90deg, rgba(40,18,6,0.5), rgba(40,18,6,0.05) 28%, rgba(255,240,205,0.28) 46%, rgba(40,18,6,0.05) 64%, rgba(40,18,6,0.55))";
const YARN = "repeating-linear-gradient(90deg, rgba(0,0,0,0.14) 0 1px, transparent 1px 2px), repeating-linear-gradient(0deg, rgba(255,255,255,0.16) 0 1px, transparent 1px 3px)";

function band(top: number, h: number, base: string): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    right: 0,
    top,
    height: h,
    backgroundColor: "#23703F",
    backgroundImage: `radial-gradient(circle at 50% 50%, #E3B23C 0 1.3px, transparent 1.9px), linear-gradient(135deg, ${base} 25%, transparent 25%), linear-gradient(225deg, ${base} 25%, transparent 25%), linear-gradient(315deg, ${base} 25%, transparent 25%), linear-gradient(45deg, ${base} 25%, transparent 25%)`,
    backgroundSize: "10px 10px"
  };
}

/** The CSS-only mesob ceremony. */
function Fallback({ winnerName }: { readonly winnerName: string }) {
  return (
    <div style={{ position: "relative", width: 250, height: 232 }}>
      <span style={{ position: "absolute", left: 14, right: 14, bottom: 0, height: 26, borderRadius: "50%", background: "radial-gradient(ellipse at center, rgba(0,0,0,0.5), rgba(0,0,0,0) 70%)", filter: "blur(3px)" }} />
      <span style={{ position: "absolute", left: 75, bottom: 8, width: 100, height: 14, borderRadius: "4px 4px 9px 9px", background: "#4A2A14" }} />
      <span style={{ position: "absolute", left: 62, bottom: 20, width: 126, height: 58, clipPath: "polygon(36% 0, 64% 0, 62% 30%, 70% 62%, 100% 100%, 0 100%, 30% 62%, 38% 30%)", backgroundColor: "#B98A52", backgroundImage: WEAVE }}>
        <span style={{ position: "absolute", inset: 0, background: SHADE }} />
      </span>
      <span style={{ position: "absolute", left: 30, bottom: 74, width: 190, height: 64, clipPath: "polygon(0 0, 100% 0, 90% 100%, 10% 100%)", backgroundColor: "#C99A5E", backgroundImage: WEAVE }}>
        <span style={band(18, 20, "#C99A5E")} />
        <span style={{ position: "absolute", left: 0, right: 0, top: 18, height: 20, backgroundImage: YARN }} />
        <span style={{ position: "absolute", inset: 0, background: SHADE }} />
      </span>
      <div id="fb-lid" className="fb-lid fb-a" style={{ position: "absolute", left: 0, top: 0, width: 250, height: 232 }}>
        <span style={{ position: "absolute", left: 24, bottom: 124, width: 202, height: 15, borderRadius: 8, background: "linear-gradient(180deg, #A92B22, #7C221C)" }} />
        <span style={{ position: "absolute", left: 36, bottom: 136, width: 178, height: 84, borderRadius: "89px 89px 6px 6px / 84px 84px 6px 6px", overflow: "hidden", backgroundColor: "#D2A468", backgroundImage: WEAVE }}>
          <span style={band(46, 18, "#D2A468")} />
          <span style={{ position: "absolute", left: 0, right: 0, top: 46, height: 18, backgroundImage: YARN }} />
          <span style={{ position: "absolute", inset: 0, background: SHADE }} />
        </span>
        <span style={{ position: "absolute", left: 112, bottom: 214, width: 26, height: 16, borderRadius: "13px 13px 4px 4px", background: "linear-gradient(90deg, #6B3A1F, #A8704A 50%, #5A2F18)" }} />
      </div>
      <span className="fb-sw fb-a" style={{ animationDelay: "1900ms" }} />
      <span className="fb-sw fb-a" style={{ animationDelay: "2250ms", left: 118 }} />
      <span className="fb-sw fb-a" style={{ animationDelay: "2600ms", left: 106 }} />
      <div className="fb-slip fb-a">
        <div className="fb-paper fb-a">
          <span style={{ position: "absolute", left: 12, right: 12, top: 14, height: 1.5, background: "#E3B23C" }} />
          <span style={{ position: "absolute", left: 12, right: 12, bottom: 14, height: 1.5, background: "#E3B23C" }} />
          <span lang="am" className="fb-ink fb-a">
            {winnerName}
          </span>
        </div>
      </div>
    </div>
  );
}
