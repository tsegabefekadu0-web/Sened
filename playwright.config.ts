import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke coverage, ROADMAP 6.2c.
 *
 * This exists because of a specific, recent failure. `next build` had never run
 * in this repository, and when it finally did it failed immediately:
 * `src/lib/draw/canonical.ts` imported `node:crypto` and is reachable from the
 * client component `DrawBoard.tsx`, so webpack refused the `node:` scheme and
 * `/draw` could not be compiled at all. **171 draw tests were green throughout.**
 * Vitest and jsdom resolve `node:crypto` without complaint, and no unit test,
 * typecheck or lint rule can see a bundler error.
 *
 * So the gap this fills is not "more assertions". It is: does the thing actually
 * load in a browser. Every page below was written, routed and unit-tested by a
 * different agent, and not one of them had ever been rendered by Chromium.
 *
 * It runs against the **production build**, not `next dev`, because the failure
 * above only exists in a production bundle. `npm run build` must therefore
 * precede `npm run test:e2e`; the npm script does both.
 *
 * This supersedes AGENTWORK.md §4.4, which forbade a `playwright.config.ts` in
 * the first wave "until all routes exist". All four routes exist now.
 */

const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Measured, not guessed. Running `test:all` cold — build immediately followed by
  // the browser suite — six workers all issued their first navigation while
  // `next start` was still warming, and five of them hit the 30s navigation
  // timeout. The same forty tests pass in 25s once the server is warm. Fewer
  // workers plus a longer first-navigation budget fixes the cold case without
  // adding a retry that would mask a real hang.
  workers: process.env.CI ? 2 : 4,
  // A failing assertion is a real failure here, not a flake to be papered over.
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The first navigation of a run pays for the server warming up.
    navigationTimeout: 60_000,
    // A treasurer is on a phone in a room with poor signal. The service worker
    // must never turn a failed navigation into a stale cached shell that looks
    // like the live app.
    serviceWorkers: "block"
  },

  projects: [
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] }
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } }
    }
  ],

  webServer: {
    command: `npx next start --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
