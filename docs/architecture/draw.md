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

### 5.4 Protocol ordering (what the database enforces)

The guarantee holds only if a member releases their nonce **after** the
commitment is published. Since M4.4 that ordering is enforced by the database, not
by the screen: `submit_draw_nonce_v1` raises `draw_nonce_too_early` (HTTP 409
`nonce_too_early`) unless a commitment row exists for the draw, and then accepts
the nonce only if it hashes to the caller's *own* committed seal (§16). `LiveDraw`
still withholds the release button until the published, frozen sealed set contains
the member's own seal exactly as this device holds it, and shows why it is
withheld, but that is now a usability guard on top of a server rule. The nonce is
generated and kept on the member's device, and is never rendered: a member who
copies it out of `localStorage` early defeats the property for themselves, and
the docs say so.

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
   proceed. Before M4.4 the treasurer collected the openings by hand and could do
   exactly that. Now the treasurer never receives a nonce: the only way to obtain
   them is `open_draw_reveal_v1`, which requires the seed to reproduce the
   commitment and publishes the seed and the nonces to every group member in the
   same step (§16.4), so the treasurer cannot learn the outcome before the group
   can. What remains is the veto: having requested the reveal, the treasurer can
   decline to finish it and open a new draw. That leaves the trace below, plus a
   `revealRequested` draw that never reached `revealed`. A member
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
3. **Nonce leakage before the commit** (a member sharing it early, or the server
   logging it) re-opens the v2 hole for that member's share of the entropy. The
   server holds a member's nonce between their release and the reveal, in a table
   no client role can read (§16.4); it is not hidden from the database owner or a
   service-role key, so the property assumes the treasurer is not also the
   database administrator. Nothing can make a human keep a secret.
4. **The server still sees nonces at reveal.** It cannot change the winner
   (every member recomputes it), but it is trusted to *publish* them.
5. **The database does not recompute the winner derivation.** `reveal_draw_v1`
   checks structure (opened set equals the sealed set for v3, nonce length, digest
   equality, and, for a server-created draw, that seed and nonces equal what
   `open_draw_reveal_v1` published) and the existing trigger pins the winner to
   the committed roster and index. Since M4.4 the database *does* recompute four
   plain length-prefixed hashes (member seal, member-set digest, commitment v3,
   ticket) to check a nonce against its seal and a seed against the commitment;
   they are pinned to the TypeScript engine by golden vectors (§16.6). The
   transcript digest and the rejection sampler that pick the winner are still not
   reimplemented in plpgsql (see `20260926110000_draw_reveal_binding.sql` for
   why); those are enforced by `verifyRound` on the server and, independently, by
   every member's browser.

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

Tables: `draw_cycles`, `draw_commitments`, `draw_reveals`, `draw_payouts`, and
(M4.4, §16) `draw_sessions`, `draw_seals`, `draw_nonces`, `draw_reveal_openings`.
Append-only is enforced by `sened_draw_block_mutation` on every table except
`draw_seals`, which may be replaced while a draw is still sealing and never after.
Rotation and the reserve split are re-checked in the database, not trusted from
the app.

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

### Haptic feedback

`src/lib/draw/haptics.ts` wraps `navigator.vibrate` with one named pattern per
ceremony moment: `commitSealed` (one firm 40 ms stamp), `revealStep` (a 15 ms
tick), `winnerRevealed` (a rising flourish) and `tamperDetected` (three long,
evenly spaced pulses, deliberately unlike the celebration). It is browser-only
and feature-detected.

- **Not on iOS.** Safari, and every browser on iOS (all WebKit), has no Vibration
  API, so iPhone and iPad users feel nothing. It is a silent no-op there, and the
  switch on `/draw` is disabled and says so. Nothing stands in for it.
- **Off under reduced motion**, checked at the moment of each buzz, and off if the
  user switches it off (`HapticsToggle`, stored in `localStorage` under
  `sened.draw.haptics`; default on; storage failures fall back to on).
- **Only after the user acts.** Browsers need a prior user gesture. The demo buzzes
  from its commit and reveal clicks; the live screen buzzes after a successful
  seal, commit, release or reveal, and the winner or tamper pattern fires from
  this device's own recomputation (`verifyInBrowser`), only for a draw whose
  reveal the user just moved forward (reveal, or a refresh that picks it up).
  Opening an already-revealed draw does not vibrate. A device/server disagreement
  or a seed that fails the commitment (`COMMITMENT_MISMATCH`) is the tamper pattern.
- The winner moment's visual counterpart already existed: confetti and the pulsing
  basket in `MesobCeremony`, both off under reduced motion.

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

`VerifyPanel` and `RiskPanel` take a `locale` (Amharic by default, as before) and
say everything through the `drawVerify.*` / `drawRisk.*` keys. The engine's risk
notes and the follow-ups on a verification result (`DrawRiskAssessment.noteItems`,
`DrawVerificationResult.warningItems`) are structured data alongside the English
strings, so the screen can say them in either language; verification *errors* are
said by code, with the engine's English detail kept underneath as technical
detail.

