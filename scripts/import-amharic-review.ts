/**
 * Applies native-speaker corrections from a reviewed CSV (see
 * docs/i18n/README.md) to the `am` dictionary in src/lib/i18n.ts.
 *
 *   npm run i18n:apply-review -- [reviewed.csv] [--file src/lib/i18n.ts] [--apply]
 *
 * Dry-run by default. Only rows with a non-empty `reviewer_amharic` are
 * considered. A row is refused when its key is unknown, its placeholders differ
 * from the English string, it repeats a key, or the text contains a line
 * break. The `en` block is never modified: only the exact string literal of the
 * matching key inside the `am` block is replaced, everything else is kept
 * byte for byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ApplyChange = { key: string; before: string; after: string };
export type ApplyRefusal = { key: string; reason: string };
export type ApplyResult = { source: string; changes: ApplyChange[]; refused: ApplyRefusal[]; unchanged: string[] };

const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function blockRange(source: string, startPattern: RegExp, endToken: RegExp): [number, number] {
  const start = startPattern.exec(source);
  if (!start) throw new Error(`Could not find dictionary block ${startPattern}`);
  const from = start.index + start[0].length;
  const rest = source.slice(from);
  const end = endToken.exec(rest);
  if (!end) throw new Error(`Could not find end of dictionary block ${startPattern}`);
  return [from, from + end.index];
}

function keyLiteral(block: string, key: string) {
  const re = new RegExp(`^([ \\t]*${escapeRe(JSON.stringify(key))}[ \\t]*:[ \\t]*)(${LITERAL})`, "m");
  const m = re.exec(block);
  return m ? { index: m.index + m[1].length, literal: m[2] } : null;
}

function decode(literal: string): string {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return literal.slice(1, -1);
  }
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[0]).sort();
}

export function applyReview(source: string, csvText: string): ApplyResult {
  const [enFrom, enTo] = blockRange(source, /export const en = \{\r?\n/, /\r?\n\} as const;/);
  const [amFrom, amTo] = blockRange(source, /const am: Record<MessageKey, string> = \{\r?\n/, /\r?\n\};/);
  const enBlock = source.slice(enFrom, enTo);
  let amBlock = source.slice(amFrom, amTo);

  const rows = parseCsv(csvText);
  const header = rows.shift() ?? [];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing column "${name}"`);
    return i;
  };
  const iKey = col("key");
  const iNew = col("reviewer_amharic");

  const changes: ApplyChange[] = [];
  const refused: ApplyRefusal[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();
  const edits: { key: string; value: string }[] = [];

  for (const row of rows) {
    const key = (row[iKey] ?? "").trim();
    const proposed = (row[iNew] ?? "").trim();
    if (!proposed) continue;
    if (seen.has(key)) {
      refused.push({ key, reason: "key appears more than once with a reviewer_amharic value" });
      continue;
    }
    seen.add(key);
    const enLit = keyLiteral(enBlock, key);
    const amLit = keyLiteral(amBlock, key);
    if (!enLit || !amLit) {
      refused.push({ key, reason: "unknown key (not in both en and am)" });
      continue;
    }
    if (/[\r\n]/.test(proposed)) {
      refused.push({ key, reason: "contains a line break" });
      continue;
    }
    const want = placeholdersOf(decode(enLit.literal));
    const got = placeholdersOf(proposed);
    if (want.join("|") !== got.join("|")) {
      refused.push({
        key,
        reason: `placeholders differ: English has [${want.join(" ")}], reviewer text has [${got.join(" ")}]`
      });
      continue;
    }
    edits.push({ key, value: proposed });
  }

  for (const { key, value } of edits) {
    const lit = keyLiteral(amBlock, key)!;
    const before = decode(lit.literal);
    if (before === value) {
      unchanged.push(key);
      continue;
    }
    // JSON.stringify keeps Ge'ez readable and escapes quotes, backslashes and
    // control characters, which is valid TypeScript string syntax.
    amBlock = amBlock.slice(0, lit.index) + JSON.stringify(value) + amBlock.slice(lit.index + lit.literal.length);
    changes.push({ key, before, after: value });
  }

  return { source: source.slice(0, amFrom) + amBlock + source.slice(amTo), changes, refused, unchanged };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const apply = args.includes("--apply");
  const fileIdx = args.indexOf("--file");
  const target = resolve(fileIdx >= 0 ? args[fileIdx + 1] : "src/lib/i18n.ts");
  const positional = args.filter((a, i) => !a.startsWith("--") && !(fileIdx >= 0 && i === fileIdx + 1));
  const csvPath = resolve(positional[0] ?? "docs/i18n/amharic-review.csv");

  const result = applyReview(readFileSync(target, "utf8"), readFileSync(csvPath, "utf8"));
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${csvPath} -> ${target}`);
  for (const c of result.changes) console.log(`\n~ ${c.key}\n  - ${c.before}\n  + ${c.after}`);
  for (const r of result.refused) console.log(`\n! REFUSED ${r.key}: ${r.reason}`);
  console.log(
    `\n${result.changes.length} to change, ${result.unchanged.length} already identical, ${result.refused.length} refused.`
  );
  if (apply && result.changes.length) {
    writeFileSync(target, result.source);
    console.log("Written. Run lint, typecheck and tests, then review the diff.");
  } else if (!apply && result.changes.length) console.log("Nothing written. Re-run with --apply to write.");
  if (result.refused.length) process.exitCode = 1;
}

if (/vite-node/.test(process.argv[1] ?? "") && !process.env.VITEST) main();
