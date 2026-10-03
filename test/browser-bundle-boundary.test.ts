import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `node:` import anywhere in a browser bundle breaks the production build.
 *
 * This is not hypothetical. `src/lib/draw/canonical.ts` imported
 * `node:crypto` at the top level for its Node hasher, and `DrawBoard.tsx` — a
 * client component — imports that module for `webDrawHasher`. Webpack refuses
 * the `node:` scheme in a browser target, so `next build` failed outright and
 * `/draw` had never been compiled, let alone shipped. Every test passed: vitest
 * and jsdom resolve `node:crypto` happily, so 171 green draw tests coexisted
 * with a route that could not be built.
 *
 * The lanes below all ship browser code. Server-only files are named in
 * `ALLOWED` and must stay out of any client component's import graph.
 */

const REPO_ROOT = process.cwd();

/** Files permitted to reach for a Node builtin, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/lib/draw/nodeHasher.ts":
    "The Node half of the draw hashing seam. Server and tests only; the browser uses webDrawHasher.",
  "src/lib/draw/service.ts":
    "Server-side draw orchestration. Reached only through /api/draw/*, never from a component."
};

/** Every directory whose contents are reachable from a client component. */
const BROWSER_REACHABLE = [
  "src/lib/draw",
  "src/lib/voice",
  "src/lib/offline",
  "src/lib/db",
  "src/components/draw",
  "src/components/voice",
  "src/app/draw",
  "src/app/voice",
  "src/app/offline"
];

const NODE_BUILTIN = /from\s+["']node:/;

/** Allow-list keys are POSIX-style; scanned paths use the host separator. */
function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function sourceFiles(directory: string): string[] {
  const absolute = join(REPO_ROOT, directory);
  const found: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      found.push(...sourceFiles(relative(REPO_ROOT, child)));
      continue;
    }
    if (child.endsWith(".ts") || child.endsWith(".tsx")) {
      found.push(relative(REPO_ROOT, child));
    }
  }
  return found;
}

describe("no Node builtin is reachable from a browser bundle", () => {
  it("finds the browser-reachable lanes at all", () => {
    // A guard that silently scans nothing is worse than no guard.
    const total = BROWSER_REACHABLE.flatMap(sourceFiles).length;
    expect(total).toBeGreaterThan(20);
  });

  it("keeps node: imports inside the files that are allowed to have them", () => {
    const offenders: string[] = [];

    for (const directory of BROWSER_REACHABLE) {
      for (const file of sourceFiles(directory)) {
        const normalised = toPosix(file);
        if (ALLOWED[normalised]) {
          continue;
        }
        const contents = readFileSync(join(REPO_ROOT, file), "utf8");
        if (NODE_BUILTIN.test(contents)) {
          offenders.push(normalised);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("still has the Node hasher the server and the tests depend on", () => {
    // The fix moved the import rather than deleting the capability. If this
    // fails, the draw server has quietly lost its hashing.
    const contents = readFileSync(join(REPO_ROOT, "src", "lib", "draw", "nodeHasher.ts"), "utf8");
    expect(contents).toContain('from "node:crypto"');
    expect(contents).toContain("nodeDrawHasher");
  });

  it("keeps canonical.ts free of Node builtins so DrawBoard can import it", () => {
    const contents = readFileSync(join(REPO_ROOT, "src", "lib", "draw", "canonical.ts"), "utf8");
    expect(contents).not.toMatch(NODE_BUILTIN);
    // The browser hasher must still be the one the page uses.
    expect(contents).toContain("webDrawHasher");
  });
});
