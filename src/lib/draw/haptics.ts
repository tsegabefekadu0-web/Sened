/**
 * Haptic feedback for the draw ceremony. Browser-only: no Node builtins.
 *
 * Wraps `navigator.vibrate` with one named pattern per ceremony moment.
 *
 * Honest limits:
 *   - Where the Vibration API does not exist this is a silent no-op. iOS Safari
 *     (and every browser on iOS, which all use WebKit) has no Vibration API, so
 *     iPhone and iPad users feel nothing. We do not fake it with sound or
 *     animation under the name of "haptics"; `isHapticsSupported()` lets the UI
 *     say so.
 *   - Browsers only honour `vibrate()` after the user has interacted with the
 *     page. Callers fire these from the click handlers and the state
 *     transitions that follow them, never on load.
 *   - `prefers-reduced-motion: reduce` suppresses vibration, as it suppresses
 *     the animation, and a stored user choice can switch it off entirely.
 */

export type HapticEvent =
  | "commitSealed"
  | "revealStep"
  | "winnerRevealed"
  | "tamperDetected";

/** Milliseconds, alternating vibrate / pause, as `navigator.vibrate` takes them. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticEvent, readonly number[]>> = {
  // One firm stamp, like the wax seal landing.
  commitSealed: [40],
  // A short tick for each stage of the reveal.
  revealStep: [15],
  // A rising celebratory flourish.
  winnerRevealed: [30, 50, 30, 50, 90],
  // Long, harsh, evenly spaced: unmistakably not a celebration.
  tamperDetected: [220, 90, 220, 90, 220]
};

export const HAPTICS_STORAGE_KEY = "sened.draw.haptics";

type VibrateNavigator = { vibrate?: (pattern: number | number[]) => boolean };

function vibrator(): VibrateNavigator | null {
  if (typeof navigator === "undefined") return null;
  return navigator as unknown as VibrateNavigator;
}

/** Does this browser expose the Vibration API at all? False on iOS Safari. */
export function isHapticsSupported(): boolean {
  return typeof vibrator()?.vibrate === "function";
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/** True while the OS asks for reduced motion; haptics are held off meanwhile. */
export function hapticsHeldByReducedMotion(): boolean {
  return prefersReducedMotion();
}

const listeners = new Set<() => void>();

/** Used only when localStorage is unavailable. */
let memoryOverride: boolean | null = null;

/** The user's choice. Defaults to on; storage that throws or is empty reads as on. */
export function getHapticsEnabled(): boolean {
  return enabledNow();
}

export function setHapticsEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(HAPTICS_STORAGE_KEY, enabled ? "on" : "off");
    memoryOverride = null;
  } catch {
    // Storage blocked: the choice lasts only until the page closes.
    memoryOverride = enabled;
  }
  if (!enabled) {
    // Cancel anything already buzzing.
    try {
      vibrator()?.vibrate?.(0);
    } catch {
      // ignore
    }
  }
  for (const listener of listeners) listener();
}

function enabledNow(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(HAPTICS_STORAGE_KEY);
    if (stored === "off") return false;
    if (stored === "on") return true;
  } catch {
    // fall through to the in-memory choice
  }
  return memoryOverride ?? true;
}

export function subscribeHaptics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Vibrate for a ceremony moment. Returns true only if a vibration was requested.
 * Never throws.
 */
export function triggerHaptic(event: HapticEvent): boolean {
  if (!isHapticsSupported()) return false;
  if (prefersReducedMotion()) return false;
  if (!enabledNow()) return false;
  try {
    return vibrator()?.vibrate?.([...HAPTIC_PATTERNS[event]]) === true;
  } catch {
    return false;
  }
}
