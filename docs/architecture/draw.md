# M4 — Verifiably Fair Draw Engine (እጣ)

**Owner:** AGENT-3 · **Branch:** `feat/agent-3-draw` · **Roadmap:** `ROADMAP.md` §4

Greenfield at `main`: the only thing that existed was decorative artwork and
two components with **zero importers**.

---

## 1. The claim this milestone has to earn

> *No member has to trust the treasurer.*

Everything below exists to make that sentence checkable. If verifying a draw
requires trusting the server, the milestone has failed regardless of how good
the tests are.

## 2. Commit-reveal over SHA-256

Three steps, in this order, with nothing skipped.

### Step 1 — Commit (before the ceremony)

The treasurer generates a seed and a public nonce on-device, fixes the eligible
roster, assigns each member a ticket, and publishes:

```
commitment = SHA-256( canonical_commit( groupId, cycleId, round, drawId,
                                        rosterDigest, commitmentNonce, seed ) )
```

> **Current code (2026-10-03):** the commitment is now serialized as
> `sened-draw-commit-v2` (`src/lib/draw/canonical.ts`) and additionally binds a
> digest of every member's sealed nonce, so the preimage above is the
> pre-M4.3 shape. See §5.

The seed is **never** in the response. `createCommitment`
(`src/lib/draw/engine.ts`) returns the commitment and nothing else.

Both `rosterDigest` and `commitmentNonce` sit *inside* the hashed preimage, so a
treasurer cannot afterwards add a member, drop a member, change anyone's share,
or re-derive the commitment under a fresh nonce without the digest ceasing to
match. That kills the most common favoritism vector — quietly changing who is
eligible — before any seed exists.

### Step 2 — Reveal (at the ceremony)

The seed is published. `openReveal` re-hashes it against the locked-in
commitment. A mismatch **throws `COMMITMENT_MISMATCH` and the draw is refused.**
Not flagged and paid anyway. §12.5.

### Step 3 — Verify (by anyone, anywhere)

`verifyTranscript` takes nothing but published values and a SHA-256
implementation. No server, no account, no session. The hashing is a seam —
`DrawHasher` — so the same pure code runs on `node:crypto` in the server and on
`crypto.subtle` in a phone browser.

### Canonical encoding

Length-prefixed, the same discipline as `src/lib/ledger/canonical.ts`:

```
20:sened-draw-commit-v1
7:groupId
36:22222222-2222-4222-8222-222222222222
...
```

Every name and value carries its own character count, so no two distinct field
sets can serialize to the same string. A treasurer cannot shift a field boundary
and land on the same digest.

### Unbiased selection

Winner = `selectWinnerIndex(transcriptDigest, eligibleCount)`, ordered by ticket.
Selection candidates are candidates; the winner is derived by rejection
sampling — take `SHA-256(transcriptDigest ‖ attempt)` and reject any value at or
above the largest multiple of `n` that fits in 256 bits:

```
bound = 2^256 - (2^256 mod n)
index = value mod n        for the first accepted value
```

A plain `digest mod n` is very slightly biased (the first `2^256 mod n` residues
would be one candidate more likely). Rejection removes that entirely. It costs
one extra hash with probability about `n / 2^256` ≈ 10⁻⁷⁴ for a roster of 200,
so in practice the first hash always wins — but the rule is implemented honestly
rather than waved away. A broken hasher burns at most `MAX_SELECTION_ROUNDS`
(1 000) hashes and then fails closed with `UNIFORMITY_EXHAUSTED`.

## 3. Tickets

```
ticket = SHA-256( "sened-draw-ticket-v1", groupId, cycleId, memberId )
```

A function of the member's **identity alone** — never the seed, never the round,
never their position in a treasurer-controlled list. Ordering by ticket is
therefore something no one can influence. `verifyTranscript` re-derives every
ticket and reports `roster_mismatch` if one was swapped.

The roster digest covers `memberId`, `ticket`, and `contributionAmount`, and
deliberately **not** `displayName` — a renamed member must not break every
published commitment.

## 4. What is detected, and by whom

| Tamper | Detected by | Code |
|---|---|---|
| Seed altered or swapped after commit | `openReveal` re-hash, and `verifyTranscript` | `COMMITMENT_MISMATCH` / `commitment_mismatch` |
| Commitment altered after commit | `verifyTranscript` | `commitment_mismatch` |
| Member added to or removed from the roster | roster digest re-computation | `roster_mismatch` |
| Two members' tickets swapped | per-ticket re-derivation | `roster_mismatch` |
| Server reports a winner ≠ the arithmetic | `verifyRound` cross-check | `selection_mismatch` |
| Reveal before any seed exists | explicit guard | `incomplete_transcript` |
| Abandoned commitments for a round | commitment count | `suspicious_commitment_history` |

