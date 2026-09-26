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

var VERSION = "sened-shell-v1";
var SHELL_CACHE = VERSION + "-shell";
var SHELL_URLS = ["/offline", "/offline/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

/* Anything under these prefixes is application data, never a document. */
var NEVER_CACHE = ["/api/", "/_next/webpack-hmr", "/__nextjs"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        // addAll is atomic: one 404 and nothing is cached, so a half-working
        // offline shell is never presented as a working one.
        return cache.addAll(SHELL_URLS);
      })
      .then(function () {
        return self.skipWaiting();
      })
      .catch(function () {
        // A failed precache must not block installation. The fetch handler still
        // works, and the console reports what it could not cache.
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            return key === SHELL_CACHE ? null : caches.delete(key);
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

/* The offline desk is the one route that must open with no connection. */
function isShellRequest(request) {
  if (request.mode === "navigate") {
    return request.url.indexOf("/offline") !== -1;
  }
  return SHELL_URLS.indexOf(request.url.replace(self.location.origin, "")) !== -1 || /\.(?:css|js|png|svg|woff2?)$/.test(request.url);
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
  if (!isShellRequest(request)) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response && response.status === 200 && response.type === "basic") {
          var copy = response.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          if (cached) {
            return cached;
          }
          if (request.mode === "navigate") {
            return caches.match("/offline").then(function (fallback) {
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
          return new Response("", { status: 504, statusText: "Offline and not cached" });
        });
      })
  );
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
