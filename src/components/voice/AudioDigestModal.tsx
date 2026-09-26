"use client";

import React, { useState, useEffect } from "react";
import { X, Play, Pause, RotateCcw, Volume2, Sparkles } from "lucide-react";

interface AudioDigestModalProps {
  isOpen: boolean;
  onClose: () => void;
  potBalance?: number;
  contributedCount?: number;
  totalMembers?: number;
}

export function AudioDigestModal({
  isOpen,
  onClose,
  potBalance = 175000,
  contributedCount = 17,
  totalMembers = 20,
}: AudioDigestModalProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const digestScript = `«እንደምን ዋሉ የቦሌ መድኃኔዓለም እቁብ አባላትና ሰብሳቢ። የዛሬው ሳምንታዊ ሒሳብ ሪፖርት እንደሚከተለው ቀርቧል፦ እስከ አሁን 17 አባላት ድርሻቸውን በቴሌብር እና በኢትዮጵያ ንግድ ባንክ አስገብተዋል። በደብተር ላይ የተመዘገበው ጠቅላላ የገንዘብ መጠን 175,000 ብር ደርሷል። ያልከፈሉ 3 አባላት ብቻ ይቀራሉ። ቀጣይ እጣ እሁድ ጠዋት 10:00 ሰዓት በመሶብ እጣ አወጣጥ ደንብ ይከናወናል። አመሰግናለሁ።»`;

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPlaying) {
      interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            setIsPlaying(false);
            return 100;
          }
          return prev + 2;
        });
      }, 200);
    }
    return () => clearInterval(interval);
  }, [isPlaying]);

  useEffect(() => {
    if (isOpen) {
      setIsPlaying(true);
      setProgress(0);
    } else {
      setIsPlaying(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const togglePlay = () => setIsPlaying(!isPlaying);
  const restart = () => {
    setProgress(0);
    setIsPlaying(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm animate-fadeIn select-none">
      <div className="relative w-full max-w-md bg-coffee-900 border border-gold-500/40 rounded-t-3xl sm:rounded-3xl p-6 text-parchment-50 shadow-2xl overflow-hidden">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="ዝጋ (Close)"
          className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center bg-coffee-800 text-parchment-200 hover:text-white active:scale-90 transition-all"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="text-center mb-4">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gold-500/20 text-gold-300 border border-gold-500/30 text-xs font-bold mb-2">
            <Volume2 className="w-3.5 h-3.5 text-gold-400" />
            Voxide አድምጥ (Spoken TTS Digest)
          </div>
          <h2 className="text-xl font-bold font-ethiopic text-parchment-50">
            የሳምንቱ የሒሳብ ሪፖርት ድምፅ
          </h2>
          <p className="text-xs text-parchment-300">
            ለዕቁብ አባላትና ለአረጋውያን ሰብሳቢዎች የተዘጋጀ አጭር ሪፖርት
          </p>
        </div>

        {/* Waveform Equalizer Display */}
        <div className="p-4 rounded-2xl bg-coffee-950 border border-coffee-800 flex flex-col items-center justify-center gap-3 my-4">
          <div className="flex items-end justify-center gap-1.5 h-12 w-full px-6">
            {[40, 75, 55, 90, 30, 85, 60, 95, 45, 70, 80, 50, 65, 88, 35].map((h, i) => (
              <span
                key={i}
                className="w-1.5 bg-gradient-to-t from-terracotta-500 to-gold-400 rounded-full transition-all duration-150"
                style={{
                  height: isPlaying ? `${Math.max(12, (h * Math.sin((progress + i * 10) * 0.1) + h) / 2)}%` : "15%",
                }}
              />
            ))}
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-coffee-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-gold-400 h-full transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="w-full flex items-center justify-between text-[11px] font-mono text-parchment-300">
            <span>00:{(Math.round((progress / 100) * 12)).toString().padStart(2, "0")}</span>
            <span className="text-gold-400 font-semibold font-ethiopic">
              {isPlaying ? "እየተደመጠ ነው" : progress >= 100 ? "ተጠናቋል" : "ቆሟል"}
            </span>
            <span>00:12</span>
          </div>
        </div>

        {/* Spoken Text Script (High-contrast for older eyes) */}
        <div className="p-4 rounded-2xl bg-parchment-100 text-coffee-950 border border-parchment-300 shadow-inner mb-5 max-h-36 overflow-y-auto">
          <p className="text-xs sm:text-sm font-medium font-ethiopic leading-relaxed">
            {digestScript}
          </p>
        </div>

        {/* Playback Controls */}
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={restart}
            aria-label="እንደገና አጫውት (Replay)"
            className="w-11 h-11 rounded-full flex items-center justify-center bg-coffee-800 hover:bg-coffee-700 text-parchment-200 active:scale-90 transition-all"
          >
            <RotateCcw className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "አቁም (Pause)" : "አጫውት (Play)"}
            className="w-16 h-16 rounded-full flex items-center justify-center bg-gradient-to-tr from-terracotta-500 to-gold-400 text-coffee-950 shadow-mic border-2 border-gold-300 active:scale-90 transition-all"
          >
            {isPlaying ? (
              <Pause className="w-7 h-7 fill-coffee-950" />
            ) : (
              <Play className="w-7 h-7 fill-coffee-950 ml-1" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
