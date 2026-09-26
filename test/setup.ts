import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

// jsdom implements `crypto.getRandomValues` but not `crypto.subtle`, so WebCrypto
// hashing (used by `src/lib/offline/hash.ts`) is unavailable under test unless
// Node's implementation is installed. This only *adds* capability: browsers get
// `crypto.subtle` in a secure context, and a test asserting the
// CRYPTO_UNAVAILABLE path deletes it again itself.
if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true
  });
}
