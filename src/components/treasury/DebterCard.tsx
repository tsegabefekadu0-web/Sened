"use client";

import React from "react";
import Image from "next/image";

interface DebterCardProps {
  potBalance: number;
  onDrawClick?: () => void;
}

export function DebterCard({
  potBalance = 175000,
  onDrawClick,
}: DebterCardProps) {
  return (
    <div className="relative w-full max-w-md mx-auto pt-7 pb-2 px-4 select-none">
      {/* Horizontal Carousel Container: Main Debter Card + Peek Card */}
      <div className="relative flex items-stretch gap-2.5">
        {/* Main Saddle Leather Debter Card */}
        <div
          onClick={onDrawClick}
          className="relative flex-1 rounded-[22px] p-5 bg-gradient-to-br from-[#2D211B] via-[#241A14] to-[#1E1510] shadow-[0_12px_28px_-6px_rgba(28,20,16,0.35)] cursor-pointer active:scale-[0.99] transition-transform overflow-hidden border border-[#443226]/50 group"
          role="button"
          tabIndex={0}
          aria-label="ደብተር የገንዘብ መጠን እና ቀጣይ እጣ"
        >
          {/* Subtle Leather Texture Highlight */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.06] via-transparent to-black/40 pointer-events-none" />

          {/* Outer Perimeter Stitched Border */}
          <div className="absolute inset-1.5 rounded-[17px] border border-dashed border-[#967352]/40 pointer-events-none" />

          {/* Left Spine Double Stitched Line (Booklet Binding Look) */}
          <div className="absolute left-3.5 top-1.5 bottom-1.5 w-2 border-r border-dashed border-[#967352]/40 pointer-events-none" />

          {/* Top-Right Corner: Diagonal Woven Tibeb Ribbon Straps */}
          <div className="absolute top-0 right-0 w-24 h-24 overflow-hidden pointer-events-none select-none">
            {/* Ribbon 1: Gold & Terracotta Band */}
            <div className="w-32 h-3.5 bg-gradient-to-r from-[#9C2712] via-[#D4A244] to-[#9C2712] rotate-45 transform translate-x-5 translate-y-3.5 flex items-center justify-around px-2 shadow-sm border-y border-[#F6D582]/40">
              <span className="w-1.5 h-1.5 bg-[#1C1410] rotate-45 block" />
              <span className="w-1.5 h-1.5 bg-[#FAF6F0] rotate-45 block" />
              <span className="w-1.5 h-1.5 bg-[#1C1410] rotate-45 block" />
            </div>
            {/* Ribbon 2: Parallel Thin Band */}
            <div className="w-32 h-1.5 bg-[#D4A244] rotate-45 transform translate-x-5 translate-y-7 shadow-xs opacity-80" />
          </div>

          {/* Card Body Content: Left Column (Balance) & Right Column (Mesob) */}
          <div className="relative z-10 flex items-center justify-between pl-3 pr-1 py-1">
            {/* Left Column: Debter Title + Pot Balance */}
            <div className="flex-1 min-w-0 pr-2">
              <h2 className="text-2xl sm:text-[26px] font-black text-[#F7F2EB] tracking-wide font-ethiopic drop-shadow-xs">
                ደብተር
              </h2>
              <div className="w-40 h-[1px] bg-[#533E32] mt-1 mb-3.5" />

              <p className="text-xs font-medium text-[#B8A799] tracking-normal font-sans">
                Pot balance
              </p>

              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-2xl sm:text-[30px] font-black text-white tracking-tight font-sans">
                  {potBalance.toLocaleString()}
                </span>
                <span className="text-lg sm:text-xl font-extrabold text-white font-ethiopic">
                  ብር
                </span>
              </div>
            </div>

            {/* Right Column: 3D Woven Mesob Basket + ቀጣይ እጣ */}
            <div className="shrink-0 flex flex-col items-center justify-center pl-2">
              <div className="relative w-16 h-20 hover:scale-105 active:scale-95 transition-transform cursor-pointer">
                <Image
                  src="/reference_assets/mesob_3d_clean.png"
                  alt="ቀጣይ እጣ መሶብ"
                  fill
                  sizes="64px"
                  priority
                  className="object-contain drop-shadow-md"
                />
              </div>
              <span className="text-[12px] sm:text-[13px] font-bold text-[#DDD5CC] font-ethiopic tracking-wide mt-0.5 drop-shadow-xs">
                ቀጣይ እጣ
              </span>
            </div>
          </div>
        </div>

        {/* Peek Card on Right: Authentic Carousel Affordance */}
        <div className="w-4 shrink-0 rounded-l-[20px] bg-gradient-to-r from-[#2D211B] to-[#1E1510] border-l border-y border-dashed border-[#967352]/35 shadow-md relative overflow-hidden self-stretch opacity-90">
          <div className="absolute top-0 right-0 w-8 h-8 bg-gradient-to-r from-[#9C2712] to-[#D4A244] rotate-45 transform translate-x-2 -translate-y-2 opacity-70" />
        </div>
      </div>

      {/* Centered Pagination Indicator Dots (— · ·) */}
      <div className="flex justify-center items-center gap-1.5 mt-2.5">
        <span className="w-6 h-1.5 rounded-full bg-[#8A5E3D] shadow-xs" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#D1C4B8]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#D1C4B8]" />
      </div>
    </div>
  );
}
