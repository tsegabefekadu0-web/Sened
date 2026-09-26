"use client";

import React, { useState, useEffect } from "react";
import { X, Mic, CheckCircle2, ShieldAlert, Sparkles, RefreshCw } from "lucide-react";

interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddContribution?: (data: {
    name: string;
    amharicName: string;
    amount: number;
    channel: "Telebirr" | "CBE Birr";
    txRef: string;
  }) => void;
}

export function VoiceModal({ isOpen, onClose, onAddContribution }: VoiceModalProps) {
  const [isListening, setIsListening] = useState(true);
  const [transcript, setTranscript] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedSuccess, setVerifiedSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsListening(true);
      setIsVerifying(false);
      setVerifiedSuccess(false);
      setTranscript("");

      // Simulated realistic speech stream in Amharic
      const timer1 = setTimeout(() => {
        setTranscript("«ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ...»");
      }, 900);

      const timer2 = setTimeout(() => {
        setTranscript(
          "«ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ የክፍያው ቁጥር 9BF42A6 ነው»"
        );
        setIsListening(false);
      }, 2400);

      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleVerify = () => {
    setIsVerifying(true);
    setTimeout(() => {
      setIsVerifying(false);
      setVerifiedSuccess(true);

      setTimeout(() => {
        onAddContribution?.({
          name: "Solomon Tadesse",
          amharicName: "ሰለሞን ታደሰ",
          amount: 5000,
          channel: "Telebirr",
          txRef: "9BF42A6",
        });
        onClose();
      }, 1200);
    }, 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm animate-fadeIn select-none">
      <div className="relative w-full max-w-md bg-coffee-900 border border-coffee-700/80 rounded-t-3xl sm:rounded-3xl p-6 text-parchment-50 shadow-2xl overflow-hidden">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="ዝጋ (Close)"
          className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center bg-coffee-800 text-parchment-200 hover:text-white active:scale-90 transition-all"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Title */}
        <div className="text-center mb-5">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-terracotta-500/20 text-terracotta-400 border border-terracotta-500/30 text-xs font-bold mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            Voxide የድምፅ ማስተናገጃ (Voice STT)
          </div>
          <h2 className="text-xl font-bold font-ethiopic text-parchment-50">
            በድምጽ ክፍያ መመዝገቢያ
          </h2>
          <p className="text-xs text-parchment-300 mt-0.5">
            የተከፈለበትን ባንክ፣ መጠን እና የደረሰኝ ቁጥር ይናገሩ
          </p>
        </div>

        {/* Microphone Soundwave Animation Area */}
        <div className="flex flex-col items-center justify-center py-6">
          <div className="relative flex items-center justify-center">
            {isListening && (
              <>
                <span className="absolute w-28 h-28 rounded-full bg-terracotta-500/20 animate-ping" />
                <span className="absolute w-24 h-24 rounded-full bg-terracotta-500/30 animate-pulse" />
              </>
            )}
            <div
              className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center shadow-mic border-4 ${
                isListening
                  ? "bg-terracotta-500 border-gold-400 text-white animate-pulse"
                  : "bg-coffee-800 border-coffee-700 text-gold-400"
              }`}
            >
              <Mic className="w-9 h-9" />
            </div>
          </div>

          <p className="text-xs font-semibold text-gold-400 mt-4 font-ethiopic">
            {isListening ? "ድምጽዎን እያዳመጥን ነው..." : "ንግግሩ ተቀርጿል"}
          </p>
        </div>

        {/* Live Speech Transcription Box */}
        <div className="p-3.5 rounded-2xl bg-coffee-950 border border-coffee-800 text-center mb-4 min-h-[64px] flex items-center justify-center">
          <p className="text-sm font-medium text-parchment-200 font-ethiopic leading-relaxed">
            {transcript || "እባክዎ ይናገሩ..."}
          </p>
        </div>

        {/* Extracted Entity Preview (Zero-Trust) */}
        {!isListening && transcript && (
          <div className="p-3.5 rounded-2xl bg-coffee-800/60 border border-gold-500/30 mb-5 space-y-2 text-xs">
            <div className="flex items-center justify-between text-parchment-300">
              <span>አባል:</span>
              <strong className="text-parchment-100">ሰለሞን ታደሰ (Solomon T.)</strong>
            </div>
            <div className="flex items-center justify-between text-parchment-300">
              <span>የተከፈለ መጠን:</span>
              <strong className="text-emerald-400 font-sans text-sm font-bold">5,000 ETB</strong>
            </div>
            <div className="flex items-center justify-between text-parchment-300">
              <span>የክፍያ መስመር:</span>
              <strong className="text-parchment-100">Telebirr (ቴሌብር)</strong>
            </div>
            <div className="flex items-center justify-between text-parchment-300">
              <span>የደረሰኝ ቁጥር (Ref):</span>
              <strong className="text-gold-400 font-mono">9BF42A6</strong>
            </div>
          </div>
        )}

        {/* Verification & Action Trigger */}
        <div className="space-y-2">
          {!verifiedSuccess ? (
            <button
              type="button"
              disabled={isListening || isVerifying}
              onClick={handleVerify}
              className={`w-full py-3.5 rounded-2xl font-bold font-ethiopic flex items-center justify-center gap-2 shadow-lg transition-all duration-150 ${
                isListening || isVerifying
                  ? "bg-coffee-800 text-parchment-400 cursor-not-allowed opacity-60"
                  : "bg-gradient-to-r from-terracotta-500 to-gold-500 text-coffee-950 hover:brightness-105 active:scale-95"
              }`}
            >
              {isVerifying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin text-coffee-950" />
                  <span>በLinks.et ባንክ በማረጋገጥ ላይ...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 text-coffee-950" />
                  <span>በLinks.et አረጋግጥና አስመዝግብ</span>
                </>
              )}
            </button>
          ) : (
            <div className="w-full py-3.5 rounded-2xl bg-emerald-600 text-white font-bold font-ethiopic flex items-center justify-center gap-2 shadow-lg">
              <CheckCircle2 className="w-5 h-5 text-white stroke-[2.5]" />
              <span>ክፍያው በባንክ ተረጋግጦ ደብተር ላይ ሰፍሯል!</span>
            </div>
          )}

          <p className="text-[10px] text-center text-parchment-400 flex items-center justify-center gap-1">
            <ShieldAlert className="w-3 h-3 text-gold-400" />
            የድምፅ ግቤት ብቻውን አይመዘገብም፤ Links.et ከባንክ ጋር ሳያረጋግጥ ገንዘብ አይገባም።
          </p>
        </div>
      </div>
    </div>
  );
}
