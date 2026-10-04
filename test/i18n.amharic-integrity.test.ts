import { describe, expect, it } from "vitest";
import { dictionaries } from "../src/lib/i18n";

const tokens = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[0]))].sort();

describe("Amharic dictionary integrity", () => {
  const { en, am } = dictionaries;

  it("has exactly the English keys", () => {
    expect(Object.keys(am).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no empty Amharic value", () => {
    const empty = Object.entries(am).filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("uses the same {placeholders} as English in every string", () => {
    const bad = Object.keys(en)
      .filter((k) => tokens(en[k as keyof typeof en]).join() !== tokens(am[k as keyof typeof am]).join())
      .map((k) => `${k}: en[${tokens(en[k as keyof typeof en])}] am[${tokens(am[k as keyof typeof am])}]`);
    expect(bad).toEqual([]);
  });
});
