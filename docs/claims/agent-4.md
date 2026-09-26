# AGENT-4 Claim — Offline-First PWA (Roadmap M6.1)

| Field | Value |
|---|---|
| Agent | **AGENT-4** |
| Lane | Offline-First PWA (M6.1) |
| Branch | `feat/agent-4-offline-pwa` |
| Branched from | `main` @ `d2eac5b` |
| Start | 2026-09-26T13:10:57+03:00 |
| Status | IN PROGRESS — build complete, verified, committing |

## §3 rows I am taking

| Path | Action |
|---|---|
| `src/lib/db/**` | ➕ new — Dexie / IndexedDB stores |
| `src/lib/offline/**` | ➕ new — sync contract, outbox, conflict detection |
| `src/app/offline/**` | ➕ new — treasurer offline console route |
| `test/db.*.test.ts` | ➕ new |
| `test/offline.*.test.ts` | ➕ new |
| `package.json`, `package-lock.json` | 🔒 **sole installer** — `npm install dexie` only |
| `next.config.mjs` | 🔒 PWA / cache headers |
| `src/app/globals.css` | 🔒 — adding offline/PWA shell rules only |
| `tailwind.config.js` | 🔒 — adding `offline.*` design tokens only |
| `test/setup.ts`, `vitest.config.ts` | 🔒 — shared test config |
| `public/manifest.json` | ➕ new |
| `public/sw.js` | ➕ new |
| `public/icons/**` | ➕ new |
| `docs/architecture/offline-pwa.md` | ➕ new |
| `docs/claims/agent-4.md`, `docs/requests/agent-4.md` | ➕ new (this file + requests) |

## Lane-free check

`docs/claims/` and `docs/requests/` were both **empty** when I started
(2026-09-26T13:10). No other agent had claimed any path. Nothing in my rows was
contested. I did not edit a single file outside the rows above.

## Baseline verified before I touched anything

```
npm run typecheck   clean
npm test            75 passed / 12 files
npm run lint        (run again at handoff)
```

I treat any regression against those 75 tests as a blocker (§9).

## Plan

1. Install `dexie` (only dependency I will add; §4.3).
2. `src/lib/db/**` — Dexie schema for rosters, spoken notes, draft ledger
   entries, outbox, and a sync-cursor/meta table. Every write path validates
   through the **imported** `src/lib/ledger` rules so the offline store can
   never hold a "balanced-looking" entry the server would reject.
3. `src/lib/offline/**` — the typed client contract for Wave 2 server routes,
   the outbox drain with exponential backoff + lease, and hash-chain divergence
   detection. **No last-write-wins merge.**
4. `public/sw.js` + `public/manifest.json` + icons + `next.config.mjs`.
5. `src/app/offline/**` — the treasurer console at `/offline`.
6. Tests — real `fake-indexeddb` usage, negative/security cases included.
7. `docs/architecture/offline-pwa.md`.

## Deliberate non-claims

- **No `/api/sync` route.** Wave 2 (§8.4). The contract is a typed interface.
- **No `src/middleware.ts` edit.** A1 owns it. Request filed in
  `docs/requests/agent-4.md` for the `/sync` bucket wiring.
- **No `src/lib/i18n.ts` edit.** A2 owns it. Every string I need is filed as an
  exact `key` / `en` / `am` triple in `docs/requests/agent-4.md`.
- **No `src/app/layout.tsx` edit.** A1 owns the manifest / theme-color link.
  Requested.

## Progress log

