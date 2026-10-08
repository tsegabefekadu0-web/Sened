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
  { path: "/governance", name: "governance copilot" },
  { path: "/ledger", name: "ledger review" },
  { path: "/offline", name: "offline console" },
  { path: "/sign-in", name: "sign-in (unconfigured)" }
] as const;

/** Strings that must never appear in a rendered page. */
const FORBIDDEN = [
  "Links.et Core Trust Engine",
  "Verified 0.4s"
];

async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/**
 * Block everything that is not served by this app.
 *
 * The app serves its own fonts (`next/font` self-hosts them at build time), so
 * nothing here should reach a third party. This stays as hygiene: a stray
 * external request, such as a CDN that hangs, would otherwise stall the `load`
 * event and make navigation flaky, and blocking it makes every run
 * deterministic and any regression visible as a failed request.
 */
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
});

test.describe("every route renders", () => {
  for (const route of PAGES) {
    test(`${route.path} — ${route.name} loads without a runtime error`, async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") {
          return;
        }
        failures.push(`console.error: ${message.text()}`);
      });

      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });

      expect(response?.status(), `${route.path} should return 200`).toBe(200);
      await expect(page.locator("body")).not.toBeEmpty();
      expect(failures, `no application errors on ${route.path}`).toEqual([]);
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

    // By the card's own accessible name. A bare getByText("ደብተር") matches the
    // card heading *and* the workspace link's label, and `exact: true` does not
    // help because the link's inner span is that one word too.
    await expect(
      page.getByRole("button", { name: "ደብተር የገንዘብ መጠን እና ቀጣይ እጣ" })
    ).toBeVisible();
    await expect(page.getByText("175,000")).toBeVisible();

    // The feed is labelled "member contributions", not "verified contributions".
    await expect(page.getByText("የአባላት ልይሎች")).toBeVisible();

    // Every row is pending, because nothing has verified anything.
    const pending = page.getByText("በመጠባበቅ ላይ");
    await expect(pending).toHaveCount(2);
  });

  test("opens a contribution and still claims no verifier", async ({ page }) => {
    await page.goto("/");
    await page.getByText("ወ/ሮ አልማዝ ተ").click();

    await expect(page.getByText(/በመጠባበቅ ላይ፤ አልተረጋገጠም/)).toBeVisible();
    await expect(page.getByText(/ከተናገረ ስለሆነ ነው/)).toBeVisible();
  });

  test("links to all four built tools", async ({ page }) => {
    await page.goto("/");

    // Asserted on hrefs, not on label wording. The four routes are the contract;
    // the copy above them is design, and it changes. A test that fails when
    // someone shortens a nav label is measuring the wrong thing.
    const hrefs = await page
      .locator("nav a[href]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));

    for (const route of ["/voice", "/draw", "/ledger", "/offline"]) {
      expect(hrefs, `the shell should link ${route}`).toContain(route);
    }
  });

  test("the bottom-nav slots say something, instead of changing state and showing nothing", async ({
    page
  }) => {
    // Four tabs used to set state and render nothing, which is a control that
    // lies about being a feature. Each now either has a destination or says it
    // is not built.
    await page.goto("/");

    // By role and exact name. The microphone button is also a `button` in that
    // nav, so counting by position is fragile, and a loose text match for
    // "ደብተር" also catches the Debter card and the workspace link.
    await page.getByRole("button", { name: "መለያ", exact: true }).click();
    const profile = page.getByRole("region", { name: "መለያ", exact: true });
    await expect(profile).toBeVisible();
    await expect(profile).toHaveText(/ገና አልተገነበም/);
  });

  test("the ledger and draw slots in the bottom bar open their real screens", async ({ page }) => {
    await page.goto("/");

    const bar = page.getByRole("navigation", { name: "ዋና ዝርዝር" });
    await expect(bar.getByRole("link", { name: "ደብተር", exact: true })).toHaveAttribute("href", "/ledger");
    await expect(bar.getByRole("link", { name: "እጣ", exact: true })).toHaveAttribute("href", "/draw");
    await bar.getByRole("link", { name: "ደብተር", exact: true }).click();

    await expect(page).toHaveURL(/\/ledger$/);
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
    await expect(page.getByText("እጣውን መቆለፍ").first()).toBeVisible();
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

test.describe("the ledger review route", () => {
  // 847 lines of built, translated UI that no route rendered until now. It is the
  // only view showing the chain seal and the pending / manual-review split.
  test("shows the integrity seal and every reconciliation state", async ({ page }) => {
    await page.goto("/ledger");

    await expect(page.getByText("Ledger integrity")).toBeVisible();
    await expect(page.getByText("Chain intact")).toBeVisible();
    await expect(page.getByText("Ledger verified")).toBeVisible();
    await expect(page.getByText(/Pending reconciliation/).first()).toBeVisible();
    await expect(page.getByText(/Manual review required/).first()).toBeVisible();
  });

  test("says it is a fixture, because that is what it is", async ({ page }) => {
    await page.goto("/ledger");

    // A treasury that mistook this for live data would be worse than having no
    // dashboard at all. The honest labelling is the feature.
    const text = await bodyText(page);
    expect(text).toMatch(/demo|fixture|read-only/i);
    expect(text).not.toContain("Links.et Core Trust Engine");
  });

  test("requires a rationale before a compensating entry, and calls it a demo", async ({
    page
  }) => {
    await page.goto("/ledger");

    await page.getByRole("button", { name: "Start a correction" }).first().click();
    await expect(page.getByText(/Demo only/i).first()).toBeVisible();

    const submit = page.getByRole("button", { name: "Create compensating entry" });
    await submit.click();
    // The rationale rule and the target rule can both be unmet at once, so match
    // the one this action is about rather than assuming a single alert.
    await expect(page.getByRole("alert").filter({ hasText: /rationale/i }).first()).toBeVisible();

    await page.getByRole("textbox", { name: /Correction rationale/i }).fill("Duplicate contribution recorded");
    await submit.click();

    const status = page.getByRole("status").first();
    await expect(status).toBeVisible();
    // Whatever the outcome, it must not claim to have reached a live ledger.
    await expect(status).toHaveText(/no live ledger|demo/i);
  });
});

test.describe("the record-contribution section", () => {
  test("is reachable, offers a signed-out visitor no form, and does not widen the page", async ({ page }) => {
    await page.goto("/ledger#record-contribution");

    await expect(page.getByRole("heading", { name: "Record a contribution" })).toBeVisible();
    await expect(page.getByTestId("record-state")).toHaveText(/Sign in as the group's owner or treasurer/);
    // No controls and nothing posted: a form that cannot work is not shown.
    await expect(page.getByLabel("Amount in birr")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Record contribution" })).toHaveCount(0);
    // Phone width: the section must not add a horizontal scrollbar.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("the fair draw route", () => {
  test("renders the three ceremony steps and runs SHA-256 in the browser", async ({ page }) => {
    await page.goto("/draw");

    // The Node hasher is not in this bundle, so a working ceremony proves the
    // WebCrypto path is the one actually executing.
    await expect(page.getByText("እጣውን መቆለፍ").first()).toBeVisible();
    await expect(page.getByText(/አሸናፊውን መምረጥ/).first()).toBeVisible();
    await expect(page.getByText(/ማረጋገጥ/).first()).toBeVisible();

    const subtle = await page.evaluate(() => typeof globalThis.crypto?.subtle?.digest);
    expect(subtle).toBe("function");
  });
});

test.describe("the offline console", () => {
  test("uses real IndexedDB and reports its connection honestly", async ({ page }) => {
    await page.goto("/offline?debug=1");

    const hasIndexedDb = await page.evaluate(() => typeof indexedDB !== "undefined");
    expect(hasIndexedDb).toBe(true);

    // Exactly the three strings `offline.connectivity.*` defines. Guessing at
    // the wording here would assert nothing, and a missing banner would let a
    // fabricated default pass as an honest one. (The developer desk, ?debug=1.)
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
    await page.goto("/offline?debug=1");

    await expect(
      page.getByText("No members are stored on this device yet. They arrive after the first sync.")
    ).toBeVisible();
  });

  test("every string exists in both languages, in the browser", async ({ page }) => {
    // §12.6: every user-facing string exists in `en` and `am`. The 69 `offline.*`
    // triples were generated into the shared dictionary at integration, and this
    // is the assertion that they are reachable from a rendered page rather than
    // merely present in a type.
    await page.goto("/offline?debug=1");

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
  const SENTENCE = "ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው";

  test("reads a typed Amharic contribution back in Amharic and marks it provisional", async ({ page }) => {
    await page.goto("/voice");

    await page.getByRole("button", { name: "ወይም ይጻፉ" }).click();
    await page.getByLabel("የተሰማው").fill(SENTENCE);

    await expect(page.getByTestId("extraction-amount")).toHaveText("5,000 ብር");
    await expect(page.getByText("መስከረም", { exact: true })).toBeVisible();
    // Never Latin month names or ETB in Amharic mode.
    const text = await bodyText(page);
    expect(text).not.toMatch(/Meskerem|ETB/);
    expect(text).toContain("ይህ ረቂቅ ብቻ ነው");
    // A voice extraction must never read as verified.
    expect(text).not.toMatch(/verified\s*[:=]\s*true/i);
  });

  test("keeps the developer lab behind ?debug=1", async ({ page }) => {
    await page.goto("/voice");
    expect(await bodyText(page)).not.toMatch(/ZERO-TRUST|Entity extraction|Speech providers/i);

    await page.goto("/voice?debug=1");
    await expect(page.getByRole("heading", { name: /Entity extraction/i })).toBeVisible();
  });
});

test.describe("no screen is a dead end", () => {
  // As an installed app there is no browser back button, so every main screen
  // must carry the same bottom bar and a way home.
  for (const path of ["/draw", "/ledger", "/governance", "/offline", "/voice"]) {
    test(path + " has the bottom bar and leads home", async ({ page }) => {
      await page.goto(path);
      // Hidden controls are not matched, so on a wide ledger this finds the home link
      // at the top and on a phone it finds the bottom bar.
      const home = page.getByRole("link", { name: /^(መነሻ|Home|Back home)$/ }).first();
      await expect(home).toBeVisible();
      await home.click();
      await expect(page).toHaveURL(/\/$/);
    });
  }
});

test.describe("the mic dock records a spoken contribution for real", () => {
  // The end-to-end proof that `/` is no longer a dead end. Before this, the
  // submit control in the shell was permanently disabled: a working Amharic
  // parser led to a button that could never be pressed.
  test("records a typed Amharic contribution locally and shows it as provisional", async ({
    page
  }) => {
    await page.goto("/");

    // The reference rows only render once the session has resolved to signed-out
    // (until then the page is in its "loading" state with no feed). The sample
    // notice is shown in exactly that state, so waiting on it is the real signal
    // that hydration finished; counting earlier reads 0 and races the sample rows.
    await expect(page.getByText(/ይህ የናሙና መረጃ ነው፤ የቡድንዎ መዝገብ አይደለም/)).toBeVisible();
    const before = await page.getByText("በመጠባበቅ ላይ").count();

    // The mic dock opens the modal.
    await page.getByRole("button", { name: /በድምጽ አስመዝግብ/ }).click();

    // No microphone in CI, so the modal offers to type instead.
    await page.getByRole("button", { name: "ወይም ይጻፉ" }).click();
    await page
      .getByLabel("የተሰማው")
      .fill("ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው");

    const record = page.getByRole("button", { name: "በዚህ መሣሪያ ላይ አስቀምጥ" });
    await expect(record).toBeEnabled();

    // The sheet must not promise a receipt: a draft until the bank check.
    await expect(page.getByText(/የባንክ ማረጋገጫ ሲደርስ የመጨረሻ ይሆናል/)).toBeVisible();

    await record.click();

    // The new row is identified by the reference the parser extracted. Waiting on
    // the row itself is what proves the state settled; the mic button in the nav
    // is visible whether or not the modal is still open, so asserting on it
    // would pass before React had re-rendered anything.
    const recorded = page.getByText("ቁጥር: 9BF42");
    await expect(recorded).toBeVisible();
    await expect(page.getByText("የተናገረ ልይል")).toBeVisible();
    await expect.poll(() => page.getByText("በመጠባበቅ ላይ").count()).toBe(before + 1);

    // Opening it states the amount and, still, no verifier.
    await recorded.click();
    await expect(page.getByText("5,000 ብር")).toBeVisible();
    await expect(page.getByText(/በመጠባበቅ ላይ፤ አልተረጋገጠም/)).toBeVisible();

    const text = await bodyText(page);
    expect(text).not.toContain("Links.et Core Trust Engine");
    expect(text).not.toMatch(/Verified 0\.4s/);
  });

  test("the note is written to the device, not just to React state", async ({ page }) => {
    // The CBE fixture from `test/voice.parser.test.ts`, which the parser's own
    // benchmark suite asserts is a sound extraction. Inventing phrasing here
    // would test my spelling of Amharic rather than the product.
    const sentence =
      "\u12a5\u1241\u1265 1,500 \u1265\u122d \u1232\u1262\u12a2 \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u12a0\u12ed\u12f6 4KP11Z";

    await page.goto("/");
    await page.getByRole("button", { name: /በድምጽ አስመዝግብ/ }).click();
    await page.getByRole("button", { name: "ወይም ይጻፉ" }).click();
    await page.getByLabel("የተሰማው").fill(sentence);

    const record = page.getByRole("button", { name: "በዚህ መሣሪያ ላይ አስቀምጥ" });
    await expect(record).toBeEnabled();
    await record.click();
    await expect(page.getByText("ቁጥር: 4KP11Z")).toBeVisible();

    // The row disappearing on reload is expected — it is React state. What
    // proves the write is the note in IndexedDB, which is where A4's sync queue
    // will find it.
    const stored = await page.evaluate(async () => {
      const request = indexedDB.open("sened-offline");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const upgraded = request.result;
          if (!upgraded.objectStoreNames.contains("spokenNotes")) {
            upgraded.createObjectStore("spokenNotes", { keyPath: "id" });
          }
        };
      });
      const tx = db.transaction("spokenNotes", "readonly");
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const getAll = tx.objectStore("spokenNotes").getAll();
        getAll.onsuccess = () => resolve(getAll.result as unknown[]);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      return rows as { transcript: string; transcriptSource: string; amountEtb: string; contentHash: string }[];
    });

    const note = stored.find((row) => row.transcript.includes("4KP11Z"));
    expect(note, "the note should be in the device store").toBeDefined();
    expect(note?.transcriptSource).toBe("human-typed");
    expect(note?.amountEtb).toBe("1500.00");
    // Content-hashed by A4's own code, so a note cannot be edited in place
    // without detection.
    expect(note?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

test.describe("service worker and the offline shell", () => {
  // playwright.config.ts blocks workers for every other test so a cached shell
  // cannot mask a regression; this one exists to prove the worker works.
  test.use({ serviceWorkers: "allow" });

  test("registers, takes control, and serves /offline with no connection", async ({ page, context }) => {
    await page.goto("/offline", { waitUntil: "load" });

    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active ? registration.scope : null;
    });
    expect(scope, "an active service worker should control the origin").toMatch(/\/$/);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    // The worker precaches the document and its hashed chunks while installing.
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const key of keys) {
        for (const request of await (await caches.open(key)).keys()) {
          urls.push(new URL(request.url).pathname);
        }
      }
      return urls;
    });
    expect(cached).toContain("/offline");
    expect(cached.some((path) => path.startsWith("/_next/static/"))).toBe(true);
    expect(cached.some((path) => path.startsWith("/api/"))).toBe(false);

    await context.setOffline(true);
    try {
      // Playwright's offline emulation reaches a service worker only until its
      // first navigation, so this test makes exactly one offline navigation and
      // first proves the worker really has no network (otherwise a pass here
      // could just be the live server answering).
      const workerReachesNetwork = await context.serviceWorkers()[0].evaluate(() =>
        fetch("/offline", { cache: "no-store" }).then(
          () => true,
          () => false
        )
      );
      expect(workerReachesNetwork, "the worker must be offline for this test to mean anything").toBe(false);

      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));

      // A page that was never cached redirects to the offline desk, which is
      // served from the precache, so URL and document agree for hydration.
      await page.goto("/ledger", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/offline$/);
      await expect(page.getByText("Saved while offline").or(page.getByText("ያለ ኢንተርኔት የተቀመጡ")).first()).toBeVisible();
      expect(failures).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
  });
});
