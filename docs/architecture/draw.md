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

> **Current code (2026-10-04):** the commitment is now serialized as
> `sened-draw-commit-v3` (`src/lib/draw/canonical.ts`) and additionally binds a
> digest of every member's sealed hash (`memberDigest`), so the preimage above is
> the pre-M4.3 shape. The version tag is part of the preimage, so a v3 draw can
> never be re-presented as v2. See §5.

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

## 5. Seed grinding: closed in protocol v3, with residual properties stated

### 5.1 What was wrong (protocol v2)

M4.3 added member-seed commitments: each member seals a nonce
(`sealed = H(drawId, memberId, nonce)`) *before* the treasurer commits, and the
nonce is revealed with the seed. That was meant to stop the treasurer choosing
the winner. It did not, because the winner never depended on the nonces:

```
memberDigest     = H( drawId, sorted (memberId, SEALED HASH) pairs )     // known at commit time
transcriptDigest = H( drawId, commitment, rosterDigest, memberDigest, seed )
winner           = selectWinnerIndex( transcriptDigest )
```

Every input on the right-hand side is known to the treasurer *before* they
commit: they choose `seed` and `commitmentNonce`, the roster is theirs, and the
sealed hashes are public. They could therefore grind `seed` / `commitmentNonce`
offline (about `n` tries for an `n`-member roster) until the winner was the
member they wanted, then commit. The reveal would be perfectly consistent and
every member's check would pass. The member nonces, the only values the
treasurer does not have at commit time, never influenced the outcome.
`draw.fairness.test.ts` only exercised grinding *after* the commit, which v2
already prevented.

### 5.2 The fix (protocol v3)

```
nonceDigest      = H( drawId, sorted (memberId, nonce) pairs )            // sened-draw-nonce-set-v1
                   -- only from nonces that verified against their seals
transcriptDigest = H( drawId, commitment, rosterDigest, memberDigest,
                      nonceDigest, seed )                                 // sened-draw-transcript-v3
winner           = selectWinnerIndex( transcriptDigest )                  // unchanged
```

and `commitment` is serialized as `sened-draw-commit-v3` (same fields as v2, new
tag). The winner is now a function of values that did not exist, from the
treasurer's point of view, when they chose the seed.

Guarantee: if **at least one** member whose nonce is sealed keeps it secret until
the treasurer's commitment is published, nobody (treasurer included) can predict
or steer the winner at commit time. A coalition must contain *every* sealed
member to grind.

Where it lives: `canonicalSerializeNonceSet`, `computeNonceDigest`,
`canonicalSerializeTranscript(…, version)` in `src/lib/draw/canonical.ts`;
`resolveMemberOpening`, `findBadOpenings`, `openReveal` and `verifyTranscript` in
`src/lib/draw/engine.ts`. The browser (`verifyInBrowser`) runs the same
`verifyTranscript` with WebCrypto; the verifier is the single place that both
checks every opening and derives the winner, so there is no separate "opening
check" that could pass while the selection used something else.

Strictness added with it: the opened set must equal the sealed set *exactly*. A
revealer who repeats one member's nonce so the count still matches (hiding that
another was never opened) is refused, in the engine, in the verifier, and in
`reveal_draw_v1`. An unverified nonce never contributes to a digest, and a v3
transcript with missing or bad nonces yields no `transcriptDigest` and no winner.

### 5.3 Versioning and what happens to v2 draws

| | v2 (historical) | v3 (current) |
|---|---|---|
| commit tag | `sened-draw-commit-v2` | `sened-draw-commit-v3` |
| transcript tag | `sened-draw-reveal-v2` | `sened-draw-transcript-v3` |
| winner depends on nonces | no | yes (via `nonceDigest`) |
| can be created | **no** (read-only history) | yes |

Decision: **v2 draws stay verifiable under their original rules.** The v2 tags
and preimages are frozen; `verifyTranscript` dispatches on
`transcript.protocolVersion` (absent means v2, i.e. a row from before
versioning), and the v2 vectors in `test/draw.nonce-binding.test.ts` were
captured by running the pre-change engine, so any drift fails the build. v2 draws
keep their original weakness (they were grindable); they are not re-labelled as
safe, and nothing in the product claims otherwise.

Downgrade resistance: the version is hashed into the *commitment*, so a v3
transcript presented as v2 (or with the field stripped) fails with
`commitment_mismatch` and names no winner; a v2 transcript presented as v3
fails the same way. In the database, `draw_commitments.protocol_version` is set at
commit time (existing rows backfilled `v2`), the table is append-only, and
`commit_draw_v1` **refuses anything but `v3`**, because the function is reachable
directly through PostgREST and a treasurer must not be able to open a new draw
under the grindable rules by calling it by hand.
(`20261004100000_draw_protocol_v3.sql`; apply it before deploying the
application that sends `p_protocol_version`.)