**Fail-closed, in the strongest sense available.** When the roster or the
commitment does not hold, `verifyTranscript` returns *no winner at all* even
though the arithmetic would happily produce one. Handing a member a winner
alongside `commitment_mismatch` is exactly how a forged draw gets paid, so it
does not happen. The server's recorded winner is treated as a claim to be
checked, never as the answer: if it disagrees, the arithmetic wins and the
stored round is reported as unverified.

## 5. ⚠️ Residual risk: seed grinding — stated, not hidden

> **Status (2026-10-03): option (1) below, member-seed commitments, has been
> implemented** (commit 84072cb, `20260927120000_draw_member_commitments.sql`,
> `20260927130000_draw_member_rpcs.sql`). Each member seals a nonce before the
> treasurer commits, and the winner derives from a value the treasurer cannot
> search over. The rest of this section describes the single-commitment scheme
> it replaced; the abandoned-commitment warning is still in place.

**A single-commitment scheme does not prevent a treasurer from searching seeds
for a preferred winner.** They can generate many seeds offline, publish one
commitment, reveal the one that lands on their relative, and never reveal the
rest. The commitment is honest about the seed it holds; it cannot prove the
treasurer did not shop for it.

What the design *does* prevent: publishing the roster after the fact, changing
eligibility, walking back a revealed draw, and lying about the outcome. What it
does **not** prevent: choosing a seed.

I am not going to paper over this, because §12.3 forbids fabricated trust
signals and a claim of grinding-proofness would be exactly that.

**The mitigation implemented.** `draw_commitments` deliberately accepts more than
one row per `(cycle, round)`. `count_draw_commitments_v1` returns
`count(*) - 1` for the round, and `verifyRound` turns any value above zero into
`suspicious_commitment_history` plus a warning naming the member vote that
should follow. Abandoned commitments are the observable signature of grinding,
so a treasurer who ground seeds is *detectable by the members they wronged*. The
warning is kept separate from `verified` on purpose: verification is a
mathematical fact, while whether to honour a draw is a governance decision.

**What would actually close it** (as written before M4.3):

1. **Dual commit** — every member (or a quorum) commits their own nonce; the
   winner is derived from the concatenation. Grinding requires *every*
   participant to collude, so it is self-policing. This is the standard fix and
   it is a protocol change, not a patch.
2. **Public commitment log with mandatory reveal** — all commitments for a round
   must be revealed within a fixed window, and a round with un-revealed
   commitments is void. Deterrent rather than preventive.
3. **On-chain randomness** — a `vrf`-style or beacon-based source. Removes the
   treasurer from the loop entirely, but adds infrastructure this hackathon
   cannot rely on.

Recommendation for the reviewer: treat (1) as the M4.3 milestone. (Done, see the status note above.)

## 6. M4.2 — Rotation

A member who has already been drawn in a cycle is excluded from the remaining
draws, at three independent layers:

1. `excludePriorWinners` removes them from the committed roster.
2. `assertNotPriorWinner` runs again in `DrawService.reveal` — defence in depth
   against a tampered commitment that slipped a winner back in.
3. `reveal_draw_v1` re-checks in SQL, so a compromised application cannot write
   a repeat winner.

A full five-round cycle is covered by `test/draw.service.test.ts`: five payouts,
five distinct winners, sequences `1..5`, and
`verifyLedgerChain(entries) === { valid: true, entriesChecked: 5 }`.

## 7. M4.2 — Default risk and reserve retention

The classic ROSCA collapse is not a rigged draw. It is a member who takes the
pot and then stops, leaving the remaining rounds unfunded. A fair draw that pays
**100% of the pot every round actively makes this worse** — after the first
payout the only money left is whatever members still choose to send.

So the engine never pays the whole pot:

```
roundsRemaining      = totalRounds - round + 1
singleMemberExposure = share × (roundsRemaining - 1)   // what one member can walk away with
aggregateExposure    = singleMemberExposure × eligibleCount
baseReserve          = pot × reserveRatioBps / 10000
desiredReserve       = max(baseReserve, singleMemberExposure)
cappedReserve        = min(desiredReserve, pot × 3333bps)
payout               = pot - cappedReserve
```

- `desiredReserve` covers **one member's default**, because that is the exposure
  this particular payout creates. A member drawn in the final round has no
  exposure at all — which is the real reason rotation is a risk tool and not
  only a fairness one.
- The 3 333 bps (33.33%) ceiling stops the reserve from quietly becoming the
  product. If exposure genuinely exceeds it, the engine says so in the notes and
  marks the cycle under-funded rather than paying out almost nothing.
- All arithmetic is `bigint` ETB minor units via the ledger's own money helpers.
  No floating point anywhere.

