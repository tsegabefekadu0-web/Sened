import { expect, test } from "@playwright/test";

/**
 * Invite links in a real browser, against the production build.
 *
 * The build has no Supabase configuration, so nobody can be signed in here and
 * the signed-in states (joined, expired, owner controls) are covered by the
 * component tests. What only a browser can show, and is asserted here:
 *
 *   - /join renders and compiles in the production bundle;
 *   - the token in the URL fragment is read and then removed from the address bar;
 *   - the token is never sent anywhere (no request URL or body contains it),
 *     with all external network blocked and every /api call recorded;
 *   - /ledger shows the "Group members" panel with an honest signed-out state.
 */

const TOKEN = "e".repeat(64);

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
});

test("/join with no token says it needs an invite link", async ({ page }) => {
  await page.goto("/join");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("join-outcome")).toBeVisible();
});

test("/join reads the fragment token, strips it from the URL, and never sends it", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
  });

  await page.goto(`/join#token=${TOKEN}`);
  await expect(page.getByTestId("join-outcome")).toBeVisible();

  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(TOKEN);
  expect(requests.filter((entry) => entry.includes(TOKEN))).toEqual([]);
});

test("/ledger shows the Group members panel, signed out", async ({ page }) => {
  await page.goto("/ledger");
  const panel = page.locator("#members");
  await expect(panel.getByRole("heading", { name: "Group members" })).toBeVisible();
  await expect(panel).toContainText("Sign in to see the members of your group.");
  await expect(panel.getByRole("button", { name: "Create invite link" })).toHaveCount(0);
});
