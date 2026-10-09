/* eslint-disable @next/next/no-img-element */
import React from "react";

/** The large profile portrait: woven ring around the member's photo, or a warm clay disc with their initial. */
export function ProfileAvatar({ initial, photo, size }: { readonly initial: string; readonly photo: string | null; readonly size: number }) {
  return (
    <span
      aria-hidden="true"
      className="snd-conic block"
      style={{ width: size, height: size, padding: size > 100 ? 5 : 3.5, boxSizing: "border-box", borderRadius: "50%", boxShadow: "0 2px 5px -1px rgba(0,0,0,0.4)", filter: "var(--ringf)" }}
    >
      {photo ? (
        <img src={photo} alt="" className="block h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full"
          style={{
            backgroundImage: "radial-gradient(circle at 34% 26%, #EAD0A8 0%, #C9996A 48%, #8A5B3A 100%)",
            boxShadow: "inset 0 -10px 18px rgba(60,30,10,0.35), inset 0 6px 10px rgba(255,235,205,0.25)"
          }}
        >
          <span lang="am" className="font-serif font-bold text-white" style={{ fontSize: Math.round(size * 0.42), textShadow: "0 2px 8px rgba(60,30,10,0.45)" }}>
            {initial}
          </span>
        </span>
      )}
    </span>
  );
}