### 5.4 Protocol ordering (what the UI enforces)

The guarantee holds only if a member releases their nonce **after** the
commitment is published. `LiveDraw` therefore does not render a member's opening
line until the draw's published commitment (`/api/draw/verify`) contains that
member's own sealed hash; before that it shows why, offers a "has the treasurer
committed?" check, and warns if a commitment exists but omits the member's seal.
The opening is also withheld from the DOM, not merely hidden. This is a
usability guard, not a cryptographic one: a member who pastes the nonce out of
`localStorage` early defeats it for themselves, and the docs say so.

### 5.5 Residual properties (honest list)

1. **Collusion.** The guarantee needs one honest sealed member whose nonce stays
   secret until after the commit. A treasurer colluding with *every* sealed
   member can grind. One seal is the enforced floor (`MIN_MEMBER_COMMITMENTS`);
   a group that wants more should raise `minMemberCommitments`. Note the treasurer
   also chooses *which* members' seals to include; that is a grinding dimension
   only over subsets of members whose nonces the treasurer still does not know,
   so it adds no information.
2. **Last-revealer abort (withholding).** After the commit, whoever sees the
   other nonces and the seed can compute the outcome before deciding to
   proceed. In this product the treasurer collects the openings and holds the
   seed, so the treasurer can compute the winner from the nonces they receive and
   *abort* (never reveal, re-commit with a new seed) if they dislike it. A member
   who refuses to reveal likewise makes the draw refuse
   (`MEMBER_COMMITMENT_MISSING`). Withholding is a veto, not a choice: it cannot
   select a winner, it can only discard an outcome. A veto repeated until the
   result is favourable is the same grinding in slow motion, and it leaves exactly
   the observable trace the abandoned-commitment counter exists for: every
   re-commit adds a row to `(cycle, round)`, `count_draw_commitments_v1` returns
   it, and `verifyRound` turns any positive count into
   `suspicious_commitment_history` plus a member-vote warning. That counter is
   deliberately kept; `verified` stays a mathematical fact, honouring the draw is
   governance. A lone member can only abort, never bias, but each abort costs the
   treasurer a visible re-commit, not the member.
3. **Nonce leakage before the commit** (a member screenshotting or sharing it
   early, or the server logging it) re-opens the v2 hole for that member's share
   of the entropy. The UI withholds it; nothing can make a human keep a secret.
4. **The server still sees nonces at reveal.** It cannot change the winner
   (every member recomputes it), but it is trusted to *publish* them.
5. **The database does not recompute the derivation.** `reveal_draw_v1` checks
   structure (opened set equals the sealed set for v3, nonce length, digest
   equality) and the existing trigger pins the winner to the committed roster and
   index, but neither the nonce-to-seal hash nor the seed-to-winner derivation is
   reimplemented in plpgsql (see `20260926110000_draw_reveal_binding.sql` for why).
   Those are enforced by `verifyRound` on the server and, independently, by every
   member's browser.

### 5.6 Earlier options (kept for the record)

Before M4.3 the options considered were dual commit (what v3 completes), a
public commitment log with mandatory reveal (partly present as the
abandoned-commitment counter), and an external randomness beacon (not adopted).

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
verification would be a fabricated trust signal. That demo is now the signed-out
mode only, behind a demo banner; see §14 for the signed-in flow.

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

`test/draw.*.test.ts` — **182 tests across 8 files** as of 2026-10-04 (the
table below lists the main ones; `draw.fairness.test.ts`,
`draw.rpc-contract.test.ts`, `draw.live.test.tsx` and
`draw.nonce-binding.test.ts` were added later). The full suite is 1124 tests in
64 files.

| File | Tests | Covers |
|---|---|---|
| `draw.engine.test.ts` | 34 | canonical encoding, unbiased selection, commit, reveal, independent verification, every tamper class, rotation |
| `draw.service.test.ts` | 19 | commit/replay/conflict, reveal gates, payout → balanced hash-chained ledger entry, full cycle, repeat winner, fail-closed hasher |
| `draw.api.route.test.ts` | 32 | 401/403/503, spoofed-field rejection, numeric money, weak entropy, nonce-equals-seed, duplicate members, error→status map, member-can-verify |
| `draw.nonce-binding.test.ts` | 31 | v3: grinding control (v2 is grindable, 300/300) and v3 at chance, fixed-preimage nonce sensitivity, golden vectors (v3 hand-recomputed; v2 captured from the pre-change engine), v2 history, downgrade/upgrade refusal, tampered/dropped/repeated nonces, browser == server, tampered nonce digest |
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

