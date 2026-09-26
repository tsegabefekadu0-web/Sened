const nextConfig = {
  reactStrictMode: true,

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
        source: "/icons/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        source: "/offline",
        headers: [{ key: "Cache-Control", value: "private, no-store" }]
      }
    ];
  }
};

export default nextConfig;
