"use client";

import { useEffect } from "react";

/**
 * Tactile press for every button and link: a scale/brightness dip (values per
 * target size), a short haptic tick, and a radial bloom from the touch point.
 * Mounted once in the root layout. Skipped for `prefers-reduced-motion`
 * (bloom and scale) and for switches and tabs (`data-nobloom`, `.snd-tab`).
 */
export function PressFeedback() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const el = target?.closest?.("button, a[href], [data-press]") as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
      try {
        navigator.vibrate?.(10);
      } catch {
        // No vibration support.
      }
      const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      const r = el.getBoundingClientRect();
      const row = r.height >= 72 && r.width > 200;
      const small = r.width <= 52 && r.height <= 52;
      el.style.setProperty("--snd-s", String(rm ? 1 : row ? 0.985 : small ? 0.92 : 0.96));
      el.style.setProperty("--snd-f", row ? "0.97" : "0.94");
      const cs = getComputedStyle(el);
      let prevShadow: string | null = null;
      if (!rm && cs.boxShadow && cs.boxShadow !== "none") {
        prevShadow = el.style.boxShadow;
        el.style.boxShadow = "0 2px 5px -3px rgba(0,0,0,0.5)";
      }
      const restore = () => {
        if (prevShadow !== null) el.style.boxShadow = prevShadow;
        window.removeEventListener("pointerup", restore, true);
        window.removeEventListener("pointercancel", restore, true);
      };
      window.addEventListener("pointerup", restore, true);
      window.addEventListener("pointercancel", restore, true);
      if (rm || el.hasAttribute("data-nobloom") || el.classList.contains("snd-tab")) return;
      const pos = cs.position;
      const ov = el.style.overflow;
      const po = el.style.position;
      if (pos === "static") el.style.position = "relative";
      el.style.overflow = "hidden";
      const d = Math.max(r.width, r.height) * 1.7;
      const b = document.createElement("span");
      b.setAttribute("aria-hidden", "true");
      b.setAttribute("data-snd-bloom", "1");
      b.style.cssText = `position:absolute;pointer-events:none;border-radius:50%;width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px;background:radial-gradient(circle, color-mix(in srgb, currentColor 24%, transparent) 0%, transparent 68%);transform:scale(0);opacity:0;`;
      el.appendChild(b);
      if (!b.animate) {
        b.remove();
        return;
      }
      const a = b.animate([{ transform: "scale(0)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], {
        duration: 360,
        easing: "cubic-bezier(.2,.8,.2,1)"
      });
      a.onfinish = () => {
        b.remove();
        el.style.overflow = ov;
        el.style.position = po;
      };
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
  return null;
}
