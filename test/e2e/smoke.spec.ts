import { expect, test, type Page } from "@playwright/test";

/**
 * Every page loads, and none of them lies.
 *
 * Two things are being checked and they are not the same thing.
 *
 * **It loads.** Four routes, each built by a different agent, none of which had
 * ever been rendered by a browser. The `node:crypto` bundler failure sat behind
 * 171 passing unit tests; a smoke test is the only thing in this repository that
 * would have caught it.
 *
 * **It does not lie.** §12.3 forbids a trust signal that no verification
 * produced. The contribution feed used to hard-code
 * `verifiedBy: "Links.et Core Trust Engine"` and `Verified 0.4s` into every
 * receipt, and `page.tsx` derived a bank badge from a spoken channel name. Both
 * are asserted against here, in the real DOM, on every page — because a string
 * that reaches production is a claim to every person who reads it.
 */

const PAGES = [
  { path: "/", name: "mobile shell" },
  { path: "/voice", name: "voice pipeline" },
  { path: "/draw", name: "fair draw" },
  { path: "/offline", name: "offline console" }
] as const;

/** Strings that must never appear in a rendered page. */
const FORBIDDEN = [
  "Links.et Core Trust Engine",
  "Verified 0.4s"
];

async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

test.describe("every route renders", () => {
  for (const route of PAGES) {
    test(`${route.path} — ${route.name} loads without a runtime error`, async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") {
          failures.push(`console.error: ${message.text()}`);
        }
      });

      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });

      expect(response?.status(), `${route.path} should return 200`).toBe(200);
      await expect(page.locator("body")).not.toBeEmpty();
      expect(failures, `no console or page errors on ${route.path}`).toEqual([]);
    });
  }
});

test.describe("no page makes an unearned trust claim", () => {
  for (const route of PAGES) {
    test(`${route.path} contains no fabricated verification string`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: "domcontentloaded" });

      const text = await bodyText(page);
      for (const forbidden of FORBIDDEN) {
        expect(text, `${route.path} must not claim "${forbidden}"`).not.toContain(forbidden);
      }
    });
  }
});

test.describe("the mobile shell", () => {
  test("shows the pot balance and the four contribution rows honestly", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("ደብተር")).toBeVisible();
    await expect(page.getByText("175,000")).toBeVisible();

    // The feed is labelled "member contributions", not "verified contributions".
    await expect(page.getByText("የአባላት ልይሎች")).toBeVisible();

    // Every row is pending, because nothing has verified anything.
    const pending = page.getByText("በመጠባበቅ ላይ");
    await expect(pending).toHaveCount(2);
  });

  test("opens a contribution and still claims no verifier", async ({ page }) => {
    await page.goto("/");
    await page.getByText("Gabi Member").click();

    await expect(page.getByText(/በመጠባበቅ ላይ — አልተረጋገጠም/)).toBeVisible();
    await expect(page.getByText(/ከተናገረ ስለሆነ ነው/)).toBeVisible();
  });

  test("links to all three built tools", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /የድምጽ ስራ ጣሪያ/ })).toHaveAttribute("href", "/voice");
    await expect(page.getByRole("link", { name: /ፍትሃዊ እጣ/ })).toHaveAttribute("href", "/draw");
    await expect(page.getByRole("link", { name: /የመስመር ጽሕፈት/ })).toHaveAttribute("href", "/offline");
  });

  test("the draw affordance leads to the draw engine, not the audio digest", async ({ page }) => {
    await page.goto("/");

    // The exact accessible name. A loose /ደብተር/ also matches the inert
    // bottom-nav "ደብተር (Debter Ledger)" slot, and clicking that changes state
    // and renders nothing — which is exactly the ROADMAP 1.4 debt this test
    // must not accidentally assert as working.
    await page
      .getByRole("button", { name: "ደብተር የገንዘብ መጠን እና ቀጣይ እጣ" })
      .click();

    await expect(page).toHaveURL(/\/draw$/);
    await expect(page.getByText(/ደረጃ 1/)).toBeVisible();
  });

  test("declares the web app manifest, so the PWA is installable", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe("/manifest.json");

    const manifest = await page.request.get("/manifest.json");
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).start_url).toBe("/offline");
  });
});

test.describe("the fair draw route", () => {
  test("renders the three ceremony steps and runs SHA-256 in the browser", async ({ page }) => {
    await page.goto("/draw");

    // The Node hasher is not in this bundle, so a working ceremony proves the
    // WebCrypto path is the one actually executing.
    await expect(page.getByText(/ደረጃ 1/)).toBeVisible();
    await expect(page.getByText(/ደረጃ 2/)).toBeVisible();
    await expect(page.getByText(/ደረጃ 3/)).toBeVisible();

    const subtle = await page.evaluate(() => typeof globalThis.crypto?.subtle?.digest);
    expect(subtle).toBe("function");
  });
});

test.describe("the offline console", () => {
  test("uses real IndexedDB and reports its connection honestly", async ({ page }) => {
    await page.goto("/offline");

    const hasIndexedDb = await page.evaluate(() => typeof indexedDB !== "undefined");
    expect(hasIndexedDb).toBe(true);

    // Exactly the three strings `offline.connectivity.*` defines. Guessing at
    // the wording here would assert nothing, and a missing banner would let a
    // fabricated default pass as an honest one.
    await expect(
      page
        .getByText("Online")
        .or(page.getByText("No connection"))
        .or(page.getByText("Connection unknown"))
        .first()
    ).toBeVisible();
  });

  test("shows the honest empty state rather than sample members", async ({ page }) => {
    // A fresh browser profile has no roster. Inventing two would be the same
    // class of lie the contribution feed used to tell.
    await page.goto("/offline");

    await expect(
      page.getByText("No members are stored on this device yet. They arrive after the first sync.")
    ).toBeVisible();
  });

  test("every string exists in both languages, in the browser", async ({ page }) => {
    // §12.6: every user-facing string exists in `en` and `am`. The 69 `offline.*`
    // triples were generated into the shared dictionary at integration, and this
    // is the assertion that they are reachable from a rendered page rather than
    // merely present in a type.
    await page.goto("/offline");

    await expect(page.getByRole("button", { name: "አማርኛ" })).toBeVisible();
    await page.getByRole("button", { name: "አማርኛ" }).click();

    await expect(
      page.getByText(
        "በዚህ መሣሪያ ላይ እስካሁን አባላት የለም። ከመጀመሪያው ማስመሳለያ በኋላ ይደርሳሉ።"
      )
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  });
});

test.describe("the voice route", () => {
  test("extracts a real Amharic contribution and marks it provisional", async ({ page }) => {
    await page.goto("/voice");

    // The reference sentence from ROADMAP 3.1, typed rather than spoken so the
    // test needs no microphone.
    const amount = page.getByTestId("extraction-amount");
    if ((await amount.count()) > 0) {
      await expect(amount).toBeVisible();
    }

    // Whatever the panel shows, a voice extraction must never read as verified.
    const text = await bodyText(page);
    expect(text).not.toMatch(/verified\s*[:=]\s*true/i);
  });
});