The page states plainly that it runs on-device and does not depend on the server
— because that is true, and because a demo that quietly implied server
verification would be a fabricated trust signal. That demo is now the signed-out
mode only, behind a demo banner; see §14 for the signed-in flow.

## 11. API

| Route | Who | Notes |
|---|---|---|
| `POST /api/draw/cycles` | owner / treasurer | creates a cycle; the pot is computed by the database |
| `GET /api/draw/cycles?groupId=` | any member | the group's cycles |
| `GET /api/draw/cycles/[cycleId]` | any member | the cycle and every draw in it, with each draw's state |
| `POST /api/draw/draws` | owner / treasurer | opens a draw (the server creates its id) for sealing |
| `GET /api/draw/draws/[drawId]` | any member | a draw in progress: seal hashes, and per member only whether a nonce was released |
| `POST /api/draw/seals` | any eligible member, **for themselves** | `{ drawId, sealed }`; no member id |
| `POST /api/draw/nonces` | any sealed member, **for themselves** | `{ drawId, nonce }`; only after the commit; never echoed |
| `POST /api/draw/commits` | owner / treasurer | `{ drawId, seed?, commitmentNonce?, idempotencyKey }`; everything else is read from the database |
| `POST /api/draw/reveals` | owner / treasurer | `{ drawId, seed, idempotencyKey }`; the nonces are the stored ones |
| `POST /api/draw/verify` | **any member** | deliberately not role-gated |
| `GET /api/draw/rounds/[roundId]` | any member | published round + transcript |
| `POST /api/draw/payouts` | owner / treasurer | posts through `LedgerService.append` |
| `GET /api/draw/collateral?cycleId=` | any member | the derived collateral view (§17): winners, later rounds with `met` / `flagged` / `not_due`, guarantees, reserve retained |
| `POST /api/draw/guarantees` | see §17.5 | `{ action: "propose" \| "accept" \| "decline" \| "release" \| "supersede", ... }`; accept and decline only by the guarantor |

`/verify` and the round read are authenticated but **not** role-gated. A member
who cannot open the ledger still has to be able to check the draw; that is the
social contract. The role is the caller's role *in the group*, decided in SQL from
`auth.uid()` (`sened_ledger_can_manage_group`), never from a JWT claim or a body
field. Every body schema is `.strict()`: a commit that still carries `members`,
`potAmount` or `memberCommitments`, a reveal that carries `memberNonces`, or a
seal or nonce that names a member is a 400.

Handler factories (`createCommitHandler(serviceFactory)`) follow the banking
lane's Style B, so tests inject a fake service and the production path is
exercised separately to prove it 503s when Supabase is unconfigured. The new
schemas (`drawCycleCreateRequestSchema`, `drawOpenRequestSchema`,
`drawSealRequestSchema`, `drawNonceRequestSchema`) live in `src/lib/validation.ts`;
the commit and reveal schemas stay in `src/lib/draw/schemas.ts`.

**Rate limiting:** every `/api/draw/*` path, including `rounds/[roundId]`,
`cycles/[cycleId]` and `draws/[drawId]` via a UUID regex, is in
`src/middleware.ts`'s `RATE_LIMITED`: cycle create, draw open, seal and nonce take
the write rule, the lists and reads the read rule (`/api/draw/cycles` carries both,
so the method picks).

## 12. Tests

`test/draw.*.test.ts*` (the table below lists the main ones; later additions:
`draw.fairness.test.ts`, `draw.rpc-contract.test.ts`, `draw.live.test.tsx`,
`draw.nonce-binding.test.ts`, and for M4.4 `draw.sessions.test.ts`,
`draw.cycles.api.route.test.ts`, `draw.sql-parity.test.ts`,
`draw.ledgerFigures.test.ts`, and for M4.2's completion `draw.collateral.test.ts`,
`draw.collateral.api.route.test.ts`, `draw.collateral.ui.test.tsx`,
`draw.collateral.client.test.ts`, `ledger.attribution.rpc-contract.test.ts`,
`ledger.attribution.api.route.test.ts`, `ledger.clientAttribution.test.ts`,
`contribution-feed.attribution.test.tsx`, `home.attribution.test.tsx`). The SQL itself is proven by
`scripts/verify-migrations.sql` against a real Postgres 16, not by vitest. Counts
are in the report that accompanied the change; run `npx vitest run` for the current
total.

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

`/draw` has two modes, chosen by `useSession`:

- **Signed out, or no Supabase configured** — the on-device demo (`DrawBoard`),
  with a fixture roster. It carries a `data-testid="draw-demo-banner"` label in
  both languages and never calls `/api/draw/*`.
- **Signed in** — `LiveDraw` (`src/components/draw/LiveDraw.tsx`), backed by
  `src/lib/draw/clientDraw.ts`. The group is the app's **active group**
  (`readMyGroup` with the id from the group switcher; see
  `src/lib/groups/activeGroup.ts`): the only group, else the user's remembered
  choice, else the screen asks (`choose-group`) and reads nothing. It refuses on
  no group. Switching groups remounts the screen so nothing of one group's
  cycle, draw or seal shows under another. The roster comes from
  `GET /api/ledger/members`.

