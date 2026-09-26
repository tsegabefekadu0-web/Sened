import React from "react";

/**
 * Traditional Ethiopian Mesob (መሶብ) Woven Basket Icon
 * Rendered with authentic traditional geometry matching the reference image
 */
export function MesobIcon({ className = "w-14 h-16" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 54 62"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="mesobStraw" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F6D582" />
          <stop offset="50%" stopColor="#D4A244" />
          <stop offset="100%" stopColor="#B38228" />
        </linearGradient>
        <linearGradient id="mesobTerracotta" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E06438" />
          <stop offset="100%" stopColor="#A83917" />
        </linearGradient>
        <filter id="mesobShadow" x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.4" />
        </filter>
      </defs>

      <g filter="url(#mesobShadow)">
        {/* Crown Knob */}
        <circle cx="27" cy="6" r="3.2" fill="#F6D582" stroke="#863214" strokeWidth="1" />
        <path d="M24.5 9H29.5L30.5 13H23.5L24.5 9Z" fill="url(#mesobTerracotta)" />

        {/* Conical Lid Top */}
        <path
          d="M23.5 13H30.5L38 28H16L23.5 13Z"
          fill="url(#mesobStraw)"
          stroke="#5C260D"
          strokeWidth="1.2"
        />

        {/* Woven Lid Diamonds (Terracotta & Green) */}
        <polygon points="27,15 31,21 27,27 23,21" fill="url(#mesobTerracotta)" />
        <polygon points="19,23 23,27 19,28 17,25" fill="#16A34A" />
        <polygon points="35,23 37,25 35,28 31,27" fill="#16A34A" />

        {/* Lid Lip / Rim */}
        <rect
          x="15"
          y="28"
          width="24"
          height="3.5"
          rx="1"
          fill="#863214"
          stroke="#F6D582"
          strokeWidth="0.8"
        />

        {/* Mesob Drum Body */}
        <path
          d="M16 31.5H38L35.5 49H18.5L16 31.5Z"
          fill="url(#mesobStraw)"
          stroke="#5C260D"
          strokeWidth="1.2"
        />

        {/* Body Woven Geometry Bands */}
        <polygon points="27,33 32,40 27,47 22,40" fill="url(#mesobTerracotta)" />
        <polygon points="18.5,35 22,40 18.5,46 17,40" fill="#16A34A" />
        <polygon points="35.5,35 37,40 35.5,46 32,40" fill="#16A34A" />

        {/* Flared Pedestal Base */}
        <path
          d="M19 49H35L38 56H16L19 49Z"
          fill="url(#mesobTerracotta)"
          stroke="#5C260D"
          strokeWidth="1.2"
        />
        <rect x="15" y="56" width="24" height="2" fill="#D4A244" rx="0.5" />
      </g>
    </svg>
  );
}
