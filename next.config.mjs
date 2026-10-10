/*
 * One id per build, stamped into the client bundle and into Next's own build id.
 * The service worker names its caches after it (see public/sw.js), so a deploy
 * can never leave an old build's cached files in play and nobody has to remember
 * to bump a version by hand. CI can pin it (SENED_BUILD_ID / the commit sha).
 */
const rawBuildId =
  process.env.SENED_BUILD_ID || process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || Date.now().toString(36);
const BUILD_ID = rawBuildId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 12) || "build";

const nextConfig = {
  reactStrictMode: true,
  // gzip responses in the Node server (the host's proxy is not known to do it);
  // matters on slow mobile links. Also drop the X-Powered-By header.
  compress: true,
  poweredByHeader: false,

  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  generateBuildId: async () => BUILD_ID,

  /*
   * Standalone output — A1, added with the Dockerfile (ROADMAP M6.3).
   *
   * `next build` normally emits the whole `node_modules` tree alongside the app
   * and expects it to be present at runtime. That works on a laptop and makes a
   * container image enormous, because the dependency tree for a Next app is
   * several hundred megabytes of build tooling the server never loads.
   *
   * `standalone` emits a self-contained server plus only the modules actually
   * imported, so the image can ship `node .next/standalone/server.js` and
   * nothing else. It changes the *output layout*, not the app: the same
   * `next build` and the same tests.
   */
  output: "standalone",

  /*
   * PWA / offline shell headers — AGENT-4 (M6.1).
   *
   * Two things matter here and both are easy to get wrong by omission:
   *
   * 1. `sw.js` must be served with `Cache-Control: no-cache` and a
   *    `Service-Worker-Allowed: /` scope. Without the scope header a worker
   *    served from `/sw.js` can only control `/`, which happens to be fine
   *    today, but the moment the app moves under a prefix the install breaks
   *    silently. `no-cache` does not mean "do not store" — it means "revalidate
   *    every time", which is the only correct policy for a worker whose whole
   *    job is to replace itself on a new deploy.
   * 2. The manifest and the icons must be cacheable, or every cold start pays
   *    for them.
   *
   * Ledger and bank API responses are explicitly left untouched: those belong
   *    to A1, and a cached `POST` result would be a fabricated success.
   */
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" }
        ]
      },
      {
        source: "/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json; charset=utf-8" }
        ]
      },
      {
        // Not `immutable`: the icon filenames are not content-hashed, so a changed
        // icon must be able to reach installed apps. A day, then revalidate.
        source: "/icons/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }]
      },
      {
        source: "/offline",
        headers: [{ key: "Cache-Control", value: "private, no-store" }]
      }
    ];
  }
};

export default nextConfig;
