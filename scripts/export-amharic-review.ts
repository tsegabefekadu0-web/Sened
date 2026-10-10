/**
 * Exports every Amharic UI string into a CSV for native-speaker review, plus a
 * second CSV of Ethiopic text hard-coded outside `src/lib/i18n.ts`.
 *
 *   npm run i18n:review
 *
 * "status = new" means the key did not exist, or its am value differs, at
 * BASELINE_COMMIT. The baseline dictionary is read with `git show` and loaded
 * as a module from a temp file (i18n.ts has no imports, so this is exact).
 * Flags are purely mechanical; nothing here judges translation quality.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dictionaries } from "../src/lib/i18n";
import { filledReviewRows } from "./import-amharic-review";

const BASELINE_COMMIT = "951e66f";
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "docs", "i18n");

const ETHIOPIC = /[ሀ-፿]/;
const ALLOWED_LATIN = new Set(
  ["Telebirr", "CBE", "Awash", "Links.et", "Voxide", "ScholarXIV", "Sened", "ETB", "PWA"].flatMap((w) =>
    w.split(/[.]/).map((p) => p.toLowerCase())
  )
);

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[0]);
}

function graphemeCount(text: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...seg.segment(text)].length;
}

function sortedUnique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

function flagsFor(en: string, am: string): string[] {
  const flags: string[] = [];
  if (am.trim() === "") {
    flags.push("am-empty");
    return flags;
  }
  const enP = sortedUnique(placeholdersOf(en));
  const amP = sortedUnique(placeholdersOf(am));
  const missing = enP.filter((p) => !amP.includes(p));
  const extra = amP.filter((p) => !enP.includes(p));
  if (missing.length) flags.push(`placeholder-missing:${missing.join(",")}`);
  if (extra.length) flags.push(`placeholder-extra:${extra.join(",")}`);
  if (am === en) flags.push("am-identical-to-en");
  if (!ETHIOPIC.test(am)) flags.push("no-ethiopic");
  const latin = (am.replace(/\{\w+\}/g, " ").match(/[A-Za-z][A-Za-z']*/g) ?? []).filter(
    (w) => !ALLOWED_LATIN.has(w.toLowerCase())
  );
  if (latin.length && ETHIOPIC.test(am)) flags.push(`latin-words:${sortedUnique(latin).join(" ")}`);
  const ratio = graphemeCount(am) / Math.max(1, graphemeCount(en));
  if (ratio < 0.3) flags.push(`length-ratio-short:${ratio.toFixed(2)}`);
  if (ratio > 3) flags.push(`length-ratio-long:${ratio.toFixed(2)}`);
  return flags;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number)[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

async function loadBaselineAm(): Promise<Record<string, string>> {
  const source = execFileSync("git", ["show", `${BASELINE_COMMIT}:src/lib/i18n.ts`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const cacheDir = join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `i18n-baseline-${Date.now()}.ts`);
  try {
    writeFileSync(file, source, "utf8");
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      dictionaries: Record<string, Record<string, string>>;
    };
    return { ...mod.dictionaries.am };
  } finally {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|css|json|md|mdx)$/.test(name)) out.push(p);
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // A reviewer's work lives in this file. Regenerating it would erase every
  // correction typed so far, so refuse unless the person says so.
  const reviewCsv = join(OUT_DIR, "amharic-review.csv");
  if (existsSync(reviewCsv) && !process.argv.includes("--force")) {
    const filled = filledReviewRows(readFileSync(reviewCsv, "utf8"));
    if (filled > 0) {
      console.error(
        `Refusing to overwrite ${reviewCsv}: ${filled} row(s) already have a reviewer's answer. ` +
          "Apply them first (npm run i18n:apply-review), move the file aside, or pass --force to discard them."
      );
      process.exitCode = 1;
      return;
    }
  }
  const { en, am } = dictionaries;
  const baseline = await loadBaselineAm();

  const stat = { total: 0, new: 0, flags: {} as Record<string, number> };
  const rows = Object.keys(en).map((key) => {
    const english = (en as Record<string, string>)[key];
    const amharic = (am as Record<string, string>)[key] ?? "";
    const isNew = baseline[key] === undefined || baseline[key] !== amharic;
    const flags = flagsFor(english, amharic);
    for (const f of flags) {
      const type = f.split(":")[0];
      stat.flags[type] = (stat.flags[type] ?? 0) + 1;
    }
    stat.total++;
    if (isNew) stat.new++;
    return {
      key,
      area: key.split(".")[0],
      english,
      amharic,
      placeholders: sortedUnique(placeholdersOf(english)).join(" "),
      status: isNew ? "new" : "existing",
      notes: flags.join("; ")
    };
  });
  rows.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "new" ? -1 : 1) ||
      a.area.localeCompare(b.area) ||
      a.key.localeCompare(b.key)
  );

  const header = ["key", "area", "english", "amharic", "placeholders", "status", "notes", "reviewer_amharic", "reviewer_ok", "reviewer_comment"];
  writeFileSync(
    join(OUT_DIR, "amharic-review.csv"),
    toCsv([header, ...rows.map((r) => [r.key, r.area, r.english, r.amharic, r.placeholders, r.status, r.notes, "", "", ""])])
  );

  const hard: (string | number)[][] = [["file", "line", "text"]];
  const i18nFile = join(ROOT, "src", "lib", "i18n.ts");
  for (const file of walk(join(ROOT, "src")).sort()) {
    if (file === i18nFile) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (ETHIOPIC.test(line)) hard.push([relative(ROOT, file).replace(/\\/g, "/"), i + 1, line.trim()]);
      });
  }
  writeFileSync(join(OUT_DIR, "amharic-hardcoded.csv"), toCsv(hard));

  console.log(JSON.stringify({ total: stat.total, new: stat.new, flags: stat.flags, hardcodedLines: hard.length - 1 }, null, 2));
}

if (/vite-node/.test(process.argv[1] ?? "") && !process.env.VITEST) void main();
