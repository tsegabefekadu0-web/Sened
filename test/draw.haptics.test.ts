import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HAPTICS_STORAGE_KEY,
  HAPTIC_PATTERNS,
  getHapticsEnabled,
  isHapticsSupported,
  setHapticsEnabled,
  subscribeHaptics,
  triggerHaptic,
  type HapticEvent
} from "@/lib/draw/haptics";

const EVENTS: readonly HapticEvent[] = ["commitSealed", "revealStep", "winnerRevealed", "tamperDetected"];

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  );
}

describe("haptics", () => {
  let vibrate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true, writable: true });
    stubReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // jsdom has no vibrate of its own; remove ours so tests stay independent.
    delete (navigator as unknown as Record<string, unknown>).vibrate;
  });

  it("vibrates with the pattern for each event when supported", () => {
    for (const event of EVENTS) {
      vibrate.mockClear();
      expect(triggerHaptic(event)).toBe(true);
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith([...HAPTIC_PATTERNS[event]]);
    }
  });

  it("gives every event a distinct pattern, and tampering the longest, harshest one", () => {
    const serialised = EVENTS.map((event) => JSON.stringify(HAPTIC_PATTERNS[event]));
    expect(new Set(serialised).size).toBe(EVENTS.length);
    const total = (event: HapticEvent) => HAPTIC_PATTERNS[event].reduce((sum, ms) => sum + ms, 0);
    for (const event of EVENTS.filter((entry) => entry !== "tamperDetected")) {
      expect(total("tamperDetected")).toBeGreaterThan(total(event));
    }
  });

  it("is a silent no-op where the Vibration API does not exist (iOS Safari)", () => {
    delete (navigator as unknown as Record<string, unknown>).vibrate;
    expect(isHapticsSupported()).toBe(false);
    expect(() => triggerHaptic("winnerRevealed")).not.toThrow();
    expect(triggerHaptic("winnerRevealed")).toBe(false);
  });

  it("reports support when the API exists", () => {
    expect(isHapticsSupported()).toBe(true);
  });

  it("does not vibrate when the user prefers reduced motion", () => {
    stubReducedMotion(true);
    for (const event of EVENTS) expect(triggerHaptic(event)).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not vibrate when the user has switched it off, and persists the choice", () => {
    expect(getHapticsEnabled()).toBe(true);
    setHapticsEnabled(false);
    expect(localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe("off");
    expect(getHapticsEnabled()).toBe(false);
    vibrate.mockClear();
    expect(triggerHaptic("commitSealed")).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    expect(getHapticsEnabled()).toBe(true);
    expect(triggerHaptic("commitSealed")).toBe(true);
  });

  it("cancels an ongoing vibration when switched off, and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHaptics(listener);
    setHapticsEnabled(false);
    expect(vibrate).toHaveBeenCalledWith(0);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setHapticsEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("defaults to on, and survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getHapticsEnabled()).toBe(true);
    expect(triggerHaptic("revealStep")).toBe(true);
    // The choice still holds for this page load.
    expect(() => setHapticsEnabled(false)).not.toThrow();
    expect(triggerHaptic("revealStep")).toBe(false);
    vi.restoreAllMocks();
    setHapticsEnabled(true);
  });

  it("never throws if vibrate itself throws", () => {
    vibrate.mockImplementation(() => {
      throw new Error("NotAllowedError");
    });
    expect(triggerHaptic("tamperDetected")).toBe(false);
  });
});
