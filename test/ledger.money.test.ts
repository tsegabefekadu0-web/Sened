import { describe, expect, it } from "vitest";
import {
  addEtbAmounts,
  formatEtbAmount,
  formatEtbDisplay,
  isEtbAmount,
  subtractEtbAmounts,
  WIRE_ETB_DECIMAL_PATTERN
} from "@/lib/ledger";

describe("ETB decimal money", () => {
  it("adds decimal strings without floating-point drift", () => {
    expect(addEtbAmounts("0.10", "0.20")).toBe("0.30");
    expect(subtractEtbAmounts("10.01", "0.01")).toBe("10.00");
  });

  it("canonicalizes wire amounts to two fraction digits", () => {
    expect(formatEtbAmount("5")).toBe("5.00");
    expect(formatEtbAmount("5.1")).toBe("5.10");
    expect(formatEtbDisplay("1234567.8")).toBe("Br 1,234,567.80");
    expect(WIRE_ETB_DECIMAL_PATTERN.test("5.10")).toBe(true);
  });

  it.each([
    "1,000.00",
    "1e3",
    "+1.00",
    "-1.00",
    "01.00",
    "1.000",
    ".50",
    "1000000000000000000.00"
  ])("rejects non-canonical or out-of-range amount %s", (amount) => {
    expect(isEtbAmount(amount)).toBe(false);
  });

  it("allows zero as money but rejects zero as a posting line", () => {
    expect(isEtbAmount("0.00")).toBe(true);
    expect(isEtbAmount("0.00", true)).toBe(false);
  });
});
