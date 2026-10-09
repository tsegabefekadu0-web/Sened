"use client";

import React, { useEffect, useRef, useState } from "react";

/** Fades and lifts its children in once, when scrolled into view. Instant under reduced motion. */
export function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div"
}: {
  readonly children: React.ReactNode;
  readonly delay?: number;
  readonly className?: string;
  readonly as?: "div" | "section" | "li" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduce || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(18px)",
        transition: `opacity var(--snd-d4) var(--snd-emph) ${delay}ms, transform var(--snd-d4) var(--snd-emph) ${delay}ms`
      }}
    >
      {children}
    </Tag>
  );
}

/** Mounts its children only once it has scrolled near the viewport (for the 3D showpiece). */
export function WhenVisible({ children, minHeight = 0 }: { readonly children: React.ReactNode; readonly minHeight?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOn(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ minHeight }}>
      {on ? children : null}
    </div>
  );
}
