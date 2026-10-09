import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end smoke for the rebuilt UI, against the production build.
 *
 * What only a browser can show: every route compiles and renders without a
 * runtime error, the bottom bar and the voice dock work, the theme and language
 * switches change the whole app, and the draw shows a 3D canvas or its CSS
 * fallback. No Supabase is configured in the build, so every screen shows its
 * labelled sample data.
 */

const ROUTES = [
  "/",
  "/ledger",
  "/members",
  "/draw",
  "/draw/manage",
  "/voice",
  "/voice/draft",
  "/offline",
  "/sign-in",
  "/join",
  "/governance",
  "/account",
  "/account/edit",
  "/community/new",
  "/chat",
  "/chat/sample",
  "/welcome"
];

test.beforeEach(async ({ page }) => {
  // Nothing external is reachable in tests; fonts are self-hosted.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
});

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Blocked external requests and the denied microphone are not application errors.
    if (/Failed to load resource|net::ERR|Permission|NotAllowed|getUserMedia/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

for (const route of ROUTES) {
  test(`${route} renders without a runtime error`, async ({ page }) => {
    const errors = watchErrors(page);
    const response = await page.goto(route);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.waitForTimeout(400);
    expect(errors).toEqual([]);
    // No horizontal page scroll at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("the bottom bar reaches every tab and Home again", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: /ዋና|Main/ });
  await nav.getByRole("link", { name: "ደብተር" }).click();
  await expect(page).toHaveURL(/\/ledger$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "ውይይት" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "እኔ" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "ቤት" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the voice dock opens the sheet, English switches the voice, and the sheet closes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /ድምጽ · English assistant/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await sheet.getByRole("switch").click();
  await expect(sheet.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByText("Voxide")).toBeVisible();
  await sheet.getByRole("button", { name: /ዝጋ|Close/ }).click();
  await expect(sheet).toBeHidden();
});

test("the language switch changes the whole app, and the theme switch persists", async ({ page }) => {
  await page.goto("/account");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", /light|dark/);
  await page.getByRole("switch", { name: /መልክ|Appearance/ }).click();
  const theme = await html.getAttribute("data-theme");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", theme ?? "dark");

  await page.getByRole("switch", { name: /ቋንቋ|Language/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Me");
  await page.goto("/ledger");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ledger");
});

test("the draw shows the 3D scene or its CSS ceremony, and a winner", async ({ page }) => {
  await page.goto("/draw");
  await expect(page.getByTestId("draw-canvas")).toBeAttached();
  await expect(page.getByTestId("draw-winner")).toBeVisible({ timeout: 15_000 });
  // Either the canvas has drawn (fallback hidden) or the fallback is showing.
  const fallbackVisible = await page.getByTestId("draw-fallback").isVisible();
  const canvasBox = await page.getByTestId("draw-canvas").boundingBox();
  expect(fallbackVisible || (canvasBox?.width ?? 0) > 100).toBe(true);
  await page.getByRole("button", { name: /እንደገና አሳይ|again/i }).click();
});

test("the draw ceremony is finished at once with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/draw");
  await expect(page.locator("#snd-win")).toHaveClass(/snd-won/, { timeout: 5_000 });
});

test("the chat list opens a channel, and the composer works locally", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("link", { name: /የቦሌ ሰፈር እቁብ/ }).click();
  await expect(page).toHaveURL(/\/chat\/sample$/);
  const input = page.getByRole("textbox", { name: /መልእክት|Message/ });
  await input.fill("ሰላም ለሁላችሁ");
  await page.getByRole("button", { name: /ላክ|Send/ }).first().click();
  await expect(page.getByText("ሰላም ለሁላችሁ")).toBeVisible();
});

test("the landing page leads to sign-in, and has no dead links", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("ሰነድ");
  await expect(page.getByText("«ድር ቢያብር አንበሳ ያስር»").first()).toBeVisible();
  const links = await page.locator("a[href^='/']").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href")));
  for (const href of new Set(links)) {
    if (!href || href.startsWith("#")) continue;
    const res = await page.request.get(href);
    expect(res.status(), href).toBeLessThan(400);
  }
  await page.getByRole("link", { name: "እቁብዎን ይጀምሩ" }).first().click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("every screen reachable from Home has a way back", async ({ page }) => {
  for (const route of ["/draw", "/members", "/voice", "/account/edit", "/community/new"]) {
    await page.goto(route);
    const back = page.locator("a[aria-label], nav a").first();
    await expect(back).toBeVisible();
  }
});

test("treasurer tools are gated: signed out there is a sign-in prompt and no console, and no link on the draw", async ({ page }) => {
  await page.goto("/draw/manage");
  await expect(page.getByTestId("manage-refusal")).toBeVisible();
  await expect(page.getByTestId("manage-treasurer")).toHaveCount(0);
  await expect(page.getByTestId("draw-live")).toHaveCount(0);
  await page.getByRole("link", { name: /ግባ|Sign in/ }).first().click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/draw");
  await expect(page.getByTestId("draw-winner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-link")).toHaveCount(0);
});

test("the document language follows the stored language after a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "am");
  await page.evaluate(() => localStorage.setItem("sened.locale.v1", "en"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Ledger" }).first()).toBeVisible();
});
