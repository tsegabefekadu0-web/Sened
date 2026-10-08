// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");

type Listener = (event: Record<string, unknown>) => void;

/** Run the real worker file against an in-memory CacheStorage and a scripted network. */
function loadWorker(search: string, network: (url: string) => Response | null) {
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, Listener>();
  const keyOf = (request: unknown) => (typeof request === "string" ? request : (request as { url: string }).url).replace(/^https:\/\/app\.test/, "");
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (request: unknown, response: Response) => void store.set(keyOf(request), response),
      add: async (request: unknown) => {
        const response = network(keyOf(request));
        if (!response) throw new Error("miss");
        store.set(keyOf(request), response);
      },
      match: async (request: unknown) => store.get(keyOf(request)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (request: unknown) => store.delete(keyOf(request))
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: unknown) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(request));
        if (hit) return hit;
      }
      return undefined;
    }
  };
  const self = {
    location: { search, origin: "https://app.test" },
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [] }
  };
  const context = vm.createContext({
    self,
    caches,
    Response,
    URL,
    Promise,
    Array,
    Object,
    Boolean,
    Math,
    RegExp,
    String,
    fetch: async (request: unknown) => {
      const response = network(keyOf(request));
      if (!response) throw new TypeError("offline");
      return response;
    }
  });
  vm.runInContext(source, context);
  const fire = async (type: string, extra: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...extra, waitUntil: (p: Promise<unknown>) => (pending = p), respondWith: (p: Promise<unknown>) => (pending = p) });
    return pending;
  };
  return { stores, fire };
}

const basic = (body: string) => {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
};

const offlineHtml = '<html><script src="/_next/static/chunks/offline-a1.js"></script><script src="/_next/static/chunks/offline-b2.js"></script></html>';

function network(url: string): Response | null {
  if (url === "/offline") return basic(offlineHtml);
  if (url === "/manifest.json" || url.startsWith("/icons/") || url.startsWith("/_next/static/")) return basic("x");
  return null;
}

describe("public/sw.js caches", () => {
  it("names its caches after the build id the page registered it with", () => {
    const worker = loadWorker("?v=abc123", network);
    return worker.fire("install").then(() => {
      const names = [...worker.stores.keys()];
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name.startsWith("sened-abc123-"))).toBe(true);
    });
  });

  it("falls back to dev for a missing or hostile id", async () => {
    for (const search of ["", "?v=../../x", "?v=" + "a".repeat(80)]) {
      const worker = loadWorker(search, network);
      await worker.fire("install");
      expect([...worker.stores.keys()].every((name) => name.startsWith("sened-dev-"))).toBe(true);
    }
  });

  it("deletes the previous build caches on activate and keeps the current ones", async () => {
    const old = loadWorker("?v=old1", network);
    await old.fire("install");
    const current = loadWorker("?v=new2", network);
    for (const [name, store] of old.stores) current.stores.set(name, store);
    current.stores.set("other-app-cache", new Map());
    await current.fire("install");
    await current.fire("activate");
    const names = [...current.stores.keys()];
    expect(names.some((name) => name.startsWith("sened-old1-"))).toBe(false);
    expect(names.some((name) => name.startsWith("sened-new2-"))).toBe(true);
    expect(names).toContain("other-app-cache");
  });

  it("keeps the offline page chunks in a cache that the static trim never touches", async () => {
    const worker = loadWorker("?v=t1", network);
    await worker.fire("install");
    const offlineAssets = [...worker.stores.entries()].find(([name]) => name.endsWith("-offline-assets"));
    expect(offlineAssets).toBeDefined();
    expect([...offlineAssets![1].keys()].sort()).toEqual(["/_next/static/chunks/offline-a1.js", "/_next/static/chunks/offline-b2.js"]);
    const staticCache = [...worker.stores.entries()].find(([name]) => name.endsWith("-static"));
    expect(staticCache?.[1].size ?? 0).toBe(0);

    // Visit 250 other hashed files online: the static cache is trimmed to its cap...
    for (let index = 0; index < 250; index += 1) {
      await worker.fire("fetch", {
        request: { url: `https://app.test/_next/static/chunks/page-${index}.js`, method: "GET", mode: "no-cors" }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const trimmed = [...worker.stores.entries()].find(([name]) => name.endsWith("-static"))![1];
    expect(trimmed.size).toBeLessThanOrEqual(200);
    // ...and the offline page chunks are all still there, and served from cache with no network.
    expect([...offlineAssets![1].keys()]).toHaveLength(2);
    const offlineNetwork = loadWorker("?v=t1", () => null);
    for (const [name, store] of worker.stores) offlineNetwork.stores.set(name, store);
    const served = (await offlineNetwork.fire("fetch", {
      request: { url: "https://app.test/_next/static/chunks/offline-a1.js", method: "GET", mode: "no-cors" }
    })) as Response;
    expect(served.status).toBe(200);
  });
});