**This is a deterministic heuristic informed by the ROSCA default literature
(Abebe et al., AAAI 2022, and the wider rotating-savings-group literature). It
is not a proof of equilibrium and is not presented as one.** Every figure is
reproducible by hand from the published round values, and the UI shows the
reasoning next to the number rather than asking the treasurer to trust it.

## 8. Payout: through the ledger, never around it

`DrawService.postPayout` posts a balanced two-line `disbursement` via
`LedgerService.append`. **No direct write to `ledger_entries` or
`ledger_entry_postings` anywhere in this lane** — that is what preserves the hash
chain and Σ debits = Σ credits.

```
entryType: "disbursement"
postings:  [ { payoutExpense, debit,  amount },
             { potCash,        credit, amount } ]
idempotencyKey: "draw-payout." + commitment
```

The idempotency key is derived from the **commitment**, not a timestamp or
counter, so a treasurer who double-taps "pay" — or retries after a dropped
connection — replays onto the same entry instead of paying twice. A *different*
amount under the same key is rejected with `IDEMPOTENCY_CONFLICT` rather than
silently double-paid, matching `LedgerService.append` semantics exactly.

Three gates stand in front of the money, all fail-closed:

1. the draw must be revealed,
2. independent verification must reproduce the same winner,
3. the winner must not already have been drawn this cycle.

A missing ledger account surfaces as `NOT_FOUND` with nothing posted. There is
no path that produces a payout which could not balance.

**Provenance caveat (request R-2).** The ledger API *rejects* `rationale` on any
non-`correction` entry, so the one natural place to record "this member won draw
X" is closed. The linkage is preserved two ways instead: `draw_payouts`
records `ledger_entry_id` against the draw, and the draw id is visible on the
ledger entry inside its `idempotencyKey`.

## 9. Database

`supabase/migrations/20260926100000_draw_commit_reveal.sql`, at the exact
filename reserved for this lane. Idempotent, `snake_case`, RLS on all four
tables, `revoke all … from anon, authenticated`, and the repo's
`drop policy if exists` / `create policy` pattern reusing A1's
`sened_ledger_can_access_group` and `sened_ledger_can_manage_group`.

Tables: `draw_cycles`, `draw_commitments`, `draw_reveals`, `draw_payouts`.
Append-only is enforced by `sened_draw_block_mutation` on every table. Rotation
and the reserve split are re-checked in the database, not trusted from the app.

### The migration was actually run

I applied `20260924214531_ledger_core.sql` + this file to a real
`postgres:16-alpine`, applied mine **twice** to prove idempotency, then
exercised the RPCs end to end. All of the following were observed:

| Check | Result |
|---|---|
| Fresh commit | `replayed = false` |
| Same key, same payload | `replayed = true` |
| Same key, different commitment | `draw_idempotency_conflict` |
| Payout + reserve ≠ committed pot | `draw_payout_split_mismatch` |
| Selection index beyond roster | `draw_selection_out_of_range` |
| Valid reveal | `state = revealed` |
| Re-reveal | `draw_already_revealed` |
| Real `post_ledger_entry_v1` then link | `state = paid` |
| Second payout | `draw_idempotency_conflict` |
| Same winner in a later round | `draw_repeat_winner` |
| `UPDATE draw_reveals` | `draw_history_immutable` |
| `DELETE draw_commitments` | `draw_history_immutable` |
| Abandoned commitment on a round | `superseded = 1` |
| Non-member `authenticated` user | 0 rows visible |

This caught two real bugs I would otherwise have shipped: an inverted `state`
derivation in the response function, and `(select reveal.* …)` expanding to
multiple columns where one composite was required.

**It also found a blocking bug in AGENT-1's committed migration** —
`bank_verification_reconciliation.sql:285` uses `schema.table%rowtype`, which
PostgreSQL rejects. Filed as request **R-6**; I did not edit that file. It has
since been fixed (commit 9016e48): the parameter now uses the composite type.

## 10. The ceremony

`src/app/draw/page.tsx` runs the real engine in the browser. Frame classes are
copied verbatim from `src/app/page.tsx:60-62` so the route is visually
indistinguishable from the M1 shell it will sit beside.

**Adopted the dead assets, as instructed** — `MesobIcon` and `MesobBasket`, both
at zero importers on `main`. Nothing under `src/components/cultural/**` was
modified.

> ⚠️ Both declare `<linearGradient id="mesobStraw">` — different gradients, same
> document-global id. Mounting both at once makes one render with the other's
> colours. They are rendered in mutually exclusive branches. If that ever
> changes, copy the SVGs into `src/components/draw/` and namespace the ids
> rather than reaching into the shared folder.

Keyframes live in `src/components/draw/draw.css` — my file, per §4.2. Nothing
touches `globals.css` or `tailwind.config.js`.