The screen is organised around a **cycle** (picked from the group's list, or
created by the owner/treasurer) and the **draws** in it. Sequence, and who may do
each step (see §16 for the state machine):

| # | Step | Call | Who |
|---|---|---|---|
| 0 | Create a cycle (contribution, rounds, reserve) | `POST /api/draw/cycles` | owner / treasurer |
| 1 | Open the draw for the next round | `POST /api/draw/draws` | owner / treasurer |
| 2 | **Seal** a nonce made on this device | `POST /api/draw/seals` | each eligible member, for themselves |
| 3 | Commit | `POST /api/draw/commits` | owner / treasurer |
| 4 | **Release** the nonce, once the commitment is published | `POST /api/draw/nonces` | each sealed member, for themselves |
| 5 | Reveal with the seed | `POST /api/draw/reveals`, then `POST /api/draw/verify` | owner / treasurer |
| 6 | Verify | `POST /api/draw/verify` | any member |
| 7 | Payout (after an explicit confirmation) | `POST /api/draw/payouts` | owner / treasurer |

Notes on how it behaves:

- **Verification is recomputed in the browser** (`verifyInBrowser`) from the
  published transcript with `webDrawHasher`: roster digest, tickets, member
  digest, commitment, transcript digest, winner (`verifyTranscript`), plus that
  every member nonce opens its sealed hash, and the payout/reserve split
  (`planReserve`). The result is *compared* with the server's verdict, winner,
  transcript digest and amounts; any difference is shown as a disagreement and
  the payout is withheld. `/api/draw/verify` returns `memberNonces` once the draw
  is revealed so the openings can be checked on the device.
- **Payout** is offered only to owner/treasurer, only when this device verified
  the draw and agrees with the server. It shows the winner, the amount, the
  reserve and the `PAYOUT_EXPENSE` (debit) and `POT_CASH` (credit) account ids
  from `/api/my-groups`, and the button stays disabled until a confirmation box
  is ticked.
- **Members' buttons appear only when the server will accept them.** "Seal my
  nonce" while the draw is sealing and the member is eligible; "Release my nonce"
  only when the draw is committed, the frozen sealed set contains this member's
  seal exactly as this device holds it, and the reveal has not been requested.
  Otherwise the screen says why (not eligible; seal missing from the commitment;
  this device no longer holds the nonce; reveal already requested). The nonce is
  generated here, persisted before the seal is sent, kept until released, and
  never rendered.
- **Progress** is shown to everyone: "n of m eligible members have sealed" and,
  once committed, "n of m sealed members have released", with a per-member badge.
  The treasurer's Commit is disabled until a member other than the committer has
  sealed, and Reveal until every sealed member has released.
- **Contribution, pot and reserve are not typed.** They come from the cycle
  (§16.2). The cycle card shows each member's expected contribution, the pot (and
  how many members it was sized for, with a notice if the group has since grown),
  and what the ledger shows (§16.5).
- The treasurer's seed lives in `localStorage` (per draw) on the treasurer's
  device until the reveal (the server never returns one it generated), and is
  wiped after. The commit endpoint takes the seed in clear because the server
  computes the commitment; the seed is not stored until the reveal, but the server
  does see it.
- The roster published with a commit is the group's active members who have not
  yet won this cycle. Display names are `Member <8 hex>`: an email is never
  published (members have not agreed to show it).
- Error codes from the routes are mapped to bilingual messages
  (`drawErrorKey`); the server's own `message` is shown beneath.
- The request body cap is 8 KiB (`MAX_BODY_BYTES`).

Tests: `test/draw.live.test.tsx` runs the real route handlers and `DrawService`
(in-memory repository that mirrors the SQL rules) behind a fake `fetch`, as the
treasurer and as members on separate "devices", so the browser verifies what a
real server would publish. `test/draw.sessions.test.ts` covers the lifecycle rules
at the service level.

## 15. Deferred

- ~~Cycle creation / listing~~ — done (§16, M4.4).
- ~~A member-seal endpoint and a UI to show who has sealed~~ — done (§16, M4.4).
- ~~Contribution amounts and pot typed by the treasurer~~ — the cycle defines
  them; the commit takes them from the cycle (§16.2).
