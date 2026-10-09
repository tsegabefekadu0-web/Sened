import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SlideSwitch } from "@/components/ui/SlideSwitch";
import { Button } from "@/components/ui/primitives";
import { runDemoDraw } from "@/lib/draw/demoDraw";
import { dictionaries } from "@/lib/i18n";
import { ETHIOPIC_MONTHS, geez, toEthiopic } from "@/lib/ui/geez";
import { sampleCommunity } from "@/lib/ui/useCommunity";
import { clearVoiceHandoff, readVoiceHandoff, saveVoiceHandoff } from "@/lib/voice/handoff";

describe("Ge'ez numerals and the Ethiopian calendar", () => {
  it("writes 1..99 in Ge'ez and leaves other numbers alone", () => {
    expect(geez(3)).toBe("፫");
    expect(geez(30)).toBe("፴");
    expect(geez(19)).toBe("፲፱");
    expect(geez(100)).toBe("100");
  });

  it("converts a Gregorian date to the Ethiopian one", () => {
    // 2026-09-11 is 1 Meskerem 2019 (the Ethiopian new year), 2026-10-09 is 29 Meskerem.
    expect(toEthiopic(new Date(2026, 8, 11))).toEqual({ year: 2019, month: 0, day: 1 });
    const d = toEthiopic(new Date(2026, 9, 9));
    expect(ETHIOPIC_MONTHS[d.month]).toBe("መስከረም");
    expect(d.day).toBe(29);
  });
});

describe("the interface strings", () => {
  it("has an Amharic string for every new key, with the same placeholders", () => {
    const { en, am } = dictionaries;
    const ui = Object.keys(en).filter((k) => k.startsWith("ui."));
    expect(ui.length).toBeGreaterThan(150);
    for (const key of ui) {
      const k = key as keyof typeof en;
      const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
      expect(tokens(am[k])).toBe(tokens(en[k]));
    }
  });
});

describe("the sample community", () => {
  it("is labelled as a sample, with a struck-and-corrected pair in the ledger", () => {
    const c = sampleCommunity();
    expect(c.mode).toBe("sample");
    expect(c.members).toHaveLength(8);
    const kinds = c.rows.map((r) => r.kind);
    expect(kinds).toContain("void");
    expect(kinds).toContain("fixed");
  });
});

describe("the voice hand-off", () => {
  it("carries only the text, and clears", () => {
    expect(readVoiceHandoff()).toBeNull();
    saveVoiceHandoff({ utterance: "5000 ብር", source: "asr" });
    expect(readVoiceHandoff()).toEqual({ utterance: "5000 ብር", source: "asr" });
    clearVoiceHandoff();
    expect(readVoiceHandoff()).toBeNull();
  });
});

describe("the on-device demo draw", () => {
  it("picks a roster member and verifies on this device", async () => {
    const roster = Array.from({ length: 4 }, (_, i) => ({
      memberId: `000${i + 1}4444-4444-8444-844444444444`,
      displayName: `m${i}`,
      status: "active" as const,
      contributionAmount: "5000.00"
    }));
    const result = await runDemoDraw(roster, 1, 4);
    expect(roster.map((r) => r.memberId)).toContain(result.winnerMemberId);
    expect(result.verified).toBe(true);
  });
});

describe("SlideSwitch", () => {
  it("is a switch that toggles on tap", () => {
    const onChange = vi.fn();
    render(<SlideSwitch checked={false} onChange={onChange} label="Language" left="አማ" right="EN" />);
    const sw = screen.getByRole("switch", { name: "Language" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Button", () => {
  it("shows the loading state while the action runs, then success", async () => {
    let done!: () => void;
    const action = () => new Promise<void>((resolve) => (done = resolve));
    render(<Button onPress={action} successLabel="Saved">Save</Button>);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-busy", "true");
    done();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows the error label when the action fails", async () => {
    render(<Button onPress={() => false} errorLabel="Try again">Save</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Try again")).toBeInTheDocument();
  });
});
