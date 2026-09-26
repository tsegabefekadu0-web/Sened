"use client";

import React from "react";
import {
  MeskelCross,
  DiamondMedallion,
  VerticalTibebBorder,
  ScallopedPlaque,
} from "@/components/cultural/CulturalIcons";

interface HeaderProps {
  onOpenDigest: () => void;
  isPlayingAudio?: boolean;
}

export function Header({ onOpenDigest, isPlayingAudio = false }: HeaderProps) {
  return (
    <header className="relative w-full bg-[#1C1410] pt-7 pb-8 px-5 select-none shrink-0 shadow-md">
      {/* Left and Right Vertical Tibeb Embroidery Ribbon Borders */}
      <div className="absolute left-1 top-0 bottom-0 w-3.5 overflow-hidden pointer-events-none opacity-85">
        <VerticalTibebBorder className="w-full h-full" />
      </div>
      <div className="absolute right-1 top-0 bottom-0 w-3.5 overflow-hidden pointer-events-none opacity-85">
        <VerticalTibebBorder className="w-full h-full" />
      </div>

      {/* Top Ornamental Row: Meskel Cross, Diamond Medallion & Audio Pill */}
      <div className="relative z-10 flex items-center justify-between px-3 pt-1">
        {/* Left: Ethiopian Meskel Cross */}
        <div className="w-9 h-9 flex items-center justify-center">
          <MeskelCross className="w-8 h-8 drop-shadow-sm" />
        </div>

        {/* Center: Traditional Diamond Embroidery Medallion */}
        <div className="flex-1 flex justify-center items-center px-1">
          <DiamondMedallion className="w-24 sm:w-28 h-8 drop-shadow-sm" />
        </div>

        {/* Right: Audio Pill Button (🔊 አድምጥ) */}
        <button
          type="button"
          onClick={onOpenDigest}
          aria-label="አድምጥ (Listen to audio digest)"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-[#D4A244] bg-[#271C15] text-[#F3E2B8] hover:bg-[#D4A244]/20 active:scale-95 transition-all text-xs font-semibold focus:outline-none shadow-xs cursor-pointer"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-3.5 h-3.5 text-[#D4A244]"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 010 7.07l-1.41-1.41a3 3 0 000-4.24l1.41-1.42z" />
          </svg>
          <span className="font-ethiopic font-bold text-xs tracking-wide">አድምጥ</span>
        </button>
      </div>

      {/* Center Main Community Title */}
      <div className="relative z-10 text-center mt-3.5 mb-2">
        <h1 className="text-xl sm:text-[22px] font-extrabold text-[#F7F2EB] tracking-wide font-ethiopic drop-shadow-xs">
          የቦሌ መድኃኔዓለም እቁብ
        </h1>
      </div>

      {/* Bottom Center Scalloped Arch Plaque (🔊 አድምጥ) overlapping the seam */}
      <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 z-20">
        <ScallopedPlaque
          title="አድምጥ"
          onClick={onOpenDigest}
          isPlaying={isPlayingAudio}
        />
      </div>
    </header>
  );
}
