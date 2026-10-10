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

  it("converts a Gregorian date to the Ethiopian one across common years, leap years, and milestones", () => {
    // 2026-09-11 is 1 Meskerem 2019 (the Ethiopian new year), 2026-10-09 is 29 Meskerem.
    expect(toEthiopic(new Date(2026, 8, 11))).toEqual({ year: 2019, month: 0, day: 1 });
    const d = toEthiopic(new Date(2026, 9, 9));
    expect(ETHIOPIC_MONTHS[d.month]).toBe("መስከረም");
    expect(d.day).toBe(29);

    // Leap year 2015 E.C. (2015 % 4 = 3): Pagume has 6 days, Meskerem 1 2016 falls on Sept 12
    expect(toEthiopic(new Date(2023, 8, 10))).toEqual({ year: 2015, month: 12, day: 5 });
    expect(toEthiopic(new Date(2023, 8, 11))).toEqual({ year: 2015, month: 12, day: 6 });
    expect(toEthiopic(new Date(2023, 8, 12))).toEqual({ year: 2016, month: 0, day: 1 });

    // Regular years 2016, 2017, 2018 E.C.
    expect(toEthiopic(new Date(2024, 8, 10))).toEqual({ year: 2016, month: 12, day: 5 });
    expect(toEthiopic(new Date(2024, 8, 11))).toEqual({ year: 2017, month: 0, day: 1 });
    expect(toEthiopic(new Date(2025, 8, 10))).toEqual({ year: 2017, month: 12, day: 5 });
    expect(toEthiopic(new Date(2025, 8, 11))).toEqual({ year: 2018, month: 0, day: 1 });
    expect(toEthiopic(new Date(2026, 8, 10))).toEqual({ year: 2018, month: 12, day: 5 });
    expect(toEthiopic(new Date(2026, 8, 11))).toEqual({ year: 2019, month: 0, day: 1 });

    // Leap year 2019 E.C.: Pagume 6 is Sept 11 2027, Meskerem 1 2020 is Sept 12 2027
    expect(toEthiopic(new Date(2027, 8, 11))).toEqual({ year: 2019, month: 12, day: 6 });
    expect(toEthiopic(new Date(2027, 8, 12))).toEqual({ year: 2020, month: 0, day: 1 });

    // Meskerem 1 2021 E.C. is Sept 11 2028
    expect(toEthiopic(new Date(2028, 8, 11))).toEqual({ year: 2021, month: 0, day: 1 });

    // Historical & cultural milestones:
    // Battle of Adwa: March 1, 1896 -> Yekatit 23, 1888
    expect(toEthiopic(new Date(1896, 2, 1))).toEqual({ year: 1888, month: 5, day: 23 });
    // Ginbot 20: May 28, 1991 -> Ginbot 20, 1983
    expect(toEthiopic(new Date(1991, 4, 28))).toEqual({ year: 1983, month: 8, day: 20 });
    // Ethiopian Millennium: September 12, 2007 -> Meskerem 1, 2000
    expect(toEthiopic(new Date(2007, 8, 12))).toEqual({ year: 2000, month: 0, day: 1 });
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
