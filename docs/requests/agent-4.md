# AGENT-4 Request Log

> One file per agent, so there is never a shared write target (§4, "Per-agent
> claim & request files"). Target owner, exact file/module, exactly what is
> needed, and whether my lane is blocked without it. One row per request — do
> not bundle unrelated asks.

| # | Target | File / module | What I need | Blocking? | Status |
|---|---|---|---|---|---|
| R1 | **A1** | `src/middleware.ts` | Add `/api/sync` to `RATE_LIMITED` (line 4-8). `resolveRateLimit` (line 27-29) *already* returns `WRITE_RULE` for anything ending in `/sync`, but `isRateLimitedPath` gates on the `RATE_LIMITED` set, so the reserved branch is unreachable. Without it, Wave 2's sync route is unmetered. A1 to add `"/api/sync"` to the set. | No — Wave 2 | CLOSED (done: `"/api/sync"` is in `RATE_LIMITED` in `src/middleware.ts`, commit 2257934) |
| R2 | **A1** | `src/app/layout.tsx` | Add `<link rel="manifest" href="/manifest.json" />` to `<head>` and `manifest: "/manifest.json"` to `export const metadata`. I wrote `public/manifest.json` but a manifest is not discoverable until the document links it, so the PWA is not installable without this one line. | **Yes** — installability cannot be proven without it | CLOSED (done: `manifest: "/manifest.json"` and icons in `src/app/layout.tsx`, commit 2257934) |
| R3 | **A2** | `src/lib/i18n.ts` | Fold in the `offline.*` keys listed in `docs/architecture/offline-pwa.md` §6 (exact `key` / `en` / `am` triples). `MessageKey` is derived from `en` and `am` is `Record<MessageKey, string>`, so a key in `en` without its `am` twin is a compile error — I cannot add these myself (§4.1). Until then `/offline` renders Amharic via a lane-local table in `src/lib/offline/copy.ts` that mirrors the triples exactly. | No — mirrored locally, but the mirror must be deleted at integration | CLOSED (the `offline.*` keys are in `src/lib/i18n.ts`; `src/lib/offline/copy.ts` is now a thin adapter over them, so the duplicate strings are gone, commit 2257934) |
| R4 | **A1** | `src/lib/ledger/canonical.ts` | **No change requested — read only, and a heads-up.** I import `verifyLedgerChain` and `verifyLedgerEntryHash` to detect hash-chain divergence between the local mirror and the server. If A1 changes canonical serialization, my divergence detection stays correct (it re-verifies, it does not recompute), but the **server's** golden vectors in `test/ledger.hash.test.ts` will break by design. No action requested from A1; recording that A4 depends on those two exports keeping their current signatures. | No | NOTED |
| R5 | **A1** | `src/app/api/ledger/entries/route.ts` | **No change requested — information for Wave 2.** The outbox replays drafts to this route using the same `LedgerEntryRequest` body and the caller's `IdempotencyKey`. Wave 2 needs a *batch* pull that returns `LedgerChainHead` per group so the client can detect divergence. I have specified the client half in `docs/architecture/offline-pwa.md` §3; A1 decides whether the server half lands in Wave 2 or later. | No | NOTED (server half landed: `POST /api/sync` handles push and pull, `src/lib/sync/routeHandlers.ts`, commit f8cf45c) |

## Notes for A1 at integration

- `next.config.mjs` (mine) sets `Cache-Control` headers and a
  `Service-Worker-Allowed` scope. If A1's `page.tsx` work needs a header that
  conflicts, A1 wins and I will adjust.
- I added `offline.*` tokens to `tailwind.config.js` and offline-shell rules to
  `src/app/globals.css`. Both are additive; no existing token was renamed or
  removed, so A1-A3 code is unaffected.
- `test/setup.ts` gained nothing destructive — `fake-indexeddb/auto` was already
  imported at line 1 and is still. I did not add a second import.
