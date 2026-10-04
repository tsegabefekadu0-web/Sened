"use client";

import { useEffect } from "react";

export const SERVICE_WORKER_URL = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

/**
 * Whether this page may install the service worker.
 *
 * Production only: in `next dev` a worker would cache stale chunks and fight
 * HMR. Secure contexts only: browsers refuse registration otherwise, and
 * `localhost`/`127.0.0.1` count as secure. Pure so it can be unit-tested.
 */
export function canRegisterServiceWorker(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return false;
  }
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return window.isSecureContext === true && "serviceWorker" in navigator;
}

/**
 * Registers `/sw.js` once, after the page has loaded so it never competes with
 * hydration. The scope matches `Service-Worker-Allowed: /` in `next.config.mjs`.
 * Failure is logged and otherwise ignored: the app works without the worker, it
 * just is not available offline.
 */
export function ServiceWorkerRegistration(): null {
  useEffect(() => {
    if (!canRegisterServiceWorker()) {
      return;
    }

    const register = () => {
      navigator.serviceWorker
        .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE })
        .catch((error: unknown) => {
          console.warn("Sened: service worker registration failed; offline shell unavailable.", error);
        });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
