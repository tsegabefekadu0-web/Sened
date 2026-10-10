import { headers } from "next/headers";
import type { MetadataRoute } from "next";

/** Absolute origin for the request in hand — see `sitemap.ts` for why this is derived. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (!host) return "http://localhost:3000";
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The landing page is public marketing, so crawl it. Everything under the app is
 * behind a sign-in and would only cost crawl budget, so it is disallowed.
 *
 * `/sw.js` and `/manifest.json` must stay reachable: a blocked worker means no
 * offline shell, and a blocked manifest means the phone cannot install.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await origin();

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/welcome", "/sign-in", "/sign-up", "/icons/", "/manifest.json", "/sw.js"],
        disallow: ["/home", "/ledger", "/members", "/chat", "/draw", "/voice", "/governance", "/offline", "/account", "/join", "/community", "/api/"]
      }
    ],
    sitemap: `${base}/sitemap.xml`
  };
}
