import React from "react";

/**
 * Authentic Ethiopian Meskel Cross Icon (የመስቀል ጥልፍ)
 */
export function MeskelCross({ className = "w-9 h-9" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="goldMesh" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F7DF94" />
          <stop offset="50%" stopColor="#D4A244" />
          <stop offset="100%" stopColor="#AA7822" />
        </linearGradient>
      </defs>
      {/* Central Diamond Cross */}
      <path
        d="M22 2 L26 10 L34 10 L28 16 L31 24 L22 19 L13 24 L16 16 L10 10 L18 10 Z"
        fill="url(#goldMesh)"
      />
      {/* Intricate Weave Cross Body */}
      <rect x="20" y="4" width="4" height="36" rx="1" fill="url(#goldMesh)" />
      <rect x="4" y="20" width="36" height="4" rx="1" fill="url(#goldMesh)" />
      
      {/* Lattice Openings */}
      <circle cx="22" cy="12" r="1.5" fill="#1C1410" />
      <circle cx="22" cy="32" r="1.5" fill="#1C1410" />
      <circle cx="12" cy="22" r="1.5" fill="#1C1410" />
      <circle cx="32" cy="22" r="1.5" fill="#1C1410" />
      <circle cx="22" cy="22" r="2.2" fill="#FAF6F0" />
      
      {/* Diamond Corner Accents */}
      <polygon points="12,12 14,10 16,12 14,14" fill="url(#goldMesh)" />
      <polygon points="32,12 34,10 36,12 34,14" fill="url(#goldMesh)" />
      <polygon points="12,32 14,30 16,32 14,34" fill="url(#goldMesh)" />
      <polygon points="32,32 34,30 36,32 34,34" fill="url(#goldMesh)" />
    </svg>
  );
}

/**
 * Authentic Center Diamond Embroidery Medallion (የጥልፍ አልማዝ ማዕከል)
 */
export function DiamondMedallion({ className = "w-28 h-10" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="medallionGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F9E29D" />
          <stop offset="100%" stopColor="#C89736" />
        </linearGradient>
      </defs>
      
      {/* Center Large Diamond */}
      <g transform="translate(60, 20)">
        {/* Outer Gold Stepped Border */}
        <polygon points="0,-18 18,0 0,18 -18,0" fill="none" stroke="url(#medallionGold)" strokeWidth="2.5" />
        {/* Terracotta Inner Band */}
        <polygon points="0,-14 14,0 0,14 -14,0" fill="#C6532B" stroke="#9A3814" strokeWidth="1" />
        {/* Center White Diamond with Grid */}
        <polygon points="0,-8 8,0 0,8 -8,0" fill="#FAF6F0" />
        <circle cx="0" cy="0" r="2" fill="#1C1410" />
        
        {/* Stepped Gold Teeth */}
        <circle cx="-16" cy="0" r="1.5" fill="#FAF6F0" />
        <circle cx="16" cy="0" r="1.5" fill="#FAF6F0" />
        <circle cx="0" cy="-16" r="1.5" fill="#FAF6F0" />
        <circle cx="0" cy="16" r="1.5" fill="#FAF6F0" />
      </g>

      {/* Flanking Left Diamond */}
      <g transform="translate(24, 20)">
        <polygon points="0,-11 11,0 0,11 -11,0" fill="none" stroke="url(#medallionGold)" strokeWidth="2" />
        <polygon points="0,-7 7,0 0,7 -7,0" fill="#C6532B" />
        <circle cx="0" cy="0" r="1.5" fill="#FAF6F0" />
      </g>

      {/* Flanking Right Diamond */}
      <g transform="translate(96, 20)">
        <polygon points="0,-11 11,0 0,11 -11,0" fill="none" stroke="url(#medallionGold)" strokeWidth="2" />
        <polygon points="0,-7 7,0 0,7 -7,0" fill="#C6532B" />
        <circle cx="0" cy="0" r="1.5" fill="#FAF6F0" />
      </g>
    </svg>
  );
}

/**
 * Vertical Woven Tibeb Embroidery Border (የጥበብ ዳርቻ ጥልፍ)
 */
export function VerticalTibebBorder({ className = "w-4 h-full" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 260"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <pattern id="tibebUnit" width="16" height="28" patternUnits="userSpaceOnUse">
          {/* Terracotta outer diamond */}
          <polygon points="8,1 15,14 8,27 1,14" fill="#C6532B" stroke="#D4A244" strokeWidth="1" />
          {/* Inner gold diamond */}
          <polygon points="8,5 12,14 8,23 4,14" fill="#D4A244" />
          {/* White center pearl */}
          <circle cx="8" cy="14" r="1.8" fill="#FAF6F0" />
          {/* Edge dots */}
          <circle cx="1" cy="14" r="1" fill="#D4A244" />
          <circle cx="15" cy="14" r="1" fill="#D4A244" />
        </pattern>
      </defs>
      <rect width="16" height="260" fill="url(#tibebUnit)" />
    </svg>
  );
}

/**
 * Traditional Ethiopian Scalloped Arch Plaque (የብራና ጽላት ሰሌዳ)
 */
