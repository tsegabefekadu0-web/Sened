import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReview, filledReviewRows, parseCsv } from "../scripts/import-amharic-review";

const fixture = readFileSync(resolve(__dirname, "fixtures/i18n-mini.ts"), "utf8");
const csv = (rows: string[][]) =>
  "﻿key,english,reviewer_amharic\r\n" +
  rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n") +
  "\r\n";

describe("amharic review import", () => {
  it("parses RFC 4180 quoting, BOM, embedded commas and quotes", () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""no"""\r\n')).toEqual([
      ["a", "b"],
      ["x,1", 'he said "no"']
    ]);
  });

  it("replaces only the named am literal and leaves everything else byte-identical", () => {
    const r = applyReview(fixture, csv([["a.one", "Hello", "ሰላም ለሁሉም"]]));
    expect(r.changes).toEqual([{ key: "a.one", before: "ሰላም", after: "ሰላም ለሁሉም" }]);
    expect(r.source).toBe(fixture.replace('"a.one": "ሰላም"', '"a.one": "ሰላም ለሁሉም"'));
    expect(r.source).toContain('"a.one": "Hello"');
  });

  it("never touches en, even when a key has the same text there", () => {
    const r = applyReview(fixture, csv([["b.one", "", "ቆይ"]]));
    expect(r.source.slice(0, r.source.indexOf("const am"))).toBe(fixture.slice(0, fixture.indexOf("const am")));
    expect(r.source).toContain('"b.one": "ቆይ"');
  });

  it("escapes quotes and backslashes in the new value and decodes \\u escapes in the old one", () => {
    const r = applyReview(fixture, csv([["a.quote", "", 'ሰላም "ነው" \\']]));
    expect(r.changes[0].before).toBe("ሰላም");
    expect(r.source).toContain('"a.quote": "ሰላም \\"ነው\\" \\\\"');
  });

  it("refuses placeholder mismatches (missing, extra, renamed)", () => {
    for (const bad of ["አባላት በዙር {round}", "{count} {round} {extra}", "{count} በዙር {rnd}"]) {
      const r = applyReview(fixture, csv([["a.count", "", bad]]));
      expect(r.changes).toHaveLength(0);
      expect(r.refused[0].reason).toMatch(/placeholders differ/);
      expect(r.source).toBe(fixture);
    }
  });

  it("accepts reordered placeholders", () => {
    const r = applyReview(fixture, csv([["a.count", "", "በዙር {round} {count} አባላት"]]));
    expect(r.changes).toHaveLength(1);
  });

  it("refuses unknown keys, duplicates and line breaks; skips empty rows", () => {
    const r = applyReview(
      fixture,
      csv([
        ["nope.key", "", "ሰላም"],
        ["a.one", "", "አንድ"],
        ["a.one", "", "ሁለት"],
        ["b.one", "", "ሀ\nለ"],
        ["a.quote", "", ""]
      ])
    );
    expect(r.refused.map((x) => x.key).sort()).toEqual(["a.one", "b.one", "nope.key"]);
    expect(r.changes.map((c) => c.key)).toEqual(["a.one"]);
  });

  it("reports identical values as unchanged", () => {
    const r = applyReview(fixture, csv([["a.one", "", "ሰላም"]]));
    expect(r.unchanged).toEqual(["a.one"]);
    expect(r.source).toBe(fixture);
  });
});

describe("amharic review import: refuses lossy or non-Amharic text", () => {
  const replacement = String.fromCharCode(0xfffd);
  const qm = String.fromCharCode(63);

  it("refuses a value containing U+FFFD", () => {
    const r = applyReview(fixture, csv([["a.one", "", "ሰላ" + replacement + "ም"]]));
    expect(r.changes).toHaveLength(0);
    expect(r.refused).toEqual([{ key: "a.one", reason: expect.stringContaining("U+FFFD") }]);
    expect(r.source).toBe(fixture);
  });

  it("refuses Ethiopic letters replaced by question marks", () => {
    const r = applyReview(fixture, csv([["a.one", "", "ሰ" + qm + qm + "ም"]]));
    expect(r.changes).toHaveLength(0);
    expect(r.refused[0].reason).toContain(qm);
    expect(r.source).toBe(fixture);
  });

  it("accepts a real question mark that the current text or the English already has", () => {
    const withQuestion = fixture.replace('"b.one": "ተው"', '"b.one": "ተው' + qm + '"');
    const r = applyReview(withQuestion, csv([["b.one", "", "እሺ" + qm]]));
    expect(r.refused).toEqual([]);
    expect(r.changes).toHaveLength(1);
  });

  it("requires Ethiopic when the current value has it", () => {
    const r = applyReview(fixture, csv([["a.one", "", "Hello again"]]));
    expect(r.changes).toHaveLength(0);
    expect(r.refused[0].reason).toMatch(/Ethiopic/);
  });
});

describe("amharic review export guard", () => {
  const eol = String.fromCharCode(13, 10);
  const header = "key,english,reviewer_amharic,reviewer_ok,reviewer_comment" + eol;

  it("counts rows that hold a reviewer's work, in any reviewer column", () => {
    expect(filledReviewRows(header + ["a,A,,,", "b,B,,,"].join(eol) + eol)).toBe(0);
    expect(filledReviewRows(header + ["a,A,ሰላም,,", "b,B,,yes,", "c,C,,,looks odd", "d,D,,,"].join(eol) + eol)).toBe(3);
    expect(filledReviewRows(header + 'a,A,"  ",,' + eol)).toBe(0);
  });
});
