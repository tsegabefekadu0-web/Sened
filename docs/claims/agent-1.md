# AGENT-1 claim & progress

> **Historical log.** This file records one agent's work during the multi-agent build phase and is not kept up to date. For current status, see [ROADMAP.md](../../ROADMAP.md).

**Agent:** AGENT-1 · Ledger Trust Core (ROADMAP M2.2 + M2.3)
**Branch:** `feat/agent-1-ledger-trust`
**Working directory:** `C:\Sened` — ⚠️ **shared with A2/A3/A4, see BLOCKER below**

## §3 rows taken

| Path | Status |
|---|---|
| `src/lib/banking/**` | IN PROGRESS |
| `src/lib/ledger/**` | untouched |
| `src/app/api/bank-verifications/**` | untouched |
| `src/app/api/reconciliation/**` | not started |
| `src/components/ledger/**` | untouched |
| `src/components/sened-shell.tsx` | untouched |
| `src/app/page.tsx` | untouched (reserved for integration) |
| `test/banking.*`, `test/ledger.*` | IN PROGRESS |
| `.env.example` | DONE |
| `src/middleware.ts`, `src/lib/{validation,roles,rateLimit,supabaseServer}.ts` | untouched |
| `README.md`, `ROADMAP.md`, `docs/IDEATION.md` | untouched |

New files created: `src/lib/banking/linkset.ts`, `test/banking.linkset.test.ts`

## Progress

| # | Task | Status | Commit |
|---|---|---|---|
| 0 | Baseline commit | ✅ DONE | `d2eac5b` (129 files, 75 tests green) |
| — | .gitignore for coordination scratchpads | ✅ DONE | `ca3a512` (on `backup/agent-1-chore`) |
| 2 | Real links.et HTTP adapter | ✅ DONE | `d60ebf5` |
| 2b | Tests replacing the stub assertion | ✅ DONE | `d60ebf5` — 63 new tests |
| 3 | `BankVerificationLedgerSink` | ⬜ not started | needs a decision, see below |
| 4 | Reconciliation drain entry point | ⬜ not started | |
| 5 | Route M2 dashboard + wire correction form | ⬜ not started | |
| 15 | Integration | ⬜ not started | |

**Verification at `d60ebf5`:** `npm test` 138 passed / 13 files (75 baseline intact),
`npm run lint` clean, `tsc --noEmit` clean across `src/lib/banking` and `test/banking`.

## 🚨 BLOCKER — one working tree cannot host four branches

Git permits **exactly one checked-out branch per working directory**. All four
agents are running in `C:\Sened`, so every `git checkout -b` moves the shared
HEAD and every `git commit` lands on whichever branch happened to be checked out
at that moment.

Observed damage, repaired:

- My `d60ebf5` was committed while HEAD had been moved to `feat/agent-3-draw` by
  another agent, so it landed on **A3's branch** instead of mine.
- Git refused `git branch -f feat/agent-3-draw` with
  `fatal: cannot force update the branch 'feat/agent-3-draw' used by worktree at 'C:/Sened'`,
  which is the clearest possible confirmation of the root cause.
- `feat/agent-3-draw` still points at `d60ebf5` and **cannot be reset from here**
  without checking out a different branch under A3's feet.

Nothing is lost. `feat/agent-1-ledger-trust` → `d60ebf5` and
`backup/agent-1-chore` → `ca3a512` both hold my work.

**Required fix: one `git worktree` per agent.** Each agent then has its own
directory, its own HEAD, and its own `node_modules`, which also removes the
`package-lock.json` install race.

```bash
git worktree add ..\Sened-a1 feat/agent-1-ledger-trust
git worktree add ..\Sened-a2 feat/agent-2-voice
git worktree add ..\Sened-a3 feat/agent-3-draw
git worktree add ..\Sened-a4 feat/agent-4-offline-pwa
```

Then reset the polluted branch once, from any worktree that is not A3's:

```bash
git branch -f feat/agent-3-draw d2eac5b
```

## Requests

None filed yet.

## Notes for integration

1. **Masked accounts are a weak signal, by necessity.** Every provider masks
   account numbers on the public receipt, so a full account number can never be
   compared. Bindings must be registered with the masked form as the bank prints
   it, and a sender/receiver match is corroboration, never proof. Worth an
   explicit ADR before this reaches a demo.
2. **The ROADMAP's 800ms is achievable only as a first-response budget.**
   links.et can hold a request ~120s against a busy bank, so `waitMs` + a
   `202 queued` → `PENDING_RECONCILIATION` handoff is the design. Task #4 is
   what makes that work end to end.
3. **Timestamp tolerance was added with a default of 0**, so every pre-existing
   strict check is byte-identical. Live adapters opt in via
   `BankProviderAdapter.timestampToleranceSeconds`. A2's voice pipeline should
   be aware that a spoken "I paid at 10:30" is a *declared* time compared with a
   tolerance, not an exact instant.