- **Per-member payment status.** Delivered in two parts. An entry posted from a
  verified bank receipt carries provenance naming the member whose receipt it was
  (§16.5). An entry with no bank provenance (cash, a manual entry) can now be
  attributed to the member who paid by an owner or treasurer, as an append-only
  record beside the entry that is labelled as the treasurer's record and never as
  verified (§17.1). Per-round status is derived for each winner's later rounds
  (§17.3). Still open: entries carry no cycle or round id of their own, so for
  anyone who is not a winner there is no per-round figure (only the window "since
  the cycle started"), and a payer the treasurer never recorded stays unattributed.
- **Collateral beyond a record.** Guarantees are advisory (§17): nothing debits a
  guarantor or moves money, and the database does not stop the next round from
  being drawn while a winner is flagged. Enforcement is the group's decision.
- **Closing a cycle.** `draw_cycles.closed_at` exists but the table is append-only
  and there is no closing RPC; a cycle is complete when every round is drawn.
- **Draws committed before M4.4** have no stored nonces. They can be read and
  verified, but cannot be revealed through the API (`reveal_draw_v1` still accepts
  them with caller-supplied nonces, for a database owner). Open a new draw instead.
- **Live updates.** Progress refreshes after your own actions and with the Refresh
  button; there is no polling or push, so a treasurer waiting on members presses
  Refresh.
- **A lost nonce** cannot be recovered after the commit (the screen never shows
  it). While sealing, the member re-seals; after the commit the draw cannot be
  completed, and the treasurer opens a new draw, which leaves the
  abandoned-commitment trace (§5.5).
- ~~Observation: the winner depended on the member digest, not the nonces, so a
  treasurer could grind seeds before committing~~ — fixed in protocol v3 (§5);
  the residual properties that remain are listed in §5.5.
- ~~`VerifyPanel` and `RiskPanel` carry Amharic-only text~~ — localised (§10).
- **Supabase round-trip tests** — the repository is written and the SQL is
  verified against real Postgres, but the suite has no live-Supabase test. The
  existing lanes use the same mocked-`rpc` approach. The RPC contract test
  (`test/draw.rpc-contract.test.ts`) pins parameter names, grants and the
  secrecy-relevant structure of the migration to the repository.
- ~~Wiring the ceremony UI to the API~~ — done for signed-in users (§14).
- ~~Rate-limit buckets~~ — done (R-1).

## 16. Cycles, server-created draws, and member seals and nonces (M4.4)

`supabase/migrations/20261005100000_draw_cycles_and_member_seals.sql`.

### 16.1 The state machine

A draw's state is derived from which rows exist (`sened_draw_state`), never stored:

```
(none) --open_draw_v1--> SEALING --commit_draw_from_seals_v1--> COMMITTED
        COMMITTED --open_draw_reveal_v1 + reveal_draw_v1--> REVEALED --record_draw_payout_v1--> PAID
```

| State | Rows | What is allowed | Refused (SQL message, HTTP) |
|---|---|---|---|
| sealing | `draw_sessions` | members seal or replace their own seal; owner/treasurer commits | nonce (`draw_nonce_too_early`, 409) |
| committed | + `draw_commitments` | members release their own nonce, once; owner/treasurer requests the reveal | seal (`draw_already_committed`, 409) |
| committed, reveal requested | + `draw_reveal_openings` | owner/treasurer completes the reveal | nonce (`draw_already_revealed`, 409) |
| revealed | + `draw_reveals` | payout | everything earlier |
| paid | + `draw_payouts` | nothing | everything earlier |

Also enforced: rounds open and reveal in order (`draw_round_out_of_order`); a cycle
with every round drawn opens nothing (`draw_cycle_complete`); opening a draw while
one is still sealing for the round continues that one; opening a new draw for a
round whose previous draw was committed and abandoned is allowed and marks the
old one `superseded` in the listing (the abandoned commitment is counted, §5.5).

### 16.2 Cycles

`create_draw_cycle_v1(group, name, contribution, total_rounds, reserve_bps,
started_at, idempotency_key)`: owner/treasurer of the group. `draw_cycles` gains
`contribution_amount`, `created_by` and `idempotency_key` (existing rows keep a null
contribution; their `pot_amount` stays authoritative). **The pot is
`contribution × active members at creation`, computed in SQL.** Rounds may not
exceed the members (each member is drawn once), and the same key replays while the
same key with different terms is `draw_idempotency_conflict`. Cycles are
append-only, so the terms are fixed for the cycle.

The commit then takes everything from the cycle and the group, not from the
caller: `commit_draw_from_seals_v1` has no pot, rounds, reserve, group, cycle or
round argument. It verifies the roster against the group (the participants must be
exactly the active members who have not won this cycle, each at the cycle's
contribution, each ticket re-derived), and the sealed set against the stored seals.
`commit_draw_v1`, which took the sealed set and the roster from the caller, is
revoked from `authenticated`.

### 16.3 Who can call what

| RPC | Caller | Identity |
|---|---|---|
| `create_draw_cycle_v1`, `open_draw_v1`, `commit_draw_from_seals_v1`, `open_draw_reveal_v1`, `reveal_draw_v1` | owner or treasurer of the group | `auth.uid()` via `sened_ledger_can_manage_group` |
| `submit_draw_seal_v1` | an active member who is on this round's eligible roster | `auth.uid()`; the function has no member argument |
| `submit_draw_nonce_v1` | an active member whose seal is in the committed set | `auth.uid()`; no member argument; only the caller's own seal is consulted |
| `list_draw_cycles_v1`, `get_draw_cycle_v1`, `get_draw_session_v1` | any active member | `sened_ledger_can_access_group` |

A caller who cannot manage (or, for reads, access) the group gets `draw_forbidden`
(42501), and for a group or cycle id the answer is the same whether it exists or
not; an unknown draw id is `draw_not_found` (draw ids are server-generated UUIDs). Tables follow the existing pattern:
RLS on, every privilege revoked from `anon` and `authenticated`, select granted
back with a group-access policy. The exception is `draw_nonces` (§16.4).

### 16.4 How nonce secrecy before the reveal is enforced

1. `draw_nonces` has RLS enabled, **no policy** and no grant to any client role: it
   cannot be selected through PostgREST by anyone, treasurer included. The
   harness and the contract test assert it (no policy, no privilege).
2. `get_draw_session_v1` / the listing report, per sealed member, only a boolean
   `released`; the application projection copies named fields so even a service
   that carried a nonce could not publish one. Seals are hashes.
3. The only function that returns a nonce is `open_draw_reveal_v1`. It requires the
   owner/treasurer, a committed v3 draw, every sealed member's nonce stored, and
   **a seed that reproduces the published commitment** (checked in SQL, so a junk
   seed cannot be used to read the nonces and walk away). It then writes the seed
   and the nonces to `draw_reveal_openings`, which every group member can read, in
   the same statement that returns them: the treasurer learns the nonces only by
   making them public. A retry with the same seed replays; a different seed never
   replaces it.
4. `reveal_draw_v1` on a server-created draw can only carry the published seed and
   exactly the published nonces; anything else is refused.
5. The caller supplies the seed and nothing else in `POST /api/draw/reveals`
   (`memberNonces` is a 400).

### 16.5 Ledger figures and bank provenance

`LiveDraw` pages back through the group's entries with the `GET /api/ledger/entries`
cursor (`loadCycleLedgerFigures`) and shows the contribution entries recorded since the
cycle started (`cycleLedgerFigures`): count and total, and who has paid.

**Where provenance comes from.** The link already existed:
`bank_verification_intents.ledger_entry_id`, written by
`record_bank_verification_result_v1` / `finalize_bank_reconciliation_job_v1` when
`LedgerBankVerificationSink` posts the entry (idempotency key
`bank-verified-<intent key>`), under a composite foreign key to
`ledger_entries (id, group_id)`. The key is not parsed on the read path. Migration
`20261006100000_ledger_entry_provenance.sql` backfills the link for a VERIFIED intent
whose result was never stored (same group, the sink's key, the intent owner as
actor, the entry type its direction implies, a debit posting of its amount) and adds
`get_ledger_entry_provenance_v1(group, entry ids)`.

**Why a function.** `bank_verification_intents` is owner-read only, so another
member could never learn that a contribution was verified. The SECURITY DEFINER
function checks `sened_ledger_can_access_group`, filters on the group, and returns
only `entryId, verificationId, provider, verifiedAt, memberUserId` for VERIFIED
intents. No policy or table privilege is widened. The provider reference exists only
as ciphertext and HMACs, and nothing derived from it is returned, so there is no
masked reference. `GET /api/ledger/entries` and the `/api/sync` pull attach it as
`provenance: { kind: "bank_verification", provider, verifiedAt, verificationId,
memberUserId } | null` on each entry (`null` for every entry the sink did not post).
It is not part of the entry hash, so the chain is unaffected.

**What `/draw` shows.** Each entry in the window is credited to `provenance.memberUserId`
(never to the actor). Members with bank-verified entries are listed with their total
and count; entries without provenance are counted and totalled as unattributed. The
window is "since the cycle started": the cycle has no cadence and entries have no
round id, so there is no per-round period, and a member who is not listed has no
bank-verified entry in the window, which is not the same as unpaid. Member labels are
the members API's own (email for the owner, "Member xxxxxxxx" otherwise).

**Update (M4.2 completion, §17.1).** Provenance is now one of two sources of an
`attribution` on each entry; the figures credit `attribution.memberUserId`, count
`verifiedCount` and `treasurerCount` apart, and label a treasurer-only member "recorded
by the treasurer, not bank-verified". The paragraph above describes the bank half.

**Large groups.** Entries are read newest first, 100 per page, following `nextCursor`
(`beforeSequence`) until a page's oldest entry was *recorded* before the cycle began
(sequence and recording time rise together on the append-only chain; `occurredAt`
cannot decide this because an entry can be backdated), or the ledger runs out. A group
of any size is therefore attributed. The read is bounded at 20 pages (2,000 entries,
`FIGURES_MAX_PAGES`); only if that bound is hit before the cycle's start is reached
does `/draw` say the ledger could not be fully read and show no total rather than a
guess. The pot balance on the home screen does not depend on paging at all: it comes
from `GET /api/ledger/balances` (`get_ledger_balances_v1`, migration
`20261007100000_ledger_balances.sql`), a `sum()` over postings in one database
snapshot.

### 16.6 Database-side hashes and their parity

To check a nonce against its seal and a seed against the commitment, four plain
length-prefixed hashes are reimplemented in plpgsql: `sened_draw_member_seal_hash`
(`sened-draw-member-v1`), `sened_draw_member_set_digest` (`-member-set-v1`),
`sened_draw_commit_hash_v3` and `sened_draw_ticket`. They are pinned to the
TypeScript engine by golden vectors asserted by `test/draw.sql-parity.test.ts`
(against the real engine) and by `scripts/verify-migrations.sql` (against the SQL
functions), using the same literals. Note: Postgres rejects a regex repetition
bound above 255 (`{16,256}` fails at run time); `test/migrations.postgres-pitfalls.test.ts`
guards that.

### 16.7 Deploy order

Apply the migration together with the application release. The previous
application called `commit_draw_v1`, which is no longer callable by clients.


## 17. M4.2 completion: who paid a cash contribution, and collateral

`supabase/migrations/20261010100000_contribution_attribution_and_collateral.sql`,
proven by the "ATTRIBUTION" and "COLLATERAL" checks in `scripts/verify-migrations.sql`
(success marker `ALL ATTRIBUTION AND COLLATERAL CHECKS PASSED`, also required by
`scripts/verify-migrations.ps1`).

### 17.1 Member attribution for contributions with no bank verification

**Problem.** A ledger entry's actor is whoever *recorded* it, not who paid. Only an
entry posted from a verified bank receipt named a payer (provenance). A treasurer's
cash entry named nobody.

**Data model.** `ledger_entry_attributions` (append-only, beside the entry; the
hash-chained entry format is untouched and `entry_hash`, `previous_hash`, the postings
and the chain head never change):

| column | meaning |
|---|---|
| `id`, `entry_id`, `group_id`, `tenant_id` | the row, and the entry it is about (composite FK to `ledger_entries (id, group_id)`) |
| `member_user_id` | the member who paid |
| `recorded_by`, `recorded_at` | who recorded it (always `auth.uid()`) and when |
| `cycle_id`, `round` | optional: which round of which cycle the payment is for (a round needs a cycle; the cycle must be this group's) |
| `supersedes_id`, `reason` | null on the first record; on a correction, the record it replaces and why (10..1000 characters) |

One first record per entry (unique index on `entry_id where supersedes_id is null`),
each record superseded at most once (unique index on `supersedes_id`), so the history
of an entry is one line and its current value is the last row. A mistake is never
edited or deleted: update, delete and truncate are refused by triggers (the same
pattern as the draw tables), and `authenticated` has `select` only.

**Rules** (in the RPC, and again in a before-insert trigger for any writer): only an
owner or treasurer of the entry's group (`sened_ledger_can_manage_group`); only a
`contribution` entry of that group (another group's entry reads "not found", like an
absent one); the member must be an *active* member of the group; a contribution
already reversed by a correction cannot be newly attributed.

**Precedence: bank provenance wins.** A manual attribution is refused on an entry
that has a VERIFIED bank verification linked to it (`attribution_bank_verified`),
first record and supersede alike. If a bank link appears *after* a manual record
exists, the read still reports the bank (`sened_effective_attribution` orders bank
first); the manual row stays in the history, unused. The client does the same
(`effectiveAttribution`), so a response carrying both is read as bank-verified.

**Read path.** `get_ledger_entry_attributions_v1(group, entry ids)` (any active
member) returns, for each contribution that has one, the effective attribution.
`GET /api/ledger/entries` and the `/api/sync` pull attach it as `attribution`, next
to `provenance` (whose shape is unchanged):

```
attribution: null | {
  source: "bank_verification" | "treasurer",
  memberUserId, recordedBy, recordedAt,
  cycleId: string | null, round: number | null,
  revision: number,          // 1 = never corrected
  reason: string | null      // the latest correction's reason
}
```

For `bank_verification`, `memberUserId` and `recordedAt` are the verification's own
user and time and `recordedBy` is the actor who recorded the entry.

**Writing it.**

| | Who | Body |
|---|---|---|
| `POST /api/ledger/attributions` | owner / treasurer | `{ groupId, entryId, memberUserId, cycleId?, round? }`; 201, or 200 for a repeat |
| `PUT /api/ledger/attributions` | owner / treasurer | the same plus `reason` (10..1000); appends a superseding record |
| `POST /api/ledger/entries` | owner / treasurer | optional `attribution: { memberUserId, cycleId?, round? }` on a **contribution**: the entry is posted first (the `attribution` is split off before validation, fingerprint and hash), then attributed; a refusal is *reported* in the response (`attribution: { status: "refused", error }`) and never rolls the entry back |

The body never names who is recording or the source (a 400). Errors carry the
database's code: 403 `forbidden`; 404 `ledger_entry_not_found`,
`ledger_member_not_found`, `ledger_cycle_not_found`, `attribution_not_found`; 422
`attribution_not_contribution`; 409 `attribution_bank_verified`,
`attribution_entry_corrected`, `attribution_exists`, `attribution_unchanged`,
`attribution_conflict`.

**Where it is used.**

- *Home feed.* A row with a treasurer record reads "Paid by <member> · Recorded by the
  treasurer · not bank-verified". It keeps the plain "Recorded in ledger" badge and can
  never show the verified badge, the verified "Paid by" line or the verified detail
  title, even if a caller sets `status: "VERIFIED"` without a verifier (`isVerified`
  fails closed). The owner or treasurer gets a "Who paid this?" control in a ledger
  row's detail (a member picker; correcting an existing record also asks for a reason
  and says the earlier record stays). A plain member sees no control (and the database
  refuses them anyway); a verified row offers none, because a bank's word cannot be
  overridden.
- */draw cycle figures.* `cycleLedgerFigures` credits `attribution.memberUserId`, so
  who-paid works for a cash group. Each member shows `verifiedCount` and
  `treasurerCount`; a member with only treasurer records is marked "recorded by the
  treasurer, not bank-verified". Entries nobody attributed stay unattributed.

**Posting-time attribution.** Two screens record a contribution with its payer, and
both use the `attribution` on `POST /api/ledger/entries` or its `/api/sync` twin.

*The record-contribution form* (`src/components/ledger/RecordContributionForm.tsx`,
mounted on `/ledger` as `#record-contribution`; the home feed links to it for an owner
or treasurer). Only an owner or treasurer gets controls; a plain member and a signed-out
visitor get read-only text, and the database refuses everyone else regardless. Fields:
amount (exact decimal ETB, validated with `isEtbAmount` / `formatEtbAmount`, never a
float), date paid (not in the future), the payer (the group's active members from
`GET /api/ledger/members`), and optionally a cycle (`GET /api/draw/cycles`) and a round
within `1..totalRounds`; choosing a cycle offers its per-member contribution as the
amount if none is typed. The request is `buildContributionRequest`: a balanced
`contribution` (debit `POT_CASH`, credit `CONTRIBUTION_INCOME`, the group's own account
ids from `/api/my-groups`), plus `attribution: { memberUserId, cycleId?, round? }`. The
channel and a free-text note are not recorded, because a contribution's entry schema has
neither (`rationale` is accepted for corrections only).

The idempotency key is per *attempt*: the same values resubmitted after a failure or an
unknown outcome reuse the key and the timestamp, so the request is byte-identical and
the ledger can post it only once; a changed value is a new attempt; a definite answer
(invalid, conflict) retires the key; a double click while a request is in flight is
ignored. The result is one of:

| result | what the screen says |
|---|---|
| posted and attributed | entry number, and "Payer recorded ... recorded by the treasurer, never as bank-verified" |
| posted, attribution refused | the entry is posted, the database's reason (for example the entry is bank-verified), and **Retry recording the payer**, which calls `POST /api/ledger/attributions` for that entry only: the entry is never posted again for it |
| posted, attribution write failed | the same, with "saving the payer failed and nothing says it was refused" |
| failed (invalid, forbidden, conflict, rate-limited, unknown) | nothing is shown as recorded; the typed values stay; an unknown outcome says resubmitting the same attempt cannot post twice |

A response that says nothing about the attribution is read as *not* recorded, never as
recorded.

*Offline drafts.* A contribution draft may carry the same payer, cycle and round
(`LedgerDraftRow.attribution`; shape-checked on the device by
`normalizeDraftAttribution`, which mirrors `ledgerEntryAttributionSchema`). It rides in
the outbox payload as `payload.attribution`, beside the request and outside it, so it is
never part of the entry's fingerprint or hash. `POST /api/sync` splits it off exactly as
the entries route does, appends the entry, then calls `record_ledger_entry_attribution_v1`
and reports the outcome beside the entry's verdict (see `offline-pwa.md` §3 for the
contract). A malformed attribution, or one on a non-contribution, is that draft's
`REJECTED` / `invalid_request` before anything is written. **Replay:** the entry is
`REPLAYED` by the ledger's idempotency, and the attribution is attempted again; the
RPC answers an identical record with the existing one (`replayed: true`, so `RECORDED`),
so a replay never writes a second record, and a replay whose first attribution never
landed records it now. A replay naming a *different* payer gets `attribution_exists`
(`REFUSED`) and the first record stays.

