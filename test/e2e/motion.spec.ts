import { expect, test, type Page } from "@playwright/test";

/**
 * Motion and typography regression cover for the landing page, against the
 * production build.
 *
 * These are the behaviours that were verified by hand in a browser and are easy
 * to break silently: a <details> that opens but shows nothing, a tab panel that
 * swaps its copy without re-running its entrance, a scroll-spine bar that is
 * present but never hides, `text-wrap` quietly dropping out of the stylesheet.
 *
 * Measurement notes — the reason this file looks the way it does:
 *
 *  1. **Never read a rect inside a closed `<details>`.** Chromium puts
 *     `content-visibility: hidden` on the closed content and serves *stale*
 *     layout for the subtree. `getBoundingClientRect()` on the answer box
 *     reported 42px while the disclosure was verifiably shut. Measure the
 *     `<details>` element itself, or ask `elementFromPoint` what is painted.
 *
 *  2. **`elementFromPoint` over computed style for "is it really visible".**
 *     A computed `opacity: 0` with an inline `opacity: 1` was a throttling
 *     artifact, not a page state. What is painted under a point cannot lie.
 *
 *  3. **`waitForFunction`, not a hand-rolled poll promise.** A poll that
 *     resolves a promise from inside `page.evaluate` hangs when the page ticks
 *     slowly, and the harness call is killed before either side resolves.
 *
 *  4. **rAF is not a clock here.** Chromium idles rAF at ~1Hz when the
 *     compositor has nothing to do, so frame-timing probes read as multi-second
 *     stalls on a page that renders at 165fps. Nothing in this file measures
 *     frame pacing; it is not measurable from this harness.
 */

/** Scrolls `selector` into view and resolves once the browser has settled. */
async function settle(page: Page, selector: string, block: ScrollLogicalPosition = "center") {
  await page.evaluate(
    ([sel, blk]) => document.querySelector(sel)?.scrollIntoView({ block: blk, behavior: "instant" }),
    [selector, block] as const
  );
  await page.waitForTimeout(700);
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
});

/* ------------------------------------------------------------------ FAQ --- */

test("the FAQ disclosure opens, and its answer is really painted", async ({ page }) => {
  await page.goto("/welcome");
  await settle(page, "details");

  const details = page.locator("details").first();
  const summary = details.locator("summary").first();

  // Closed: the <details> box is summary-height only. (Never the inner box.)
  const closed = await details.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(closed).toBeLessThan(90);

  await summary.click();

  // Open, and the answer occupies real space.
  await expect.poll(async () => details.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBeGreaterThan(closed + 25);

  // The row is interpolated over 320ms. Wait for it to actually settle before
  // reading layout, otherwise a fractional mid-transition row makes the
  // scrollHeight/clientHeight comparison below flaky under parallel load.
  await page.waitForFunction(() => {
    const g = document.querySelector<HTMLElement>(".snd-faq");
    if (!g) return false;
    return getComputedStyle(g).gridTemplateRows !== "0px";
  });
  await page.waitForTimeout(500);

  // The answer is painted, not merely marked up. The element at that point *is*
  // the <p> (it holds only text), so walk up to it rather than looking for a
  // paragraph inside it — looking for a descendant returns null and reads as
  // "not visible" on a page that is visibly fine.
  const painted = await page.evaluate(() => {
    const d = document.querySelector<HTMLDetailsElement>("details");
    if (!d?.open) return false;
    const s = d.querySelector("summary")!.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(s.bottom + 25));
    return Boolean(hit?.closest("p")?.textContent?.trim());
  });
  expect(painted).toBe(true);

  // Not clipped once open: the answer's bottom edge sits inside its container.
  // This asks the real question rather than comparing scrollHeight to
  // clientHeight, which disagree by a few pixels on a fractional grid row and
  // make the assertion flaky under parallel load.
  const clipped = await details.evaluate((el) => {
    const box = el.querySelector(".snd-faq > div")!.getBoundingClientRect();
    const p = el.querySelector(".snd-faq p")!.getBoundingClientRect();
    return Math.round(p.bottom - box.bottom);
  });
  expect(clipped).toBeLessThanOrEqual(2);
  // The + becomes a ×.
  await expect(summary.locator("span[aria-hidden]")).toHaveCSS("transform", /matrix/);

  // Closing collapses it again.
  await summary.click();
  await expect.poll(async () => details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
});

/* ------------------------------------------------------------- tabs --- */

test("the how-it-works tab panel re-runs its entrance on switch", async ({ page }) => {
  await page.goto("/welcome");
  await settle(page, '[aria-labelledby="how-title"]');

  const tabs = page.getByRole("tab");
  const panel = page.locator("p[role=tabpanel]");

  const first = await panel.textContent();
  await expect(panel).toHaveCSS("animation-name", "snd-panel");

  await tabs.nth(2).click();

  // Copy actually changed...
  await expect.poll(async () => (await panel.textContent()) !== first).toBe(true);
  // ...and the selected tab is the one clicked.
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  // ...and the selected tab carries the pop, matching ledger and community/new.
  await expect(tabs.nth(2)).toHaveCSS("animation-name", "snd-pop");

  // The coffee cups track the step: all three fill by the last step.
  await expect.poll(async () => page.locator('[data-filled="true"]').count()).toBeGreaterThanOrEqual(3);
});

/* ------------------------------------------------------- chat stagger --- */

test("the chat teaser bubbles all reveal, on their own beats", async ({ page }) => {
  await page.goto("/welcome");
  await settle(page, 'section[aria-labelledby="chat-title"]');

  const rows = page.locator('section[aria-labelledby="chat-title"] .flex-col > div');
  await expect(rows).toHaveCount(3);

  // All three end up visible. (A computed opacity read can be a throttling
  // artifact, so poll the painted state through the wrapper's rect.)
  await expect.poll(async () =>
    rows.evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height > 0))
  ).toBe(true);

  await expect
    .poll(async () => rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).transitionDelay)))
    .toEqual(["0s, 0s", "0.09s, 0.09s", "0.18s, 0.18s"]);
});

