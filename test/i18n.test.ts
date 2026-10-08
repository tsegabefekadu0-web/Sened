import { describe, expect, it } from "vitest";
import { createTranslator, dictionaries, translate } from "@/lib/i18n";

describe("Amharic copy has no Latin jargon left over", () => {
  it("does not leave the English unit 'bps' in the Amharic risk notes", () => {
    for (const key of Object.keys(dictionaries.am)) {
      if (key.startsWith("drawRisk.note.")) {
        expect(dictionaries.am[key as keyof typeof dictionaries.am], key).not.toMatch(/bps/);
      }
    }
  });
});

describe("i18n foundation", () => {
  it("keeps English and Amharic dictionaries aligned", () => {
    expect(Object.keys(dictionaries.am).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });

  it("translates the shell heading into Amharic", () => {
    expect(translate("am", "home.title")).toBe("ለማህበረሰብ ክምች የታመነ መሠረት");
  });

  it("interpolates values and preserves unknown placeholders", () => {
    const t = createTranslator("en");

    expect(t("home.foundationValue", { milestone: 2 })).toBe("Milestone 2 preparation");
    expect(t("home.foundationValue")).toBe("Milestone {milestone} preparation");
  });
});