**What does not exist.** There is no channel or note on a contribution. The offline
member and cycle lists are a per-device copy of the last online read (labelled as such);
the server re-checks the member and cycle when the draft syncs. The retry of a refused
attribution is a button on `/offline` (or on the form), not automatic. Voice
contributions still go through bank verification, which carries its own provenance.

### 17.2 Collateral: guarantors

**Data model.**

- `draw_collateral_guarantees`: one immutable *proposal* (`cycle_id`, `winner_member_id`,
  `guarantor_member_id`, `proposed_by`, `proposed_at`). `guarantor <> winner` is a
  CHECK.
- `draw_collateral_guarantee_events`: append-only events `accepted`, `declined`,
  `released`, `superseded` (`actor_id`, `reason`, `successor_guarantee_id`, an identity
  `seq`). **The state is the latest event** (`proposed` while there is none): no status
  column exists to edit. `released` and `superseded` need a reason of 10..1000
  characters; a guarantee is accepted at most once and ends at most once (unique
  indexes); update, delete and truncate are refused by triggers.

**A guarantee needs the guarantor's own consent.** `accepted` and `declined` can only
be written with `actor_id = guarantor_member_id`: `respond_collateral_guarantee_v1`
takes no member argument and refuses anyone but the guarantor (an owner, a treasurer,
the winner and an outsider all get `collateral_forbidden`), and a trigger holds the
same rule for any other writer. The guarantor must still be an active member.

