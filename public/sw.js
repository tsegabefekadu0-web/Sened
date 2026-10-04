/*
 * Sened service worker — AGENT-4 (M6.1).
 *
 * Scope of this worker, deliberately small:
 *
 * - Precache the offline desk's own shell so a treasurer who installs the app
 *   can open it with no connection at all.
 * - Serve the app shell from cache when the network is gone.
 * - Leave the ledger API strictly alone. A `POST` to `/api/**` is never served
 *   from a cache, never retried by the worker, and never answered with a
 *   fabricated 200. The outbox in IndexedDB owns retries, because it can
 *   reason about idempotency keys; a service worker cannot.
 *
 * This file is plain ES5-compatible JavaScript with no build step, because it is
 * served verbatim from `public/`. Keep it that way.
 */

/*
 * Caching strategy, per request type (keep docs/architecture/offline-pwa.md §7
 * in step with this table):
 *
 *   /api/**, HMR, non-GET, cross-origin   not handled at all; the browser goes
 *                                         straight to the network. Nothing
 *                                         authenticated is ever stored.
 *   navigations (any page)                network-first. Only the `/offline`
 *                                         document is ever written to the cache;
 *                                         if the network fails, `/offline` is
 *                                         served (other pages are redirected to
 *                                         it, since Next hydrates from the URL).
 *                                         Any other page's HTML is never cached,
 *                                         so a stale or per-user shell cannot be
 *                                         replayed.
 *   /_next/static/**                      cache-first. Next content-hashes these
 *                                         files, so a cached copy can never be
 *                                         stale; a new deploy simply asks for new
 *                                         names.
 *   /manifest.json, /icons/**             network-first, cache fallback.
 *   everything else                       not handled.
 *
 * Updates: `skipWaiting` + `clients.claim` are safe here because (a) navigations
 * are network-first, so a new worker never pins an old HTML shell, (b) hashed
 * assets are keyed by name, so an old page's chunks and a new page's chunks live
 * side by side in the static cache, and (c) the worker holds no state the page
 * depends on. Bump VERSION to drop every cache this worker owns.
 *
 * Background Sync is deliberately not used: the page owns the outbox and drains
 * it itself (and when asked via the message below), which works in every
 * browser, including those without the Sync API.
 *
 * This file is plain ES5-compatible JavaScript with no build step, because it is
 * served verbatim from `public/`. Keep it that way.
 */

var VERSION = "sened-v2";
var SHELL_CACHE = VERSION + "-shell";
var STATIC_CACHE = VERSION + "-static";
var CACHE_PREFIX = "sened-";
var OFFLINE_URL = "/offline";
var SHELL_URLS = [OFFLINE_URL, "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];
var STATIC_PREFIX = "/_next/static/";
var STATIC_CACHE_MAX_ENTRIES = 200;

/* Anything under these prefixes is application data, never a document. */
var NEVER_CACHE = ["/api/", "/_next/webpack-hmr", "/__nextjs"];

/* A response is only worth storing if it is a complete, same-origin, non-redirected 200. */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === "basic" && !response.redirected;
}

/*
 * `/offline` references hashed chunks; without them the cached document would
 * render but never hydrate. Read them out of the HTML and cache them too.
 */