export function ScallopedPlaque({
  title = "አድምጥ",
  onClick,
  isPlaying = false,
}: {
  title?: string;
  onClick?: () => void;
  isPlaying?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex items-center justify-center cursor-pointer transition-all focus:outline-none select-none ${
        isPlaying ? "scale-105" : "hover:scale-[1.02] active:scale-95"
      }`}
      aria-label="የቦሌ መድኃኔዓለም እቁብ ሪፖርት አድምጥ"
    >
      <svg
        viewBox="0 0 148 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-36 h-12 drop-shadow-md"
      >
        <defs>
          <linearGradient id="plaqueGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E2AC4C" />
            <stop offset="50%" stopColor="#C99436" />
            <stop offset="100%" stopColor="#B37E24" />
          </linearGradient>
        </defs>

        {/* Traditional Ethiopian Bracketed Arch Outline */}
        <path
          d="M 6 24 
             C 6 10, 16 4, 30 4 
             L 60 4 
             C 68 0, 80 0, 88 4 
             L 118 4 
             C 132 4, 142 10, 142 24 
             C 142 38, 132 44, 118 44 
             L 88 44 
             C 80 48, 68 48, 60 44 
             L 30 44 
             C 16 44, 6 38, 6 24 Z"
          fill="url(#plaqueGold)"
          stroke="#1C1410"
          strokeWidth="3"
        />

        {/* Inner Delicate Inset Border */}
        <path
          d="M 10 24 
             C 10 13, 19 8, 31 8 
             L 61 8 
             C 68 5, 80 5, 87 8 
             L 117 8 
             C 129 8, 138 13, 138 24 
             C 138 35, 129 40, 117 40 
             L 87 40 
             C 80 43, 68 43, 61 40 
             L 31 40 
             C 19 40, 10 35, 10 24 Z"
          fill="none"
          stroke="#553916"
          strokeWidth="1"
          strokeDasharray="2 1.5"
        />
      </svg>

      {/* Plaque Text and Icon */}
      <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[#1C1410] font-bold">
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`w-4 h-4 ${isPlaying ? "animate-bounce" : ""}`}
        >
          <path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 010 7.07l-1.41-1.41a3 3 0 000-4.24l1.41-1.42zM18.36 5.64a9 9 0 010 12.72l-1.41-1.41a7 7 0 000-9.9l1.41-1.41z" />
        </svg>
        <span className="font-ethiopic text-sm tracking-wide font-extrabold">{title}</span>
      </div>
    </button>
  );
}

/**
 * 3D Woven Mesob Basket Component (ባህላዊ መሶብ)
 */
export function MesobBasket({ className = "w-20 h-24" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 70 82"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="mesobStraw" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#E9C87B" />
          <stop offset="30%" stopColor="#F9DF98" />
          <stop offset="70%" stopColor="#DFBC68" />
          <stop offset="100%" stopColor="#B89542" />
        </linearGradient>
        <linearGradient id="mesobRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D94326" />
          <stop offset="100%" stopColor="#9C2712" />
        </linearGradient>
        <filter id="mesobGlow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="4" stdDeviation="3" floodColor="#000000" floodOpacity="0.45" />
        </filter>
      </defs>

      <g filter="url(#mesobGlow)">
        {/* Crown Knob (ጉልላት) */}
        <ellipse cx="35" cy="8" rx="4.5" ry="4" fill="url(#mesobStraw)" stroke="#6C4119" strokeWidth="1" />
        <path d="M32 12 H38 L39 16 H31 Z" fill="url(#mesobRed)" />

        {/* Conical Lid (ክዳን) */}
        <path
          d="M31 16 H39 L53 38 H17 L31 16 Z"
          fill="url(#mesobStraw)"
          stroke="#553010"
          strokeWidth="1.2"
        />

        {/* Lid Red & Green Geometrics */}
        <polygon points="35,18 41,27 35,36 29,27" fill="url(#mesobRed)" />
        <polygon points="23,28 29,36 21,38 18,32" fill="#138A4B" />
        <polygon points="47,28 52,32 49,38 41,36" fill="#138A4B" />

        {/* Lid Lip / Rim (የክዳን ከንፈር) */}
        <rect
          x="15"
          y="37"
          width="40"
          height="5.5"
          rx="2"
          fill="url(#mesobRed)"
          stroke="#F9DF98"
          strokeWidth="1"
        />

        {/* Mesob Waist Drum (መካከለኛ አካል) */}
        <path
          d="M17 42.5 H53 L49 65 H21 L17 42.5 Z"
          fill="url(#mesobStraw)"
          stroke="#553010"
          strokeWidth="1.2"
        />

        {/* Waist Woven Patterns */}
        <polygon points="35,44 42,54 35,64 28,54" fill="url(#mesobRed)" />
        <polygon points="21,46 27,54 22,63 19,55" fill="#138A4B" />
        <polygon points="49,46 51,55 48,63 43,54" fill="#138A4B" />

        {/* Flared Pedestal Base (እግር / መቀመጫ) */}
        <path
          d="M21 65 H49 L54 75 H16 L21 65 Z"
          fill="url(#mesobRed)"
          stroke="#553010"
          strokeWidth="1.2"
        />
        <rect x="15" y="75" width="40" height="3" rx="1" fill="#C89736" stroke="#553010" strokeWidth="0.8" />
      </g>
    </svg>
  );
}