**Rules.** Only an owner or treasurer proposes or supersedes. The winner must have
actually won a round of *that* cycle (`draw_commitments` joined to `draw_reveals`),
with rounds left (`collateral_no_remaining_rounds` for the last round's winner). The
guarantor must be an active member and not the winner. At most one open guarantee per
(cycle, winner, guarantor) (a repeat is a replay) and five open per winner. A released
guarantee does not block a new one. `release` is by the guarantor (withdrawing their
own word) or an owner/treasurer; `supersede` is owner/treasurer, ends the old
guarantee pointing at its successor and opens a new proposal that the new guarantor
must accept themselves.

### 17.3 Post-win obligations and the default rule

Nothing about "paid" or "in default" is stored. `get_draw_cycle_collateral_v1` derives it
on every read, for each winner and for each round *after* the one they won (the rounds
they still owe):

| status | meaning |
|---|---|
| `met` | a qualifying contribution is assigned to the round |
| `flagged` | **not** met, and the round's draw has been **opened** (a `draw_sessions` row, or a legacy commitment, exists for that round) |
| `not_due` | not met, and no draw for that round has been opened |

**The default rule.** *A winner is flagged for round r when the draw for round r has
been opened (or committed) and no qualifying contribution is assigned to that round for
that winner.* A **qualifying contribution** is a contribution entry that:

1. is not reversed by a correction;
2. is attributed to the winner: bank provenance, else the current treasurer record
   (the same precedence as §17.1);
3. moved at least the cycle's contribution amount into `POT_CASH` (the sum of its debit
   postings on `POT_CASH`; a cycle with no contribution on record uses 0.01);
