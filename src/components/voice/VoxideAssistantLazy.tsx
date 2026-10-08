"use client";

import dynamic from "next/dynamic";

/**
 * The assistant, loaded only in the browser and only when a key is configured.
 * `NEXT_PUBLIC_VOXIDE_KEY` is inlined at build time, so without a key the
 * Voxide chunk is never requested and first load is unchanged.
 */
const VoxideAssistant = dynamic(() => import("./VoxideAssistant"), { ssr: false });

export function VoxideAssistantLazy() {
  if (!process.env.NEXT_PUBLIC_VOXIDE_KEY?.trim()) {
    return null;
  }
  return <VoxideAssistant />;
}
