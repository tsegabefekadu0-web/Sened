# AGENT-3 — Claim: Verifiably Fair Draw Engine (እጣ) — Roadmap **M4**

| Field | Value |
|---|---|
| Agent | **AGENT-3** |
| Lane | Verifiably Fair Draw Engine — Roadmap **M4** (`ROADMAP.md` §4) |
| Branch | `feat/agent-3-draw` |
| Branched from | `main` @ `d2eac5b` (baseline: 129 files, 75 tests / 12 files) |
| Start time | 2026-09-26 |
| Status | **DONE (`c2f127b`)** — all 5 board items complete |

Greenfield milestone. Nothing existed at `main` beyond decorative artwork
(`public/reference_assets/mesob_*.png`) and two dead components with zero
importers.

## §3 rows I am taking (exhaustive)

| Path | Nature |
|---|---|
| `src/lib/draw/**` | ➕ new — commit-reveal hashing, draw engine, rotation, service, repository, schemas |
| `src/app/api/draw/**` | ➕ new — draw routes |
| `src/app/draw/**` | ➕ new — my own route, for browser proof |
| `src/components/draw/**` | ➕ new — ceremonial Mesob draw UI |
| `src/components/draw/draw.css` | ➕ new — my keyframes (NOT `globals.css`, §4.2) |
| `test/draw.*.test.ts` | ➕ new |
| `supabase/migrations/20260926100000_draw_commit_reveal.sql` | ➕ new — this exact filename |
| `docs/architecture/draw.md` | ➕ new |
| `docs/claims/agent-3.md`, `docs/requests/agent-3.md` | ➕ new (per-agent, no shared writes) |

New i18n keys are confined to my prefix: **`draw.*`**. I do not own
`src/lib/i18n.ts`; every string I need is filed as an exact `key` / `en` / `am`
triple in `docs/requests/agent-3.md`.

## §5 step 3 — lane-free check

| Other agent | Claim file | Conflicts with my rows? |
|---|---|---|
| A1 | *(no claim file yet — not started)* | none |
| A2 | `docs/claims/agent-2.md` | none — A2 claims `src/lib/voice/**`, `src/app/api/voice/**`, `src/app/voice/**`, `src/components/voice/*`, `src/lib/i18n.ts` |
| A4 | `docs/claims/agent-4.md` | none — A4 claims `src/lib/db/**`, `src/lib/offline/**`, `src/app/offline/**`, `package.json`, `globals.css`, `tailwind.config.js` |

**Lane is free. No conflict to report to the human.**

## Plan (mapped to the §6 cross-lane task board)

| # | Task | Board # | Status |
|---|---|---|---|
| 1 | Commit-reveal SHA-256 draw + tamper detection | 9 | ✅ `src/lib/draw/canonical.ts`, `engine.ts` |
| 2 | Winner rotation + default-risk / reserve model | 10 | ✅ `src/lib/draw/rotation.ts`, `risk.ts` |
| 3 | Mesob draw animation (adopt the dead assets) | 11 | ✅ `src/components/draw/` |
| 4 | SQL migration `20260926100000_draw_commit_reveal.sql` | — | ✅ applied to real Postgres 16 |
| 5 | Payout posted through `LedgerService.append` | — | ✅ `src/lib/draw/service.ts` |

## Definition of Done (§9)

| Check | Result |
|---|---|
| `npm run lint` | clean (1 pre-existing `layout.tsx` font warning, not mine) |
| `npm run typecheck` | clean, `strict: true` |
| `npm test` — my lane alone | **171 passed / 16 files** (75 baseline + 96 mine) |
| `npm test` — integrated with A1+A2+A4 | **519 passed / 25 files**, zero cross-lane conflicts |
| Zero edits outside my §3 rows | every file I created is new; no existing file modified |
| Both `en` and `am` for every string | `src/components/draw/copy.ts`; `draw.*` triples filed as R-3 |
| Keys confined to my prefix | `draw.*` only, and only in the request log — I did not edit `i18n.ts` |
| Negative / security cases | spoofed fields, numeric money, weak entropy, nonce-equals-seed, duplicate members, 403, 429 gap, unconfigured, tampered seed, tampered commitment, roster edits, ticket swaps, server-vs-arithmetic disagreement, repeat winner, broken hasher |
| No secrets or real transactions | none; all fixtures are synthetic UUIDs |
| Fail closed | verified: refused reveal names no winner; broken hasher → `INTEGRITY_FAILURE`; unconfigured → 503 |
| Claim row updated | this file |
| PR | `c2f127b` on `feat/agent-3-draw`, 32 files, +7204. Branch is the integration point, so the commit sits on top of `cec7cc4`. |