## 14. The signed-in ceremony (UI wired to the API)

`/draw` now has two modes, chosen by `useSession`:

- **Signed out, or no Supabase configured** — the on-device demo (`DrawBoard`),
  with a fixture roster. It carries a `data-testid="draw-demo-banner"` label in
  both languages and never calls `/api/draw/*`.
- **Signed in** — `LiveDraw` (`src/components/draw/LiveDraw.tsx`), backed by
  `src/lib/draw/clientDraw.ts`. The group is resolved with `readMyGroup` (it
  refuses on no group or several groups) and the roster comes from
  `GET /api/ledger/members`.

Sequence, and who may do each step:

| # | Step | Call | Who |
|---|---|---|---|
| 0 | Seal a nonce for a draw id | none (on-device; only the hash is shared) | any member |
| 1 | Commit | `POST /api/draw/commits` | owner / treasurer |
| 2 | Reveal | `POST /api/draw/reveals`, then `POST /api/draw/verify` | owner / treasurer |
| 3 | Verify | `POST /api/draw/verify` | any member |
| 4 | Payout | `POST /api/draw/payouts` (after an explicit confirmation) | owner / treasurer |

Notes on how it behaves:

- **Verification is recomputed in the browser** (`verifyInBrowser`) from the
  published transcript with `webDrawHasher`: roster digest, tickets, member
  digest, commitment, transcript digest, winner (`verifyTranscript`), plus that
  every member nonce opens its sealed hash, and the payout/reserve split
  (`planReserve`). The result is *compared* with the server's verdict, winner,
  transcript digest and amounts; any difference is shown as a disagreement and
  the payout is withheld. `/api/draw/verify` now also returns `memberNonces` so
  the openings can be checked on the device.
- **Payout** is offered only to owner/treasurer, only when this device verified
  the draw and agrees with the server. It shows the winner, the amount, the
  reserve and the `PAYOUT_EXPENSE` (debit) and `POT_CASH` (credit) account ids
  from `/api/my-groups`, and the button stays disabled until a confirmation box
  is ticked.
- **Member seals travel out-of-band.** There is no endpoint for a member to
  submit a seal to the server; a seal exists only inside the treasurer's commit
  request. So a member seals on their device (the draw id is bound into the
  seal, so the treasurer creates the id first and shares it), and sends the
  treasurer the `memberId:hash` line, later the `memberId:nonce` opening. The UI
  requires at least one seal from a member other than the committer. A member's
  opening line is not shown until the published commitment contains their seal
  (§5.4).
- The treasurer's seed lives in `localStorage` on the treasurer's device until
  the reveal (the server never returns one it generated), and is wiped after.
- The commit endpoint takes the seed in clear because the server computes the
  commitment; the seed is not stored until the reveal, but the server does see it.
- Error codes from the routes are mapped to bilingual messages
  (`drawErrorKey`); the server's own `message` is shown beneath.
- The request body cap is 8 KiB (`MAX_BODY_BYTES`), which bounds a commit to a
  roster of roughly 50 members.

Tests: `test/draw.live.test.tsx` runs the real route handlers and `DrawService`
(in-memory repositories) behind a fake `fetch`, so the browser verifies what a
real server would publish.

## 15. Deferred

- **Cycle creation.** `draw_cycles` still has no creating RPC or API. The
  treasurer types an existing cycle id; an unknown one is refused as not found.
  There is also no endpoint listing a group's cycles or draws, so draw ids are
  shared by hand and the live board remembers only the draw this device opened.
- **A member-seal endpoint** (so sealing and openings need not be copy-pasted)
  and a UI to show who has sealed.
- **Contribution amounts and pot** are typed by the treasurer; nothing reads
  them from the ledger yet, so the reserve uses the typed figures.
- ~~Observation: the winner depended on the member digest, not the nonces, so a
  treasurer could grind seeds before committing~~ — fixed in protocol v3 (§5);
  the residual properties that remain are listed in §5.5.
- `VerifyPanel` and `RiskPanel` still carry Amharic-only text.
- **Supabase round-trip tests** — the repository is written and the SQL is
  verified against real Postgres, but the suite has no live-Supabase test. The
  existing lanes use the same mocked-`rpc` approach.
- ~~Wiring the ceremony UI to the API~~ — done for signed-in users (§14).
- ~~Rate-limit buckets~~ — done (R-1).
