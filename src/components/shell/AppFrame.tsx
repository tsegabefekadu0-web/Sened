import React from "react";

/**
 * The one column every screen lives in.
 *
 * A phone gets the whole screen. A desktop gets the same phone-width column,
 * centred on a calm warm background, so the interface is never stretched into
 * wide rows that are hard to follow. Anything that must stay at the bottom of
 * the screen (the navigation bar) goes inside this column, not outside it.
 */
export function AppFrame({
  children,
  className = ""
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <main className="flex min-h-[100dvh] w-full justify-center bg-[#E8DFD3] antialiased selection:bg-amber-500 selection:text-coffee-950 md:items-center md:py-6">
      <div
        className={`relative flex h-[100dvh] w-full max-w-[480px] flex-col overflow-hidden bg-[#FAF6F0] md:h-[min(calc(100dvh-3rem),920px)] md:rounded-3xl md:border md:border-[#D3C3B0] md:shadow-[0_24px_60px_-20px_rgba(60,40,25,0.45)] ${className}`}
      >
        {children}
      </div>
    </main>
  );
}