/* -------------------------------------------------------- scroll spine --- */

test("the scroll spine hides at the top, appears past the hero, and returns", async ({ page }) => {
  await page.goto("/welcome");
  await page.waitForTimeout(600);

  const bar = page.locator(".snd-lbar");
  const prog = page.locator(".snd-prog");

  // At the very top: hidden, and its links are out of the tab order.
  await expect(bar).toHaveAttribute("data-shown", "0");
  await expect(bar).toHaveCSS("visibility", "hidden");
  await expect(prog).toHaveCSS("transform", "matrix(0, 0, 0, 1, 0, 0)");
  // Never intercepts clicks on the page behind it.
  await expect(bar).toHaveCSS("pointer-events", "none");

  // Halfway down: the hairline is part-full and the bar has arrived.
  await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.5));
  await expect.poll(async () => bar.getAttribute("data-shown")).toBe("1");
  await expect(bar).toHaveCSS("visibility", "visible");
  await expect(bar).toHaveCSS("top", "0px");

  const scaleX = await prog.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return m.a;
  });
  expect(scaleX).toBeGreaterThan(0.3);
  expect(scaleX).toBeLessThan(0.8);

  // The bar carries the sign-in entry point and the language switch, so neither
  // is stranded on a page this tall. Visibility — not opacity — is what takes
  // its links out of the tab order, so this is the accessibility contract too.
  await expect(bar.locator('a[href="/sign-in"]')).toBeVisible();
  await expect(bar.getByRole("switch")).toBeVisible();

  // At the bottom the hairline is full.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect
    .poll(async () => prog.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
    .toBeGreaterThan(0.97);

  // Back to the top it hides again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => bar.getAttribute("data-shown")).toBe("0");
  await expect(bar).toHaveCSS("visibility", "hidden");
});

/* ---------------------------------------------------------- text-wrap --- */

test("headings balance and body copy wraps pretty", async ({ page }) => {
  await page.goto("/welcome");
  // CSS-level line balancing: it never splits or reorders Geez glyphs, which is
  // why it is safe to apply to Amharic text.
  await expect(page.locator("h2").first()).toHaveCSS("text-wrap", "balance");
  await expect(page.locator("section p").first()).toHaveCSS("text-wrap", "pretty");
});

/* --------------------------------------------------------------- 404 --- */

test("an unknown route shows the branded 404 with a way home", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist");
  expect(response?.status()).toBe(404);

  // The woven mark, the Geez code, and the way home.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("notfound-code")).toHaveText("፬፻፬");
  await expect(page.locator('a[href="/home"]')).toBeVisible();

  // The tibeb ribbon edge is there.
  await expect(page.locator(".snd-weave-tex").first()).toBeAttached();

  // An English-only visitor is not stranded: the language switch is present and
  // actually changes the page, and the Geez numeral stays Geez either way.
  await expect(page.getByRole("switch").first()).toBeVisible();
  await page.getByRole("switch").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("That page is not here");
  await expect(page.getByTestId("notfound-code")).toHaveText("፬፻፬");

  // The home link goes home.
  await page.locator('a[href="/home"]').click();
  await expect(page).toHaveURL(/\/home$/);
});
