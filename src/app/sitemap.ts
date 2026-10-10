import { headers } from "next/headers";
import type { MetadataRoute } from "next";

/**
 * Absolute origin for the request in hand, so the sitemap never carries a guessed
 * hostname. The app has no configured production domain yet, and a wrong one here
 * would point every crawler at somebody else's server.
 */
async function origin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (!host) return "http://localhost:3000";
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

/** The public surface: the landing page, its alias, and sign-in. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await origin();
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/welcome`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/sign-in`, lastModified: now, changeFrequency: "yearly", priority: 0.5 }
  ];
}