**Reduced motion** is handled twice over: `globals.css:31-40` already collapses
CSS animations, and `usePrefersReducedMotion` additionally branches so the
reduced-motion experience is a *static but complete* draw rather than a frozen
animation. A member still learns who won.

### The tamper switch

The ceremony has a labelled checkbox that flips one character of the seed. This
is not a fake success path — it is the demonstration. Nothing in the pipeline
can tell the seed was flipped; the commitment check is what catches it, and the
UI shows the refusal with the reason in plain language. The label says it is
for demonstration.

### Honest copy

`src/components/draw/copy.ts` is now a thin adapter: the strings live in the
`draw.*` keys of `src/lib/i18n.ts` (request **R-3**, resolved) and `copy.ts`
maps them onto the `DrawCopy` field names the components use. Both `am` and
`en` are present (§12.6).

The page states plainly that it runs on-device and does not depend on the server
— because that is true, and because a demo that quietly implied server
verification would be a fabricated trust signal.

## 11. API

| Route | Role | Notes |
|---|---|---|
| `POST /api/draw/commits` | treasurer | publishes commitment + roster |
| `POST /api/draw/reveals` | treasurer | publishes the seed, fixes the winner |
| `POST /api/draw/verify` | **any member** | deliberately not role-gated |
| `GET /api/draw/rounds/[roundId]` | any member | published round + transcript |
| `POST /api/draw/payouts` | treasurer | posts through `LedgerService.append` |

`/verify` and the round read are authenticated but **not** role-gated. A member
who cannot open the ledger still has to be able to check the draw; that is the
social contract. Commit/reveal/payout use `canWriteLedger`, matching the ledger
and banking lanes.

Handler factories (`createCommitHandler(serviceFactory)`) follow the banking
lane's Style B, so tests inject a fake service and the production path is
exercised separately to prove it 503s when Supabase is unconfigured.

**Rate limiting:** every `/api/draw/*` path, including `rounds/[roundId]` via a
UUID regex, is in `src/middleware.ts`'s `RATE_LIMITED` with write or read rules
(request **R-1**, resolved).

## 12. Tests

`test/draw.*.test.ts` — **126 tests across 6 files** as of 2026-10-03 (the
table below lists the original four; `draw.fairness.test.ts` and
`draw.rpc-contract.test.ts` were added later). The full suite is 1039 tests in
59 files.

| File | Tests | Covers |
|---|---|---|
| `draw.engine.test.ts` | 34 | canonical encoding, unbiased selection, commit, reveal, independent verification, every tamper class, rotation |
| `draw.service.test.ts` | 19 | commit/replay/conflict, reveal gates, payout → balanced hash-chained ledger entry, full cycle, repeat winner, fail-closed hasher |
| `draw.api.route.test.ts` | 32 | 401/403/503, spoofed-field rejection, numeric money, weak entropy, nonce-equals-seed, duplicate members, error→status map, member-can-verify |
| `draw.ui.test.tsx` | 11 | ceremony, both Mesob assets, honest reserve, rotation across rounds, locale switch, tamper refusal, VerifyPanel tamper reporting |

Security-relevant pattern throughout: **every negative test asserts the side
effect did *not* happen** — `expect(service.commit).not.toHaveBeenCalled()`.

## 13. Non-negotiables

| §12 | How this lane honours it |
|---|---|
| Σ debits = Σ credits | Payouts only via `LedgerService.append`; asserted in tests and in Postgres |
| Append-only | `sened_draw_block_mutation` on all four draw tables; verified by UPDATE/DELETE |
| No fabricated trust signals | Tamper switch is labelled; the demo states it is on-device; a failed verification shows no winner |
| Voice is never a committer | Out of scope for this lane; the draw does not consume voice output |
| Fail closed | Refused reveal names no winner; broken hasher → `INTEGRITY_FAILURE`; unconfigured → 503, never a fake draw |
| Both languages | `draw.*` keys in `src/lib/i18n.ts` have `am` and `en`; `copy.ts` adapts them (R-3, resolved) |
| Honest empty states | "No commitment sealed yet"; unverified states say so; grinding warnings are surfaced, not hidden |

## 14. Deferred

- **Wiring the ceremony UI to the API.** `/draw` runs the engine on-device with a
  fixture roster and does not call `/api/draw/*`.
- **`draw_cycles` seeding API** — the table and policies exist; no RPC creates a
  cycle yet (checked 2026-10-03), so the demo uses fixtures like the rest of Gen A.
- **Supabase round-trip tests** — the repository is written and the SQL is
  verified against real Postgres, but the suite has no live-Supabase test. The
  existing lanes use the same mocked-`rpc` approach.
- ~~Rate-limit buckets~~ — done (R-1).
