# AGENT-3 — Request Log

> One file per agent (§4 of `AGENTWORK.md`). A1 reads these during integration.
> Format: one row per request — target owner, file/module, exactly what is
> needed, and whether my lane is blocked without it. Do not bundle unrelated asks.
>
> **Status vocabulary:** `OPEN` · `ANSWERED` · `DECLINED (reason)` ·
> `RESOLVED (how)`.

## Summary

| # | Target | Module | Need | Blocks my lane? | Status |
|---|---|---|---|---|---|
| **R-6** | **A1** | `supabase/migrations/20260925120000_bank_verification_reconciliation.sql:285` | **The bank migration does not apply. `schema.table%rowtype` is a PostgreSQL syntax error.** | **Yes for integration** — it stops the whole migration chain, so mine cannot be applied in sequence | **RESOLVED (the parameter now uses the composite type `public.bank_verification_intents`, commit 9016e48; the remaining `%rowtype` uses are in `declare` blocks, which are valid; all migrations apply via `scripts/verify-migrations.*`) — see below** |
| R-1 | **A1** | `src/middleware.ts` | Register the draw API paths in `RATE_LIMITED` so they get a `WRITE_RULE`/`READ_RULE` bucket | No — my routes work unmetered; this is a hardening gap | RESOLVED (all `/api/draw/*` paths, including the `rounds/[roundId]` UUID regex, are in `src/middleware.ts` `RATE_LIMITED` with write/read rules, commit 2257934) |
| R-2 | **A1** | `src/lib/ledger/types.ts` + `ledger_core.sql` | Allow provenance text on a `disbursement` entry (see note) | No — I keep provenance in my own table | OPEN (unchanged: `src/lib/ledger/rules.ts` still rejects `rationale` on a non-correction entry; option (b) ships, `draw_payouts.ledger_entry_id` plus the draw id in the idempotency key) |
| R-3 | **A2** | `src/lib/i18n.ts` | Fold in the `draw.*` key triples I filed below | No — I reuse `m2.*` keys + hard-coded Ge'ez per Gen A precedent | RESOLVED (the `draw.*` keys are in `src/lib/i18n.ts` and `src/components/draw/copy.ts` now reads them, commit 2257934) |
| R-4 | **A1** | `src/app/page.tsx` | Link `DebterCard`'s "ቀጣይ እጣ" affordance to `/draw` during integration | No — `/draw` is self-contained and routable | RESOLVED (`src/app/page.tsx` sends `DebterCard`'s `onDrawClick` to `router.push("/draw")`, commit 2257934) |
| R-5 | **A1** | ledger accounting seeding | Confirm the two account codes I post against exist in every group's `ledger_accounts` | No — I fail closed with an honest 404/422 if they don't | RESOLVED (`src/lib/ledger/accounts.ts` defines the canonical `POT_CASH` and `PAYOUT_EXPENSE` codes and `create_ledger_group` seeds them for every new group, commits dad1cf0 and the `20260927100000_ledger_group_provisioning.sql` migration; the payout route takes account ids, not the `DRAW_*` codes proposed here) |

---

## R-6 — ⚠️ The bank migration does not apply (integration blocker)

- **Target owner:** AGENT-1
- **File:** `supabase/migrations/20260925120000_bank_verification_reconciliation.sql:285`
- **Severity:** high — this is the committed M2.2 migration and it is
  un-runnable, so `supabase db push` fails for anyone setting up the project.

**What I found.** I applied your migration chain to a stock Postgres 16 to
validate my own M4 file. `20260924214531_ledger_core.sql` applied cleanly. Yours
stopped immediately:

```
psql:20260925120000_bank_verification_reconciliation.sql:285: ERROR:  syntax error at or near "rowtype"
LINE 2:   intent_row public.bank_verification_intents%rowtype,
                                                                       ^
```

**Why.** `table%rowtype` is valid, but `schema.table%rowtype` is not — PostgreSQL
only accepts the `%rowtype` form on an unqualified relation name. I confirmed
this in isolation on 16.6 with a scratch table:

```sql
create or replace function public.f(x public.t_probe%rowtype) returns int
language sql as $$ select x.a $$;
-- ERROR:  syntax error at or near "rowtype"
```

**The fix** is to name the composite type, not qualify the table:

