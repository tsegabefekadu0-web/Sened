import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const triggerHaptic = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/lib/draw/haptics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/draw/haptics")>()),
  triggerHaptic
}));

import { DrawBoard } from "@/components/draw/DrawBoard";
import { HapticsToggle } from "@/components/draw/HapticsToggle";
import { HAPTICS_STORAGE_KEY } from "@/lib/draw/haptics";
import { translate } from "@/lib/i18n";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

beforeEach(() => {
  triggerHaptic.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).vibrate;
});

const calls = () => triggerHaptic.mock.calls.map((call) => (call as unknown as [string])[0]);

describe("demo ceremony haptics", () => {
  it("does not vibrate on load, before any user action", async () => {
    render(<DrawBoard locale="en" />);
    await screen.findByRole("button", { name: "Lock the draw" });
    expect(triggerHaptic).not.toHaveBeenCalled();
  });

  it("buzzes the seal on commit, a step on reveal, then the winner once verified", async () => {
    const user = userEvent.setup();
    render(<DrawBoard locale="en" />);
    await user.click(screen.getByRole("button", { name: "Lock the draw" }));
    await screen.findByRole("button", { name: "Pick the winner" });
    expect(calls()).toEqual(["commitSealed"]);

    await user.click(screen.getByRole("button", { name: "Pick the winner" }));
    await waitFor(() => expect(calls()).toContain("winnerRevealed"));
    expect(calls()).toEqual(["commitSealed", "revealStep", "revealStep", "winnerRevealed"]);
    expect(calls()).not.toContain("tamperDetected");
  });

  it("buzzes the tamper pattern, and never the winner one, when the seed is flipped", async () => {
    const user = userEvent.setup();
    render(<DrawBoard locale="en" />);
    await user.click(screen.getByRole("button", { name: "Lock the draw" }));
    await screen.findByRole("button", { name: "Pick the winner" });
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Pick the winner" }));
    await waitFor(() => expect(calls()).toContain("tamperDetected"));
    expect(calls()).toEqual(["commitSealed", "revealStep", "tamperDetected"]);
  });
});

describe("HapticsToggle", () => {
  it("says honestly that this browser cannot vibrate, and offers no working switch", async () => {
    render(<HapticsToggle locale="en" />);
    expect(await screen.findByTestId("haptics-note")).toHaveTextContent(/no vibration support/);
    expect(screen.getByTestId("haptics-note")).toHaveTextContent(/iPhones and iPads/);
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("is on by default where supported, and persists the user's choice", async () => {
    Object.defineProperty(navigator, "vibrate", { value: vi.fn(() => true), configurable: true, writable: true });
    const user = userEvent.setup();
    render(<HapticsToggle locale="en" />);
    const toggle = await screen.findByRole("switch");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("haptics-note")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe("off");

    cleanup();
    render(<HapticsToggle locale="en" />);
    expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("explains that reduced motion pauses it", async () => {
    Object.defineProperty(navigator, "vibrate", { value: vi.fn(() => true), configurable: true, writable: true });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    render(<HapticsToggle locale="en" />);
    expect(await screen.findByTestId("haptics-note")).toHaveTextContent(/reduced motion/);
  });

  it("speaks Amharic when asked", async () => {
    render(<HapticsToggle locale="am" />);
    expect(await screen.findByText(translate("am", "draw.haptics.label"))).toBeInTheDocument();
    expect(screen.getByTestId("haptics-note")).toHaveTextContent(translate("am", "draw.haptics.unsupported"));
  });
});
