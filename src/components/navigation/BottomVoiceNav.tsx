"use client";

import React, { useMemo } from "react";
import { Home, BookOpen, Users, User, Mic } from "lucide-react";

import { createTranslator, type Locale } from "@/lib/i18n";

interface BottomVoiceNavProps {
  activeTab: "home" | "ledger" | "members" | "profile";
  onTabChange: (tab: "home" | "ledger" | "members" | "profile") => void;
  onVoiceClick: () => void;
  /** Ge'ez-primary, so `am` by default — see `DebterCard`. */
  locale?: Locale;
}

export function BottomVoiceNav({
  activeTab = "home",
  onTabChange,
  onVoiceClick,
  locale = "am"
}: BottomVoiceNavProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  return (
    <nav className="relative z-30 select-none w-full shrink-0 pointer-events-auto">
      {/* SVG Background with Smooth Arched Cutout and Gold Top Rim */}
      <div className="relative w-full h-[96px] flex flex-col justify-end bg-transparent">
        <svg
          viewBox="0 0 420 96"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="absolute inset-0 w-full h-full pointer-events-none drop-shadow-[0_-6px_14px_rgba(0,0,0,0.35)]"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="navGoldRim" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#C89736" />
              <stop offset="50%" stopColor="#F9DF98" />
              <stop offset="100%" stopColor="#C89736" />
            </linearGradient>
          </defs>

          {/* Dark Ethiopian Coffee Dock Body */}
          <path
            d="M 0 30 
               L 142 30 
               C 166 30, 175 6, 210 6 
               C 245 6, 254 30, 278 30 
               L 420 30 
               L 420 96 
               L 0 96 Z"
            fill="#1A1412"
          />

          {/* Top Gold Rim Contour */}
          <path
            d="M 0 30 
               L 142 30 
               C 166 30, 175 6, 210 6 
               C 245 6, 254 30, 278 30 
               L 420 30"
            stroke="url(#navGoldRim)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>

        {/* Elevated Circular Terracotta Microphone Button */}
        <div className="absolute left-1/2 -translate-x-1/2 top-[-2px] z-40 flex flex-col items-center">
          <button
            type="button"
            onClick={onVoiceClick}
            aria-label={t("shell.nav.voiceAria")}
            className="w-[64px] h-[64px] rounded-full p-1 bg-[#1A1412] shadow-2xl hover:scale-105 active:scale-90 transition-all focus:outline-none group cursor-pointer"
            title={t("shell.nav.voiceAria")}
          >
            {/* Outer Gold Ring + Terracotta Center */}
            <div className="w-full h-full rounded-full p-[2.5px] bg-gradient-to-b from-[#F7DF94] via-[#D4A244] to-[#9E6E1E] shadow-inner flex items-center justify-center">
              <div className="w-full h-full rounded-full bg-gradient-to-b from-[#D4592F] to-[#9C3214] flex items-center justify-center text-white shadow-md group-hover:brightness-110 transition-all">
                <Mic className="w-6 h-6 stroke-[2.5] text-[#FAF5EB] drop-shadow-sm" />
              </div>
            </div>
          </button>
        </div>

        {/* 4 Interactive Navigation Slots */}
        <div className="relative z-20 flex items-center justify-between px-7 pt-4 pb-1">
          {/* Slot 1: Home Tab */}
          <button
            type="button"
            onClick={() => onTabChange("home")}
            className="flex flex-col items-center justify-center w-12 py-1 text-[#D4A244] active:scale-90 transition-transform focus:outline-none cursor-pointer"
            aria-label={t("shell.nav.home")}
          >
            <Home className="w-5 h-5 stroke-[2.2]" />
            {activeTab === "home" && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4A244] mt-1 shadow-xs" />
            )}
          </button>

          {/* Slot 2: Ledger / Debter Tab */}
          <button
            type="button"
            onClick={() => onTabChange("ledger")}
            className="flex flex-col items-center justify-center w-12 py-1 text-[#9E8E80] hover:text-[#D4A244] active:scale-90 transition-transform focus:outline-none cursor-pointer"
            aria-label={t("shell.nav.ledger")}
          >
            <BookOpen className="w-5 h-5 stroke-[2]" />
            {activeTab === "ledger" && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4A244] mt-1 shadow-xs" />
            )}
          </button>

          {/* Center Gap for Microphone */}
          <div className="w-14" />

          {/* Slot 3: Community / Members Tab */}
          <button
            type="button"
            onClick={() => onTabChange("members")}
            className="flex flex-col items-center justify-center w-12 py-1 text-[#9E8E80] hover:text-[#D4A244] active:scale-90 transition-transform focus:outline-none cursor-pointer"
            aria-label={t("shell.nav.members")}
          >
            <Users className="w-5 h-5 stroke-[2]" />
            {activeTab === "members" && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4A244] mt-1 shadow-xs" />
            )}
          </button>

          {/* Slot 4: Profile Tab */}
          <button
            type="button"
            onClick={() => onTabChange("profile")}
            className="flex flex-col items-center justify-center w-12 py-1 text-[#9E8E80] hover:text-[#D4A244] active:scale-90 transition-transform focus:outline-none cursor-pointer"
            aria-label={t("shell.nav.profile")}
          >
            <User className="w-5 h-5 stroke-[2]" />
            {activeTab === "profile" && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4A244] mt-1 shadow-xs" />
            )}
          </button>
        </div>

        {/* Subtle iOS Home Indicator Bar */}
        <div className="relative z-20 pb-2">
          <div className="w-28 h-1 bg-white/70 rounded-full mx-auto" />
        </div>
      </div>
    </nav>
  );
}