function precacheStaticAssets(html) {
  var found = html.match(/\/_next\/static\/[^"'\\\s<>)]+/g) || [];
  var unique = found.filter(function (value, index) {
    return found.indexOf(value) === index;
  });
  return caches.open(STATIC_CACHE).then(function (cache) {
    return Promise.all(
      unique.map(function (assetUrl) {
        return cache.add(assetUrl).catch(function () {
          /* One missing chunk must not discard the rest. */
        });
      })
    );
  });
}

function precacheShell() {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return Promise.all(
      SHELL_URLS.map(function (shellUrl) {
        return fetch(shellUrl, { cache: "reload" }).then(function (response) {
          if (!isCacheable(response)) {
            throw new Error("not cacheable: " + shellUrl);
          }
          var copy = response.clone();
          return cache.put(shellUrl, response).then(function () {
            return shellUrl === OFFLINE_URL ? copy.text().then(precacheStaticAssets) : null;
          });
        });
      })
    );
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    precacheShell().then(
      function () {
        return self.skipWaiting();
      },
      function () {
        // A failed precache must not block installation. The fetch handler still
        // works and fills the cache as pages are visited online.
        return self.skipWaiting();
      }
    )
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            // Only touch caches this worker family owns.
            var owned = key.indexOf(CACHE_PREFIX) === 0;
            return owned && key !== SHELL_CACHE && key !== STATIC_CACHE ? caches.delete(key) : null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function isNeverCached(url) {
  for (var index = 0; index < NEVER_CACHE.length; index += 1) {
    if (url.pathname.indexOf(NEVER_CACHE[index]) === 0) {
      return true;
    }
  }
  return false;
}

function isShellAsset(url) {
  return url.pathname === "/manifest.json" || url.pathname.indexOf("/icons/") === 0;
}

function trimStaticCache(cache) {
  return cache.keys().then(function (keys) {
    var excess = keys.length - STATIC_CACHE_MAX_ENTRIES;
    // Oldest entries first; a hashed file that is still needed is simply refetched.
    return Promise.all(keys.slice(0, Math.max(excess, 0)).map(function (key) { return cache.delete(key); }));
  });
}

function offlineFallback() {
  return caches.match(OFFLINE_URL, { ignoreSearch: true }).then(function (fallback) {
    return (
      fallback ||
      new Response(
        "<!doctype html><meta charset=\"utf-8\"><title>Sened offline</title>" +
          "<body style=\"font-family:sans-serif;background:#120D0A;color:#F5EFEB;padding:2rem\">" +
          "<h1>Offline</h1><p>This device has not cached the offline desk yet. " +
          "Open Sened once while connected, then it will work without a connection.</p>",
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
      )
    );
  });
}

function handleNavigation(request, url) {
  return fetch(request).then(
    function (response) {
      if (url.pathname.replace(/\/$/, "") === OFFLINE_URL && isCacheable(response)) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          return cache.put(OFFLINE_URL, copy);
        });
      }
      return response;
    },
    function () {
      // Network failure only. A 404/500 from the server is passed through above.
      // Another page's URL must not be answered with the /offline document:
      // Next hydrates from the URL, so /ledger would mount the ledger screen
      // over /offline's HTML. Redirect, so the URL and the document agree.
      if (url.pathname.replace(/\/$/, "") !== OFFLINE_URL) {
        return Response.redirect(OFFLINE_URL, 302);
      }
      return offlineFallback();
    }
  );
}

function handleStatic(request) {
  return caches.open(STATIC_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).then(function (response) {
        if (isCacheable(response)) {
          cache.put(request, response.clone()).then(function () {
            return trimStaticCache(cache);
          });
        }
        return response;
      });
    });
  });
}

function handleShellAsset(request) {
  return fetch(request).then(
    function (response) {
      if (isCacheable(response)) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          return cache.put(request, copy);
        });
      }
      return response;
    },
    function () {
      return caches.match(request).then(function (cached) {
        return cached || new Response("", { status: 504, statusText: "Offline and not cached" });
      });
    }
  );
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }
  if (isNeverCached(url)) {
    return;
  }
  /* Never touch a ledger write. The queue is the only thing allowed to retry. */
  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, url));
  } else if (url.pathname.indexOf(STATIC_PREFIX) === 0) {
    event.respondWith(handleStatic(request));
  } else if (isShellAsset(url)) {
    event.respondWith(handleShellAsset(request));
  }
});

/*
 * The page asks the worker to drain the outbox when connectivity returns.
 * The worker only *forwards* the message to the page — the queue, the backoff
 * and the idempotency keys all live in the page's IndexedDB, so the worker
 * never holds a credential or a ledger payload.
 */
self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "sened:drain-outbox") {
    return;
  }
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) {
      client.postMessage({ type: "sened:outbox-drain-requested" });
    });
  });
});
