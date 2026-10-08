import { describe, expect, it } from "vitest";

import {
  MASKED_REFERENCE_PATTERN,
  MASK_BULLET,
  isMaskedReference,
  maskBankReference
} from "@/lib/banking/referenceMask";

const B = MASK_BULLET.repeat(4);

describe("maskBankReference", () => {
  it("keeps the last 4 characters of a long reference", () => {
    expect(maskBankReference("FT26280ABCD2F42")).toBe(`${B}2F42`);
    expect(maskBankReference("C0970153")).toBe(`${B}0153`);
  });

  it("shows fewer, never more than half, for short references", () => {
    expect(maskBankReference("ABCDEFG")).toBe(`${B}EFG`); // 7 -> 3
    expect(maskBankReference("ABCDEF")).toBe(`${B}DEF`); // 6 -> 3
    expect(maskBankReference("ABCDE")).toBe(`${B}DE`); // 5 -> 2
    expect(maskBankReference("ABCD")).toBe(`${B}CD`); // 4 -> 2
    expect(maskBankReference("ABC")).toBe(`${B}C`); // 3 -> 1
    expect(maskBankReference("AB")).toBe(`${B}B`); // 2 -> 1
  });

  it("shows nothing for a one-character or empty reference", () => {
    expect(maskBankReference("A")).toBeNull();
    expect(maskBankReference("")).toBeNull();
    expect(maskBankReference("   ")).toBeNull();
  });

  it("never reveals more than half of the reference or more than 4 characters, for every length", () => {
    for (let length = 1; length <= 300; length += 1) {
      const reference = Array.from({ length }, (_, index) => String.fromCharCode(48 + (index % 40))).join("");
      const masked = maskBankReference(reference);
      if (length < 2) {
        expect(masked).toBeNull();
        continue;
      }
      expect(masked).not.toBeNull();
      const visible = masked!.slice(4);
      expect(visible.length).toBeLessThanOrEqual(4);
      expect(visible.length).toBeLessThanOrEqual(length / 2);
      expect(reference.endsWith(visible)).toBe(true);
      expect(masked).toMatch(MASKED_REFERENCE_PATTERN);
    }
  });

  it("does not reveal the length: always four bullets", () => {
    expect(maskBankReference("A".repeat(8))!.slice(0, 4)).toBe(B);
    expect(maskBankReference("A".repeat(200))!.slice(0, 4)).toBe(B);
    expect(maskBankReference("A".repeat(8))!.length).toBe(maskBankReference("A".repeat(200))!.length);
  });

  it("trims surrounding whitespace, as the request schema does", () => {
    expect(maskBankReference("  FT26280ABCD2F42\n")).toBe(`${B}2F42`);
  });

  it("returns null, rather than guessing, outside the printable ASCII alphabet (unicode, spaces, controls)", () => {
    for (const odd of [
      "ማጣቀሻ123456",
      "FT2628éABCD",
      "😀😀😀😀😀😀",
      "FT26 280ABCD",
      "FT26\t280ABCD",
      "FT26280ABCD\u0000",
      "FT26280ABC​",
      "••••••2F42" // already bullets: not a reference
    ]) {
      expect(maskBankReference(odd), odd).toBeNull();
    }
  });

  it("is not fooled by non-strings", () => {
    for (const bad of [undefined, null, 12345678, {}, ["ABCDEFGH"]]) {
      expect(maskBankReference(bad)).toBeNull();
    }
  });

  it("is deterministic and never returns the input", () => {
    const reference = "FT26280ABCD2F42";
    expect(maskBankReference(reference)).toBe(maskBankReference(reference));
    expect(maskBankReference(reference)).not.toContain(reference.slice(0, 5));
  });
});

describe("isMaskedReference / MASKED_REFERENCE_PATTERN", () => {
  it("accepts exactly the shape the mask produces", () => {
    for (const ok of [`${B}2F42`, `${B}F`, `${B}ab-9`, `${B}/\\~!`]) {
      expect(isMaskedReference(ok), ok).toBe(true);
    }
  });

  it("refuses a full reference, a longer tail, wrong bullets, padding and non-strings", () => {
    for (const bad of [
      "FT26280ABCD2F42",
      `${B}12345`,
      `${B}`,
      "•••ABCD",
      `•${B}AB`,
      ` ${B}AB`,
      `${B}AB\n`,
      `${B}A B`,
      `${B}é`,
      `x${B}AB`,
      "",
      null,
      undefined,
      4242
    ]) {
      expect(isMaskedReference(bad), String(bad)).toBe(false);
    }
  });
});