| Time | Status | Note |
|---|---|---|
| 2026-09-26T13:10 | CLAIMED | Branch created from `main` @ `d2eac5b`, lane verified free |
| 2026-09-26T13:11 | IN PROGRESS | Baseline re-verified green (75/12). Beginning `npm install dexie` |
| 2026-09-26T13:15 | IN PROGRESS | `dexie@4.4.6` installed. Sole installer, 1 line in `package.json` + 7 in the lock |
| 2026-09-26T13:30 | IN PROGRESS | `src/lib/db/**` complete: schema, roster, notes, drafts, outbox, mirror, meta, ids |
| 2026-09-26T13:45 | IN PROGRESS | `src/lib/offline/**` complete: contract, chain, engine, transport, backoff, hash, copy |
| 2026-09-26T13:50 | IN PROGRESS | 38 store tests + 41 sync tests green against real `fake-indexeddb` |
| 2026-09-26T14:10 | IN PROGRESS | Service worker, manifest, 4 generated PNG icons, `next.config.mjs` headers |
| 2026-09-26T14:30 | IN PROGRESS | `src/app/offline/**` — the treasurer console |
| 2026-09-26T15:20 | IN PROGRESS | 20 console tests green. 101 tests / 3 files total |
| 2026-09-26T15:30 | IN PROGRESS | `docs/architecture/offline-pwa.md` written, 67 i18n triples filed |
| 2026-09-26T15:35 | IN PROGRESS | `npm run lint` clean · lane typecheck clean · 101/101 mine · 75/12 baseline intact · tree 457/22 |

## Result

**101 tests / 3 files added. 75 baseline tests / 12 files untouched and still
passing. `npm run lint` clean (only the pre-existing App Router font warning).
`tsc --noEmit` clean for every file in my §3 rows.**

### Definition of done (§2), item by item

| Requirement | Met | Evidence |
|---|---|---|
| With the network disabled, read the roster | ✅ | `test/offline.console.test.tsx` sets `navigator.onLine = false` and asserts the honest "No connection" badge and the roster list |
| Record a spoken note | ✅ | Console test types a note, asserts it is stored and labelled `human-typed` |
| Record a draft ledger entry | ✅ | Console test queues a draft; `test/db.stores.test.ts` covers the validation |
| Entries survive a reload | ✅ | Console test unmounts, closes the DB, reopens, and finds the note. `test/db.stores.test.ts` reopens a real database and checks all four tables |
| `fake-indexeddb` genuinely exercised | ✅ | 101 tests; the devDependency that had zero users now backs every DB test |
| The outbox drains on reconnect | ✅ | Drain tests cover accepted, replayable, retry, rate-limited, exhausted, and unconfigured |
| Explicit conflict detection, no merge | ✅ | Five distinct fork shapes detected and tested; no code path merges or rewrites |

### Two things worth A1's attention

1. **A real bug the tests caught, not a design note:** the console's engine memo
   read a ref during first render, where it is always `null`. The console could
   never push anything. A unit test on the engine alone would have missed it.
2. **Installability is one line short.** R2 is marked blocking. `public/manifest.json`
   exists and is correct, but a manifest is not discoverable until
   `src/app/layout.tsx` links it, and that file is A1's.

### Scope discipline

`git diff --name-only main` touches only §3 rows:
`package.json`, `package-lock.json`, `next.config.mjs`, `tailwind.config.js`
(additive tokens only), `src/app/globals.css` (additive rules only),
`test/setup.ts` (additive), `src/lib/db/**`, `src/lib/offline/**`,
`src/app/offline/**`, `public/manifest.json`, `public/sw.js`,
`public/icons/**`, `test/db.stores.test.ts`, `test/offline.sync.test.ts`,
`test/offline.console.test.tsx`, `docs/architecture/offline-pwa.md`,
`docs/claims/agent-4.md`, `docs/requests/agent-4.md`.

Zero edits to anything owned by A1, A2 or A3. `src/lib/ledger/**`,
`src/lib/banking/**`, `src/middleware.ts`, `src/app/page.tsx`,
`src/app/layout.tsx` and `src/lib/i18n.ts` are **imported or filed, never
touched** — every ledger rule the offline store applies is A1's own
`normalizeLedgerEntryRequest`, imported by module path so the browser bundle
never pulls in `node:crypto`.

> ⚠️ **All four agents share one working tree.** A1's `src/lib/banking/**` and
> A2's `src/lib/voice/**` are present and uncommitted in this directory. The
> full-suite numbers include their in-flight work. My verification isolates my
> three files (101/101) and re-confirms the 12 baseline files separately
> (75/75) precisely because the tree is not mine alone.