> A1 moved this branch onto the integrated head (`cec7cc4`) while I was working,
> so I re-ran every check against the tree that now contains all four lanes. My
> code typechecks and lints clean next to A2's voice pipeline and A4's offline
> PWA, and the whole suite is green.

## What I verified beyond the test suite

I applied `20260924214531_ledger_core.sql` + my migration to a real
`postgres:16-alpine`, applied mine twice to prove idempotency, and exercised
commit → reveal → payout against the live RPCs. 15 behaviours confirmed,
including the append-only triggers, the rotation check, the reserve-split check,
RLS tenant isolation, and the abandoned-commitment counter. Two real bugs were
caught and fixed this way that the TypeScript tests could not have found. Full
table in `docs/architecture/draw.md` §9.

That run also found a **blocking bug in AGENT-1's committed migration**
(`20260925120000_bank_verification_reconciliation.sql:285` uses
`schema.table%rowtype`, which PostgreSQL rejects). Filed as **R-6**. It is not my
file, so I did not touch it.

## Residual risk I am not hiding

**The single-commitment scheme does not prevent a treasurer from searching seeds
for a preferred winner.** It prevents roster edits, post-hoc commitment changes,
and lies about the outcome — but not seed shopping. I implemented a detection
mechanism (abandoned commitments are counted and surfaced as a governance
warning) rather than pretending the problem is solved, and documented the
standard fix — dual commit, where every member commits their own nonce — as the
recommended M4.3. Reasoning and options in `docs/architecture/draw.md` §5.

## Progress log

| Time | Status | Note |
|---|---|---|
| 2026-09-26 | CLAIMED | Read `AGENTWORK.md` (530 lines) + `docs/AGENT_BRIEFINGS.md`. Branched from `main` @ `d2eac5b`. Lane verified free against A2 + A4 claims. |
| 2026-09-26 | BASELINE | Verified green before touching anything: 75 tests / 12 files, typecheck clean. Set up an isolated `git worktree` at a temp path so my checks would not be polluted by A1/A2/A4's in-flight edits to the shared tree. |
| 2026-09-26 | ENGINE | `canonical.ts`, `engine.ts`, `rotation.ts`, `risk.ts`, `types.ts`, `errors.ts`. 34 engine tests. Caught a real fail-closed bug: a commitment mismatch was still reporting a winner. |
| 2026-09-26 | SERVICE | `repository.ts`, `service.ts`, `schemas.ts`, `server.ts`, `routeHandlers.ts`, 5 routes. Fixed a design flaw where a retried commit minted a second seed and conflicted with itself. 19 service tests. |
| 2026-09-26 | ROUTES | 32 route tests. Found and repaired UTF-8 damage to Ge'ez literals that a PowerShell round-trip had caused in my own test files. |
| 2026-09-26 | SQL | Migration written, then **actually applied to `postgres:16-alpine`**. Fixed an inverted `state` derivation and a multi-column subquery. Found A1's blocking `%rowtype` bug → R-6. |
| 2026-09-26 | UI | `draw.css`, `MesobCeremony`, `VerifyPanel`, `RiskPanel`, `DrawBoard`, `copy.ts`, `/draw` route. Adopts both dead Mesob assets. 11 UI tests. |
| 2026-09-26 | DONE | lint clean · typecheck clean · **171 tests / 16 files** on my lane, **519 / 25** integrated with A1+A2+A4. Zero edits outside my §3 rows. |


## Explicitly NOT my lane

- **Board #14 (voice → bank-verification wiring)** — A1's, deferred to
  integration. Not mine.
- Any edit to `src/lib/ledger/**`, `src/lib/banking/**`, `src/lib/db/**`,
  `src/lib/offline/**`, `src/lib/voice/**`, `src/lib/i18n.ts`,
  `src/middleware.ts`, `src/lib/validation.ts`, `src/lib/roles.ts`,
  `src/lib/rateLimit.ts`, `src/lib/supabaseServer.ts`, `src/app/page.tsx`,
  `src/app/layout.tsx`, `package.json`, `package-lock.json`,
  `next.config.mjs`, `tailwind.config.js`, `src/app/globals.css`,
  `test/setup.ts`, `vitest.config.ts`, `README.md`, `ROADMAP.md`,
  `docs/IDEATION.md`, `AGENTWORK.md`, or the two committed migrations.
- **`src/components/cultural/**` is READ-ONLY.** I import `MesobIcon` and
  `MesobBasket`; I never edit them. If I need a variant, I copy it into
  `src/components/draw/`.

## Baseline verified before I touched anything

```
npm run typecheck   clean
npm test            75 passed / 12 files
npm run lint        clean (1 pre-existing App Router font warning)
```

I treat any regression against those 75 tests as a blocker (§9).

The full progress log is in the Definition of Done section above.
