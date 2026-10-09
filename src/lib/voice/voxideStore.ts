import { useSyncExternalStore } from "react";

/**
 * Where the mounted Voxide client is published so the voice sheet can drive the
 * English assistant without importing the Voxide package into every page.
 * `client` is typed loosely on purpose: only the English panel (which is loaded
 * lazily) knows the real type.
 */
let current: unknown = null;
const listeners = new Set<() => void>();

export function setSharedVoxideClient(client: unknown): void {
  current = client;
  listeners.forEach((listener) => listener());
}

export function useSharedVoxideClient(): unknown {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null
  );
}

/** True when this build has a publishable Voxide key (inlined at build time). */
export function voxideConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VOXIDE_KEY?.trim());
}
