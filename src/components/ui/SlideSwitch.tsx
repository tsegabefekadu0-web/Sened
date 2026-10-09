"use client";

import React, { useRef, useState } from "react";

/**
 * The two-sided slide switch: a woven-ring knob on a recessed track, tap or drag.
 * `role="switch"`; checked = the right-hand side. Labels sit either side and are
 * tappable too. `onGreen` is for use on the brand header.
 */
export function SlideSwitch({
  checked,
  onChange,
  label,
  left,
  right,
  onGreen = false,
  compact = false,
  disabled = false,
  id
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly left: React.ReactNode;
  readonly right: React.ReactNode;
  readonly onGreen?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const skip = useRef(false);
  const f = drag ?? (checked ? 1 : 0);

  const toggle = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (skip.current || disabled) return;
    onChange(!checked);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const startX = e.clientX;
    const startOn = checked ? 1 : 0;
    let moved = false;
    let cur = startOn;
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) > 4) moved = true;
      if (moved) {
        cur = Math.min(1, Math.max(0, startOn + dx / 28));
        setDrag(cur);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPressed(false);
      setDrag(null);
      if (moved) {
        skip.current = true;
        setTimeout(() => {
          skip.current = false;
        }, 80);
        const next = cur > 0.5;
        if (next !== checked) onChange(next);
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    setPressed(true);
  };

  const dragging = drag !== null;
  const labelCls = `flex items-center gap-1.5 whitespace-nowrap text-[15px] transition-colors duration-300 ${compact ? "" : "min-w-[78px]"}`;
  const act = onGreen ? "font-bold text-white" : "font-bold text-ink";
  const idle = onGreen ? "font-semibold text-white/85" : "font-semibold text-muted";
  const trackBg = onGreen
    ? f > 0.5
      ? "rgba(255,255,255,0.42)"
      : "rgba(0,0,0,0.30)"
    : `color-mix(in srgb, var(--swon) ${Math.round(f * 100)}%, var(--swoff))`;

  return (
    <span
      onClick={() => {
        if (skip.current || disabled) return;
        onChange(!checked);
      }}
      className="flex cursor-pointer items-center gap-2"
    >
      <span lang="am" className={`${labelCls} ${compact ? "" : "justify-end"} ${f < 0.5 ? act : idle}`}>
        {left}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        data-nobloom="1"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={toggle}
        onPointerDown={onPointerDown}
        className="flex shrink-0 items-center justify-center p-0"
        style={{ width: 76, height: 44, touchAction: "pan-y", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer", background: "none", border: "none" }}
      >
        <span
          className="relative block"
          style={{
            width: 64,
            height: 36,
            borderRadius: 18,
            backgroundColor: trackBg,
            boxShadow: "var(--swwell)",
            transition: dragging ? "none" : "background-color 320ms var(--snd-ease)"
          }}
        >
          <span
            className="snd-conic absolute"
            style={{
              left: 4,
              top: 4,
              width: 28,
              height: 28,
              boxSizing: "border-box",
              padding: 1.5,
              borderRadius: "50%",
              transform: `translateX(${f * 28}px) scaleX(${pressed ? 1.1 : 1})`,
              transition: dragging ? "none" : "transform 320ms cubic-bezier(.34,1.56,.64,1)",
              boxShadow: "0 3px 6px rgba(28,26,23,0.40), 0 1px 2px rgba(28,26,23,0.32)"
            }}
          >
            <span
              className="relative block h-full w-full rounded-full"
              style={{
                backgroundImage: "radial-gradient(circle at 34% 26%, #FFFFFF 0%, var(--swface))",
                boxShadow: "inset 0 1.5px 2px rgba(255,255,255,0.95), inset 0 -2px 3px rgba(80,60,30,0.2)"
              }}
            >
              <span
                aria-hidden="true"
                className="absolute"
                style={{
                  left: 4,
                  top: 3,
                  width: 10,
                  height: 5,
                  borderRadius: "50%",
                  backgroundImage: "linear-gradient(rgba(255,255,255,0.95), rgba(255,255,255,0))",
                  transform: "rotate(-24deg)"
                }}
              />
            </span>
          </span>
        </span>
      </button>
      <span lang="am" className={`${labelCls} ${f >= 0.5 ? act : idle}`}>
        {right}
      </span>
    </span>
  );
}
