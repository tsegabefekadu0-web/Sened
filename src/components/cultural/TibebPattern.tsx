import React from "react";

/**
 * Traditional Ethiopian Meskel & Diamond Tibeb Embroidery Pattern for Header
 */
export function TibebHeaderPattern({ className = "w-full h-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 340 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Central Diamond Motif */}
      <g transform="translate(170, 16)">
        <polygon
          points="0,-13 13,0 0,13 -13,0"
          fill="#D4A244"
          stroke="#C6532B"
          strokeWidth="1.5"
        />
        <polygon
          points="0,-7 7,0 0,7 -7,0"
          fill="#C6532B"
        />
        <circle cx="0" cy="0" r="2.5" fill="#FAF7F2" />
        {/* Diamond Side Accents */}
        <circle cx="-16" cy="0" r="1.5" fill="#D4A244" />
        <circle cx="16" cy="0" r="1.5" fill="#D4A244" />
      </g>

      {/* Left Meskel Cross */}
      <g transform="translate(70, 16)">
        <rect x="-3" y="-11" width="6" height="22" fill="#D4A244" rx="0.8" />
        <rect x="-11" y="-3" width="22" height="6" fill="#D4A244" rx="0.8" />
        <rect x="-5" y="-5" width="10" height="10" fill="#C6532B" rx="1" />
        <circle cx="0" cy="0" r="2" fill="#FAF7F2" />
        <circle cx="-6.5" cy="-6.5" r="1.2" fill="#D4A244" />
        <circle cx="6.5" cy="-6.5" r="1.2" fill="#D4A244" />
        <circle cx="-6.5" cy="6.5" r="1.2" fill="#D4A244" />
        <circle cx="6.5" cy="6.5" r="1.2" fill="#D4A244" />
      </g>

      {/* Right Meskel Cross */}
      <g transform="translate(270, 16)">
        <rect x="-3" y="-11" width="6" height="22" fill="#D4A244" rx="0.8" />
        <rect x="-11" y="-3" width="22" height="6" fill="#D4A244" rx="0.8" />
        <rect x="-5" y="-5" width="10" height="10" fill="#C6532B" rx="1" />
        <circle cx="0" cy="0" r="2" fill="#FAF7F2" />
        <circle cx="-6.5" cy="-6.5" r="1.2" fill="#D4A244" />
        <circle cx="6.5" cy="-6.5" r="1.2" fill="#D4A244" />
        <circle cx="-6.5" cy="6.5" r="1.2" fill="#D4A244" />
        <circle cx="6.5" cy="6.5" r="1.2" fill="#D4A244" />
      </g>

      {/* Dotted Connecting Lines */}
      <line x1="90" y1="16" x2="150" y2="16" stroke="#D4A244" strokeWidth="1.2" strokeDasharray="3 3" />
      <line x1="190" y1="16" x2="250" y2="16" stroke="#D4A244" strokeWidth="1.2" strokeDasharray="3 3" />
    </svg>
  );
}

/**
 * Diagonal Woven Tibeb Ribbon Straps for card corners
 */
export function TibebRibbon({ position = "top-right" }: { position?: "top-right" | "bottom-right" }) {
  if (position === "bottom-right") {
    return (
      <div className="absolute bottom-0 right-0 overflow-hidden w-20 h-20 pointer-events-none select-none">
        <div className="w-28 h-5 bg-gradient-to-r from-terracotta-600 via-gold-400 to-terracotta-600 -rotate-45 transform translate-x-4 translate-y-9 flex items-center justify-around px-1 shadow-md border-y border-gold-300/40">
          <span className="w-1.5 h-1.5 bg-coffee-950 rotate-45 block" />
          <span className="w-1.5 h-1.5 bg-parchment-100 rotate-45 block" />
          <span className="w-1.5 h-1.5 bg-coffee-950 rotate-45 block" />
        </div>
      </div>
    );
  }

  return (
    <div className="absolute top-0 right-0 overflow-hidden w-20 h-20 pointer-events-none select-none">
      <div className="w-28 h-5 bg-gradient-to-r from-terracotta-600 via-gold-400 to-terracotta-600 rotate-45 transform translate-x-4 translate-y-2 flex items-center justify-around px-1 shadow-md border-y border-gold-300/40">
        <span className="w-1.5 h-1.5 bg-coffee-950 rotate-45 block" />
        <span className="w-1.5 h-1.5 bg-parchment-100 rotate-45 block" />
        <span className="w-1.5 h-1.5 bg-coffee-950 rotate-45 block" />
      </div>
    </div>
  );
}
