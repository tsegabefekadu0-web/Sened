import { readFileSync } from "node:fs";

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
  "/home",
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

test("the bottom bar (phone) or the side rail (desktop) reaches every tab and Home again", async ({ page }) => {
  await page.goto("/home");
  const nav = page.getByRole("navigation", { name: /ዋና|Main/ });
  await nav.getByRole("link", { name: "ደብተር" }).click();
  await expect(page).toHaveURL(/\/ledger$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "ውይይት" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "እኔ" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name: "ቤት" }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test("the voice dock opens the sheet, English switches the voice, and the sheet closes", async ({ page }) => {
  await page.goto("/home");
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
    const back = page.locator("a[aria-label]:visible, nav a:visible").first();
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
  await page.goto("/home");
  await expect(page.locator("html")).toHaveAttribute("lang", "am");
  await page.evaluate(() => localStorage.setItem("sened.locale.v1", "en"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Ledger" }).first()).toBeVisible();
});

test.describe("root and landing", () => {
  test("signed out, / shows the landing page, and Start your equb goes to sign-in", async ({ page }) => {
    await page.goto("/");
    // The landing page, not the app Home: its heading, the proverb and no app navigation.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ሰነድ");
    await expect(page.getByText("«ድር ቢያብር አንበሳ ያስር»").first()).toBeVisible();
    await expect(page.locator("a[href='/ledger'], a[href='/chat'], a[href='/account']")).toHaveCount(0);
    await page.getByRole("link", { name: "እቁብዎን ይጀምሩ" }).first().click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("/welcome still works, and the sample link opens the app Home", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ሰነድ");
    await page.getByRole("link", { name: /ናሙና|sample/i }).first().click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("navigation", { name: /ዋና|Main/ })).toBeVisible();
  });

  test("a signed-in member at / sees the app Home, not the landing page", async ({ page }) => {
    // The URL the production build was made with (Playwright does not load .env.local itself).
    let supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      try {
        supabaseUrl = /^NEXT_PUBLIC_SUPABASE_URL="?([^"\s]+)/m.exec(readFileSync(".env.local", "utf8"))?.[1];
      } catch {
        supabaseUrl = undefined;
      }
    }
    test.skip(!supabaseUrl, "the build has no Supabase configured, so there is no session to store");
    const key = `sb-${new URL(supabaseUrl as string).hostname.split(".")[0]}-auth-token`;
    const session = {
      access_token: "e2e.fake.token",
      refresh_token: "e2e-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "00000000-0000-4000-8000-000000000001", email: "member@example.com", aud: "authenticated", role: "authenticated" }
    };
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify(session)] as const);
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: /ዋና|Main/ })).toBeVisible();
    await expect(page.getByText("«ድር ቢያብር አንበሳ ያስር»")).toHaveCount(0);
  });
});

test.describe("desktop layout (1024px and up)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop viewport only");
  });

  test("the side rail replaces the bottom bar and reaches every tab", async ({ page }) => {
    await page.goto("/home");
    const rail = page.getByRole("navigation", { name: /ዋና|Main/ });
    await expect(rail).toBeVisible();
    const box = await rail.boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width ?? 0).toBeGreaterThan(180);
    expect(box?.height ?? 0).toBeGreaterThan(500);
    await expect(rail.getByRole("link", { name: "ቤት" })).toHaveAttribute("aria-current", "page");
    for (const [name, url] of [["ደብተር", /\/ledger$/], ["ውይይት", /\/chat$/], ["እኔ", /\/account$/], ["ቤት", /\/home$/]] as const) {
      await page.getByRole("navigation", { name: /ዋና|Main/ }).getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
    }
  });

  test("the voice sheet is a centred dialog", async ({ page }) => {
    await page.goto("/home");
    await page.getByRole("button", { name: /ድምጽ · English assistant/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);
    const box = await sheet.boundingBox();
    const vp = page.viewportSize();
    expect(box && vp).toBeTruthy();
    const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    expect(Math.abs(cx - (vp?.width ?? 0) / 2)).toBeLessThan(4);
    expect(Math.abs(cy - (vp?.height ?? 0) / 2)).toBeLessThan(40);
  });

  test("Home and Account lay their content out in two columns", async ({ page }) => {
    await page.goto("/home");
    // The share card (with its voice button) is on the left, the round progress on the right.
    const share = page.getByRole("link", { name: /በድምጽ ይመዝግቡ/ });
    const ring = page.getByRole("link", { name: /አባላት|Members/ }).first();
    const [a, b] = [await share.boundingBox(), await ring.boundingBox()];
    expect((b?.x ?? 0) > (a?.x ?? 0) + (a?.width ?? 0) - 1).toBe(true);

    await page.goto("/account");
    const settings = page.getByRole("switch", { name: /ቋንቋ|Language/ }).first();
    const communities = page.getByTestId("sample-communities");
    const [s, c] = [await settings.boundingBox(), await communities.boundingBox()];
    expect((c?.x ?? 0) > (s?.x ?? 0) + (s?.width ?? 0)).toBe(true);
  });

  test("Ledger shows a detail panel beside the lines, and Chat shows the list beside the conversation", async ({ page }) => {
    await page.goto("/ledger");
    const aside = page.getByRole("complementary");
    await expect(aside).toBeVisible();
    await page.locator("li.snd-row").first().click();
    await expect(aside).toContainText(/5,000/);

    await page.goto("/chat/sample");
    await expect(page.getByRole("link", { name: /የቤተሰብ እቁብ/ })).toBeVisible();
    await expect(page.getByTestId("chat-note")).toBeVisible();
    const [l, r] = [await page.getByRole("link", { name: /የቤተሰብ እቁብ/ }).boundingBox(), await page.getByTestId("chat-note").boundingBox()];
    expect((r?.x ?? 0) > (l?.x ?? 0) + (l?.width ?? 0) - 1).toBe(true);
  });

  for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`no horizontal scroll at ${size.width}px on the main screens`, async ({ page }) => {
      await page.setViewportSize(size);
      for (const route of ["/", "/home", "/ledger", "/chat", "/chat/sample", "/account", "/draw", "/members", "/governance", "/welcome"]) {
        await page.goto(route);
        await expect(page.locator("h1").first()).toBeVisible();
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${route} at ${size.width}px`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test("on a phone the side rail is not there", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone viewport only");
  await page.goto("/home");
  const navs = page.getByRole("navigation", { name: /ዋና|Main/ });
  await expect(navs).toHaveCount(1);
  const box = await navs.boundingBox();
  expect((box?.y ?? 0) > 400).toBe(true);
});