```sql
-- broken
  intent_row public.bank_verification_intents%rowtype,

-- either of these works
  intent_row public.bank_verification_intents,
  intent_row public.bank_verification_intents%rowtype   -- still broken
```

`declare intent_row public.bank_verification_intents;` gives you a row variable
of that table's composite type, which is what the code wants. Worth checking
every other `%rowtype` in the file — I only found line 285 while applying it
before the parse aborted, so there may be more further down.

- **Blocks my lane?** It does not block my TypeScript, and my migration file
  itself is fine. It does block **integration**: the migrations run in filename
  order, so nothing after yours can be applied either, including mine. I have
  therefore left it alone (§0) and filed it here.
- **How I verified my own file, for your reference:** I ran
  `20260924214531_ledger_core.sql` + `20260926100000_draw_commit_reveal.sql` on
  `postgres:16-alpine`, applied my file twice to prove idempotency, then
  exercised commit → reveal → payout end to end. The immutable-history
  triggers, the rotation check, the payout-split check, the idempotency
  conflicts, RLS tenant isolation, and the abandoned-commitment (seed-grinding)
  counter all behave as intended. If you want the harness, say the word and I
  will commit it under `supabase/` as a validation script.

---


## R-1 — Rate-limit buckets for `/api/draw/*`

- **Target owner:** AGENT-1
- **File:** `src/middleware.ts`
- **Why:** The middleware matcher is `"/api/:path*"`, so my routes *do* pass
  through it — but `RATE_LIMITED` (`middleware.ts:4-8`) contains only the three
  ledger/banking paths. `isRateLimitedPath("/api/draw/…")` therefore returns
  `false` and the middleware returns `NextResponse.next()` at line 52 before
  `resolveRateLimit` is ever consulted. My write routes are unmetered.
- **Exactly what is needed:** add my paths to `RATE_LIMITED` and give
  `resolveRateLimit` the same treatment the banking paths got — registering both
  the literal dynamic segment **and** a UUID regex, because
  `request.nextUrl.pathname` is the concrete path, never the bracket form.

  ```ts
  export const RATE_LIMITED = new Set([
    "/api/ledger/entries",
    "/api/bank-verifications",
    "/api/bank-verifications/[verificationId]",
    "/api/draw/commits",
    "/api/draw/reveals",
    "/api/draw/verify"
  ]);

  const DRAW_ROUND_PATH =
    /^\/api\/draw\/rounds\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  ```

  and in `resolveRateLimit`, `"/api/draw/commits"` and `"/api/draw/reveals"` →
  `WRITE_RULE`; `"/api/draw/verify"` and `DRAW_ROUND_PATH` → `READ_RULE`.
- **Blocks my lane?** No. I do not read `X-RateLimit-*` headers and I do not
  depend on a 429. Documented as a known exposure in `docs/architecture/draw.md`.
  A4 has filed an equivalent request for `/sync`; grouping both would be
  cheaper than two edits.

## R-2 — Provenance text on a `disbursement` ledger entry

- **Target owner:** AGENT-1
- **Files:** `src/lib/ledger/rules.ts:166-168`, `src/lib/ledger/types.ts`,
  `ledger_core.sql` `post_ledger_entry_v1`
- **Why:** The ledger API **rejects** `rationale` on any non-`correction` entry
  with `INVALID_CORRECTION`. A draw payout is a `disbursement`, so the one
  natural place to record *why* this member won (the draw id, the revealed seed,
  the winning ticket) is blocked. I currently lose the linkage between the
  ledger entry and the draw record at the moment of posting.
- **Exactly what is needed:** either (a) relax the rule so a `disbursement` may
  carry an optional provenance/memo string distinct from the correction
  rationale, or (b) confirm that A1 prefers I key `draw_payouts.entry_id →
  ledger_entry_id` in my own migration and leave the ledger API alone.
- **Blocks my lane?** No. I implemented (b): `20260926100000_draw_commit_reveal.sql`
  has a `draw_payouts` table that records the returned `ledger_entry_id` against
  the draw. My service also writes the draw id into the `idempotencyKey`
  (`draw-payout-<commitHash>`), which *is* visible on the entry and already makes
  the linkage auditable from the ledger side. (b) is sufficient today; (a) would
  be nicer. **This is a question, not a blocker.**