4. was *recorded* (server time, which cannot be backdated; not `occurredAt`) on or after
   the cycle's start;
5. is not attributed to a different cycle.

It is *assigned* to a round **explicitly** (a treasurer attribution carrying this cycle
and that round; it may be a round not yet due, which is then `met`) or **by order**: the
winner's remaining entries, oldest first, each fill the earliest still-unmet *due* round
whose previous round had been revealed *before the entry was recorded* (so a payment
made before the previous reveal cannot pay a later round, and a payment from before the
win pays nothing); one entry pays one round.

`flagged` is a flag, not a verdict. It says the ledger cannot show the contribution,
not that the member did not pay: they may have paid in a way not yet recorded, and the
flag clears by itself the moment an attributed entry exists (or returns if that entry
is later reversed). The screen says so beside the flag.

### 17.4 What `/draw` shows

A collateral panel (`CollateralPanel`, between the ledger figures and the draw list),
re-read whenever the cycle's draws change and after every guarantee command. It opens
with "Advisory only. Nothing here moves money or debits anyone...". It shows, in exact
ETB minor units:

- *reserve retained so far* (the sum of the reserves withheld from revealed payouts),
  *winners still owe* (contribution times each winner's unmet rounds), *overdue*
  (contribution times flagged rounds), whether the retained reserve covers the overdue
  amount, and *the reserve planned for the next payout* (the existing `planReserve`
  heuristic, §7, with the roster that remains);
- per winner: the round they won, their later rounds with each status (and, for a met
  round, whether the payer is bank-verified or recorded by the treasurer), and their
  guarantors, each with their own state ("Waiting for the guarantor's own confirmation",
  "Confirmed by the guarantor", declined, released, replaced);
- controls by role: the **guarantor** alone gets "I confirm I vouch for this member" and
  "Decline"; the owner or treasurer gets propose, release and replace (with reasons);
  nobody else gets any. An owner or treasurer is never shown a way to confirm on someone
  else's behalf.

All of it is in `en` and `am` (`collateral.*`, `collateralLive.error.*`,
`shell.feed.attribute.*`).

### 17.5 Who can call what

| RPC | Caller | Identity |
|---|---|---|
| `record_ledger_entry_attribution_v1`, `supersede_ledger_entry_attribution_v1` | owner or treasurer | `auth.uid()` via `sened_ledger_can_manage_group`; no "recorded by" argument |
| `get_ledger_entry_attributions_v1` | any active member | `sened_ledger_can_access_group` |
| `propose_collateral_guarantee_v1`, `supersede_collateral_guarantee_v1` | owner or treasurer | `auth.uid()` |
| `respond_collateral_guarantee_v1` | **the guarantor, only** | `auth.uid()` must equal the guarantee's guarantor |
| `release_collateral_guarantee_v1` | the guarantor, or an owner/treasurer | `auth.uid()` |
| `get_draw_cycle_collateral_v1` | any active member | `sened_ledger_can_access_group` |

All are SECURITY DEFINER with `search_path = public, pg_temp`, revoked from `public` and
`anon`, granted to `authenticated`; the helpers are granted to nobody. The tables have RLS
on, every privilege revoked and `select` granted back with a group-access policy (the
events table through its guarantee's group).

### 17.6 Advisory, and what it does not do

Nothing here debits a guarantor, moves money, writes the ledger or a posting, or
blocks a draw (a test asserts the ledger head and entry count are unchanged by every
guarantee operation, and the contract test asserts the SQL never writes `ledger_*`).
The reserve is still a heuristic (§7), not a proven equilibrium model; the guarantee is
a social record, not collateral that can be seized. A member who pays by a route that
is never attributed will be flagged until someone records it.

### 17.7 Deploy order

Apply the migration together with the application release: `GET /api/ledger/entries`
and the `/api/sync` pull call `get_ledger_entry_attributions_v1`, so a release against a
database without the migration fails those reads.