- **Note:** I will not edit `rules.ts` or the SQL function myself — that is
  precisely the kind of shared-file change §0 exists to prevent.

## R-3 — `draw.*` i18n key triples

- **Target owner:** AGENT-2 (sole owner of `src/lib/i18n.ts`, §4.1)
- **Why:** Per `AGENTWORK.md` §4.1 I may not add keys. `MessageKey` is derived
  from `en` and `am` is typed `Record<MessageKey, string>`, so a half-added key
  is a compile error in *your* file.
- **My interim choice:** I reuse the existing `m2.*` keys where they fit
  (`m2.currency.etb`, `m2.integrity.*`, `m2.status.*`, `m2.error.*`,
  `m2.entryType.disbursement`) and hard-code Ge'ez literals for the ceremonial
  chrome, which is the established Gen A convention (`DebterCard.tsx:53,76,84`
  hard-code `ደብተር`, `ቀጣይ እጣ መሶብ`, `ቀጣይ እጣ` and never call `t()`).
- **Please fold in the `draw.*` prefix when convenient** (Amharic first — this
  is a Ge'ez-primary product):

  | key | en | am |
  |---|---|---|
  | `draw.title` | `Fair draw (እጣ)` | `ፍትሃዊ እጣ` |
  | `draw.commitTitle` | `Step 1 of 3 — Commit` | `ደረጃ 1 ከ 3 — ቃል መዋጮ` |
  | `draw.revealTitle` | `Step 2 of 3 — Reveal` | `ደረጃ 2 ከ 3 — መስበር` |
  | `draw.verifyTitle` | `Step 3 of 3 — Verify` | `ደረጃ 3 ከ 3 — ማረጋገጥ` |
  | `draw.commitment` | `Commitment` | `ቃል መዋጮ` |
  | `draw.seed` | `Seed` | `ዘመን` |
  | `draw.winner` | `Winner` | `አሸናፊ` |
  | `draw.ticket` | `Ticket` | `ትሪት` |
  | `draw.verified` | `Verified by every member` | `በእያንዳንዱ አባላት የተረጋገጠ` |
  | `draw.tamperDetected` | `Tampering detected` | `ማስተካከል ተለይቷል` |
  | `draw.pot` | `Pot` | `በር` |
  | `draw.reserveRetained` | `Reserve retained` | `የተጠበቀ ማስጠንቀቂያ` |
  | `draw.round` | `Round` | `ዙር` |
  | `draw.alreadyWon` | `Already won this cycle` | `በዚህ ዙር አሸናፊ ሆነዋል` |

## R-4 — Link the "ቀጣይ እጣ" affordance to `/draw`

- **Target owner:** AGENT-1 (owner of the mount point, §3)
- **File:** `src/app/page.tsx`
- **Why:** `page.tsx:74` currently wires `DebterCard`'s `onDrawClick` to
  `setIsDigestModalOpen(true)` — the draw affordance opens the audio digest, a
  placeholder. During integration, point it at `/draw`.
- **Blocks my lane?** No. `/draw` is a self-contained route I build and verify
  on its own; I never touch `page.tsx`.

## R-5 — Confirm the two payout account codes

- **Target owner:** AGENT-1
- **File:** ledger account seeding (whichever migration/seed defines
  `ledger_accounts` for a new group)
- **Why:** A payout is a balanced 2-posting `disbursement`. I need a **cash
  asset** account (credited — money leaves the pot) and a **payout expense**
  account (debited — the pot's obligation is discharged). I picked the codes
  `DRAW_POT_CASH` and `DRAW_PAYOUT_EXPENSE` and made them **per-request
  parameters**, not hard-coded, so any group's account ids work.
- **Exactly what is needed:** confirm whether A1 seeds a canonical pair of
  account codes per group, so the default in my route can match them.
- **Blocks my lane?** No. Both account ids are validated in my request schema
  and I **fail closed**: if either account is missing, `LedgerService.append`
  throws `NOT_FOUND` and I surface a 404/422 rather than posting a payout that
  cannot balance. Nothing is faked.

---

## Log

| Date | Entry |
|---|---|
| 2026-09-26 | Created. Filed R-1 … R-5. None block the lane. |
| 2026-10-03 | Statuses re-checked against the code. R-1, R-3, R-4, R-5, R-6 resolved; R-2 stays OPEN (no change to the ledger rules; option (b) ships). |
