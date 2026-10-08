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
   secret until after the commit. A treasurer colluding with *every* member can
   grind. Since 20261014100000_draw_integrity.sql **every eligible member must
   seal** before a commit (the database refuses otherwise, and the screen shows
   "N of M sealed" and enables Commit at M of M), so the treasurer no longer
   chooses which seals to include.
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
| `POST /api/draw/cycles` | owner / treasurer | creates a cycle; the pot is computed by the database; `contributionGate?` (`off` default) is the contribution gate policy (§18.2) |
| `GET /api/draw/cycles?groupId=` | any member | the group's cycles |
| `GET /api/draw/cycles/[cycleId]` | any member | the cycle and every draw in it, with each draw's state |
| `POST /api/draw/draws` | owner / treasurer | opens a draw (the server creates its id) for sealing; `overrideReason?` (10..1000 characters) is the recorded reason to open despite a `block` gate (§18.2), which otherwise answers 409 `contribution_gate_blocked` with `flagged: [{ memberId, round }]` |
| `GET /api/draw/draws/[drawId]` | any member | a draw in progress: seal hashes, and per member only whether a nonce was released |
| `POST /api/draw/seals` | any eligible member, **for themselves** | `{ drawId, sealed }`; no member id |
| `POST /api/draw/nonces` | any sealed member, **for themselves** | `{ drawId, nonce }`; only after the commit; never echoed |
| `POST /api/draw/commits` | owner / treasurer | `{ drawId, seed?, commitmentNonce?, idempotencyKey, overrideReason? }`; everything else is read from the database. The contribution gate is checked again here (§18.5): under `block` a flagged pair the override given at open did not name answers 409 `contribution_gate_blocked` with `flagged`, unless `overrideReason` (10..1000 characters) is given, which is recorded; the answer carries `contributionGate: { policy, flagged, overridden, carriedOver }` (null on a replay) |
| `POST /api/draw/reveals` | owner / treasurer | `{ drawId, seed, idempotencyKey }`; the nonces are the stored ones |
| `POST /api/draw/verify` | **any member** | deliberately not role-gated |
| `GET /api/draw/rounds/[roundId]` | any member | published round + transcript |
| `POST /api/draw/payouts` | owner / treasurer | posts through `LedgerService.append` |
| `GET /api/draw/collateral?cycleId=` | any member | the derived collateral view (§17): winners, later rounds with `met` / `flagged` / `not_due`, guarantees, reserve retained |
| `POST /api/draw/guarantees` | see §17.5 | `{ action: "propose" \| "accept" \| "decline" \| "release" \| "supersede", ... }`; accept and decline only by the guarantor |
| `GET /api/draw/contributions?cycleId=` | any member | the derived members x rounds grid (§18): `met` / `flagged` / `not_due` for every member and round, the effective gate, its changes and overrides |
| `POST /api/draw/gate` | owner / treasurer | `{ cycleId, gate: "off" \| "warn" \| "block", reason }` (§18.2); the reason is 10..1000 characters and recorded |

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
`contribution-feed.attribution.test.tsx`, `home.attribution.test.tsx`, and for §18 `draw.contributions.test.ts`,
`draw.contributions.client.test.ts`, `draw.contributions.rpc-contract.test.ts`,
`draw.contributions.ui.test.tsx`, `draw.gate.service.test.ts`, `draw.gate.api.route.test.ts`, and for §17.4-17.5
`ledger.attribution-channel.rpc-contract.test.ts`, and for §18.1 / §18.5 `draw.commit-gate.test.ts`,
`draw.commit-gate.rpc-contract.test.ts`, `draw.commit-gate.ui.test.tsx`, `offline.attribution.autoretry.test.ts`,
`offline.attribution.autoretry.console.test.tsx`, plus channel/note cases added to the attribution, record-form,
feed, home, sync and read-route tests). The SQL itself is proven by
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
  verified (§17.1). Per-round status is derived for every member and every round
  (§17.3, §18.1). Still open: entries carry no cycle or round id of their own, so a
  round is assigned by the treasurer's explicit cycle+round attribution or by order
  (§18.1), never by something the payer wrote; a payer the treasurer never recorded
  stays unattributed (and flagged); there is no `partial` status (§18.1).
- **Collateral beyond a record.** Guarantees are advisory (§17): nothing debits a
  guarantor or moves money. Whether a flagged round stops the next draw is now the
  cycle's contribution gate (§18.2), off unless the owner or treasurer chooses
  `warn` or `block`; the gate is checked when a draw is opened, not when it is
  committed, and a flag that appears after the draw was opened is not re-checked.
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

**Update (§18).** The per-member list described above ("who has paid", since the
cycle started) is superseded by the members x rounds grid (§18), which answers it per
round; `/draw`'s ledger panel now keeps only the totals and the count of entries nobody
has attributed. `cycleLedgerFigures` still computes the per-member split (it is tested),
but the screen no longer shows it.

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
  reason: string | null,     // the latest correction's reason
  channel: "telebirr" | "cbe" | "awash" | "cash" | "other" | null,  // §17.4
  note: string | null                                                 // §17.4
}
```

For `bank_verification`, `memberUserId` and `recordedAt` are the verification's own
user and time and `recordedBy` is the actor who recorded the entry; `channel` is the
verification's provider and `note` is always `null`. `channel` and `note` are additive
(§17.4): a database or client one release behind neither sends nor needs them.

**Writing it.**

| | Who | Body |
|---|---|---|
| `POST /api/ledger/attributions` | owner / treasurer | `{ groupId, entryId, memberUserId, cycleId?, round?, channel?, note? }`; 201, or 200 for a repeat |
| `PUT /api/ledger/attributions` | owner / treasurer | the same plus `reason` (10..1000); appends a superseding record (`channel`/`note`: absent keeps, `null` clears, §17.4) |
| `POST /api/ledger/entries` | owner / treasurer | optional `attribution: { memberUserId, cycleId?, round?, channel?, note? }` on a **contribution**: the entry is posted first (the `attribution` is split off before validation, fingerprint and hash), then attributed; a refusal is *reported* in the response (`attribution: { status: "refused", error }`) and never rolls the entry back |

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
ids from `/api/my-groups`), plus `attribution: { memberUserId, cycleId?, round?, channel?,
note? }`. How it was paid and a short note are recorded with the payer, beside the entry
and never in it (§17.4); `rationale` is still accepted for corrections only.

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

**What does not exist.** The offline member and cycle lists are a per-device copy of the
last online read (labelled as such); the server re-checks the member and cycle when the
draft syncs. Voice contributions still go through bank verification, which carries its
own provenance. The retry of a payer that did not record on the first attempt is
automatic only where that is safe, and otherwise a button (§17.5).

### 17.4 How it was paid, and a note

`supabase/migrations/20261012100000_attribution_channel_and_note.sql`. A contribution's
entry has no channel or free-text field, and the entry format is hash-chained, so neither
is added to it. Both live **beside the entry, on the attribution record**.

**Why the attribution row and not a sibling table.** It is already the per-contribution
metadata record, with exactly the semantics a channel and note need: append-only
(update, delete and truncate refused), one line of history per entry, and correction only
by a superseding row that names the row it replaces and carries a reason. A sibling table
would copy all of that (table, immutability triggers, unique indexes, RLS, two RPCs and a
read function) and then have to be kept consistent with the attribution it describes. The
price is that a channel or note cannot exist without a payer. That matches every writer:
the record form and the offline draft both require a payer for a contribution, and the
"who paid" control is where it is corrected. Two nullable columns are added with
`add column if not exists`; that is not an `UPDATE`, so the immutability trigger is not
involved, existing rows read `null`/`null`, and `ledger_entries` (and so `entry_hash` and
the chain head) is not touched.

**The values.** `channel` is one of `telebirr | cbe | awash | cash | other`, or null (not
said); the first three are the bank-verification providers. `note` is optional plain
text: trimmed, 1..280 characters (code points), with no control character (C0, DEL, C1)
and no invisible bidirectional or zero-width formatting character (U+200B-200F,
U+202A-202E, U+2066-2069, U+FEFF), so a note is one honest line that renders as written.
It is enforced three times with the same rule: `CHECK` constraints on the table
(`ledger_attributions_channel_values`, `ledger_attributions_note_shape`), the RPC
(`ledger_invalid_request`, 22023, before anything is read) and `src/lib/ledger/
paymentChannel.ts` (the Zod schema, the device and the forms). A note is **data**: it is
stored and returned as written, and every screen renders it as text (React escapes it;
nothing here sets inner HTML). Everyone in the group can read it, which the form says.

**RPCs.** `record_ledger_entry_attribution_v1(group, entry, member, cycle, round
[, channel, note])` and `supersede_ledger_entry_attribution_v1(group, entry, member,
reason, cycle, round [, channel, note])`. The old arities were dropped and recreated with
the two trailing parameters defaulting to null, so PostgREST has exactly one function of
each name to choose (checked by the harness: `to_regprocedure` of every old arity is
null), and a caller that sends nothing new behaves as before.

- *record:* null or the empty string means none. An attribution that repeats the existing
  one *including channel and note* is a replay (`replayed: true`, so a retry of a lost
  response is `RECORDED`, not a second row); one that differs in member, cycle, round,
  channel or note is `attribution_exists`.
- *supersede:* the channel and note are **kept** when the argument is null and **cleared**
  when it is the empty string, and the new row stores the resulting full state. So
  correcting the payer alone does not silently wipe them, correcting the channel alone is
  possible, and a correction that changes none of the five values is
  `attribution_unchanged`. Over HTTP: absent keeps, `null` clears (the server maps it to
  the empty string).

**Bank-verified entries (the provenance rule): refuse, do not merely ignore.** The
channel of a bank-verified entry is the *provider* of the verification, and the
treasurer's word is never shown as, or over, a bank's. So record and supersede are
refused with `attribution_bank_verified` for such an entry **whatever channel or note
they carry**: a manual channel can never contradict the provider because it cannot be
written at all (stricter than refusing only a contradicting channel, and it needs no second
rule to stay consistent; a note on a verified entry is refused too, since the bank row has
no note). If a bank link appears *after* a manual row exists, the read reports the bank:
`channel` is the provider and `note` is `null`; the manual row, with its channel and
note, stays in the history unused. This is enforced in SQL (`sened_attribute_entry`, plus
the table trigger for any other writer) and proved by `scripts/verify-migrations.sql`
("ALL PAYMENT CHANNEL AND NOTE CHECKS PASSED").

**Read.** `sened_attribution_json` (so `get_ledger_entry_attributions_v1`, so `GET
/api/ledger/entries` and the `/api/sync` pull) gains `channel` and `note`.
`sened_effective_attribution` is deliberately not changed (its return type belongs to an
earlier migration that the idempotency pass re-applies); a small helper,
`sened_attribution_channel_note`, supplies the two values for the row that wins.

**Screens.** The record form has a channel select and a note field and echoes both back
after posting; the "Who paid this?" control on a ledger row records them with a first
payer and, when correcting, starts from what is recorded and sends only what changed
(a changed channel or note alone keeps the payer as recorded; blanking one clears it; the
reason is still required); the home feed row and detail show the channel and note beside
"recorded by the treasurer" as plain text (a verified row shows its provider and never a
note); an offline draft carries both in its payload (§17.5 and `offline-pwa.md`).

### 17.5 Retrying a payer that did not record

Entry and payer are two writes, and the entry is posted whatever happens to the payer. A
retry therefore sends only `POST /api/ledger/attributions` for the server's entry id (the
entry is never pushed again), and the database answers an identical record with the
existing one, so repeating it cannot double-record. Whether to repeat it *automatically*
depends on the last answer (`src/lib/offline/attributionPolicy.ts`):

| answer | kind | what happens |
|---|---|---|
| nothing reported (`unknown`), `attribution_failed`, `attribution_unreadable`, `attribution_conflict`, a network error, a 5xx, a rate limit | transient | retried automatically, with backoff, within a bound |
| `attribution_exists`, `forbidden`, member not in the group, a verified bank receipt, the entry reversed, not a contribution, entry or cycle not found, anything this client does not recognise | definitive | **never** retried by itself: "Needs your attention", the reason, and the manual button |

The details are in `offline-pwa.md` §7a. The record form's own retry (for an online post)
stays a button: it is one click away on the screen that just reported the failure.

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

**Update (§18).** This derivation is now one SQL function for every member and every
round (`sened_draw_cycle_member_rounds`); `get_draw_cycle_collateral_v1` is built on it and
its output was unchanged by that move (the harness compared it with a verbatim copy of the old
derivation). **Update (§18.1, `20261013100000`):** a payment recorded after a win now first fills
the earliest unmet round after the win that was open *when it was recorded*, then the earliest
unmet round up to the win; the collateral view differs from the paragraph above only there. The
paragraph above is otherwise still exact, including a winner's later rounds.

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

Nothing here debits a guarantor, moves money or writes the ledger or a posting. By
itself it blocks no draw: only the optional contribution gate (§18.2), which a cycle
opts into, ever holds one (a test asserts the ledger head and entry count are unchanged by every
guarantee operation, and the contract test asserts the SQL never writes `ledger_*`).
The reserve is still a heuristic (§7), not a proven equilibrium model; the guarantee is
a social record, not collateral that can be seized. A member who pays by a route that
is never attributed will be flagged until someone records it.

### 17.7 Deploy order

Apply the migration together with the application release: `GET /api/ledger/entries`
and the `/api/sync` pull call `get_ledger_entry_attributions_v1`, so a release against a
database without the migration fails those reads.


## 18. Per-round contributions for everyone, and the contribution gate

`supabase/migrations/20261011100000_contribution_grid_and_gate.sql`, proven by the
"GRID", "COLLATERAL-GRID" and "GATE" checks in `scripts/verify-migrations.sql` (success
marker `ALL CONTRIBUTION GRID AND GATE CHECKS PASSED`, also required by
`scripts/verify-migrations.ps1`). New file only; existing cycles are `off`. §18.1's assignment rule
for a payment after a win and §18.2's "residual" (the gate was not re-checked at commit) were changed by
`20261013100000_post_win_fill_and_commit_gate.sql` (marker `ALL POST-WIN FILL AND COMMIT GATE CHECKS
PASSED`): see the rule in §18.1 and the commit-time gate in §18.5. The text of those two places below is
the current behaviour.

### 18.1 The grid: every member, every round

`get_draw_cycle_contributions_v1(cycle)` (any active member, `sened_ledger_can_access_group`;
an unknown cycle and one in another group read the same) returns a members x rounds grid.
Nothing in it is stored: it is derived on every read by `sened_draw_cycle_member_rounds`, the
§17.3 derivation generalised from "a winner's later rounds" to every (member, round).

**Who is in the grid:** the group's active members, plus anyone who won a round of the cycle
(a winner who has left still owes the cycle; they are marked inactive and the gate ignores them).

**Status of (member, round):**

| status | meaning |
|---|---|
| `met` | a qualifying contribution is assigned to the round |
| `flagged` | not met, and the round is **due** |
| `not_due` | not met, and the round is not due |

**There is no `partial`.** An amount under the cycle's contribution never qualified (§17.3), and
counting it would need a policy nobody has decided: does 150 against 100 pay one round and a half?
does 60 plus 40 pay a round? So an entry that falls short is simply not counted, the round stays
flagged until a full payment is attributed, **one qualifying entry pays one round**, and an
overpayment does not carry over. The screen says so under the grid.

**Due, for every member alike:** *round r is due once the draw for round r has been opened* (a
`draw_sessions` row, or a legacy commitment, exists for it). That is the rule the collateral view
already used for a winner's later rounds, now applied to all rounds and all members. It is not
"once round r-1 is revealed": a draw can be opened only after the previous round is revealed, so
the two coincide in time, but opening is the event the database can see, and it is the moment the
treasurer has decided the round starts.

**Qualifying contribution:** unchanged from §17.3 (not reversed; attributed to the member by bank
provenance, else the current treasurer record; at least the cycle's contribution into `POT_CASH`;
recorded on or after the cycle's start; not attributed to another cycle).

**Assignment.** An entry whose attribution names this cycle **and** round pays that round (even one
not yet due, which is then `met`): explicit attributions claim their rounds first. Every other qualifying
entry is placed **one at a time in recorded order** (`recorded_at`, then entry id), each seeing only the
explicit claims and the entries before it. One entry pays one round; there is no partial carry. Write `t`
for the entry's recorded time; a round `r` is *reachable* when `r = 1` or round `r - 1` was revealed
strictly before `t`, and *open before `t`* when its draw was opened strictly before `t`. A round that is
claimed (explicitly, or by an earlier entry) is not available.

| the entry is | it pays |
|---|---|
| a non-winner's, or a winner's recorded at or before their reveal `W` | the earliest available, reachable round that is open now (a winner's only up to and including their win round `w`). **Unchanged since 20261011.** |
| a winner's recorded **after** `W`: step 1 | the earliest available, reachable round **after `w` that was open before `t`** |
| step 2, only if step 1 found none | the earliest available round **up to and including `w`** (all of them were revealed, hence open and reachable, before `W < t`) |
| step 3, only if steps 1 and 2 found none (the prepayment) | the earliest available, reachable round after `w` that is open **now** but was not open before `t`. That is only ever the round that follows the last one revealed at `t`; the entry waits for it to open, as it always did |

So post-win obligations keep their priority (step 1: a due, unmet round after the win is paid before an
older missed one), and a payment that arrives when nothing after the win is due clears the member's
earliest missed round instead of waiting for a round that may or may not come (step 2). It used to wait:
until 20261011 a payment recorded after a win could only pay rounds after it, and a missed earlier round
needed an explicit cycle+round attribution.

**Why this does not flap.** The grid is recomputed on every read, so a rule that asked "what is open
*now*" to choose between step 1 and step 2 would let a payment move: recorded while no post-win round
was open it would clear the missed round, and the instant round `w + 1` opened it would jump there
(the missed round flagged again, a round `met` that was not). The rule instead decides on the state *at
the entry's own time*. An entry is placed by looking at (a) the explicit claims, (b) the entries before
it, which by induction on the recorded order are already fixed, and (c) reveal times and open times that
lie before `t`, which never change. Nothing recorded later is read, so once an entry has a round it keeps
it whatever is opened, revealed or recorded afterwards. The single exception is the prepayment of step 3:
it has no round until the next round opens, and then it takes exactly that one (it never moves between
rounds; a non-winner's prepayment works the same way and always did). What *can* re-sort entries is a
deliberate edit of the data: an explicit attribution claims its round and the entry that held it falls to
its next choice, and a reversed payment stops counting so later entries close up. The harness
(`FILL 1-10`) takes a snapshot of the grid after every step of a four-round timeline with three winners and
asserts that every `met` cell keeps its entry in every later snapshot, including the step where round 2
opens after a payment that cleared round 1.

**Collateral.** `get_draw_cycle_collateral_v1` is unchanged and reads the same function. Its output now
differs from the earlier derivation in exactly one situation: a winner who had an unmet round up to their
win when a post-win payment was recorded with nothing after the win open and unmet. The payment used to
wait for round `w + 1` and make it `met` when it opened; it now clears the earlier round, so `w + 1` is
flagged when it opens unless something else pays it. The harness compares every winner's `owed` with a
verbatim copy of the previous derivation and asserts the differing rounds exactly (empty before round 2
opens; round 2 for the first winner after; round 3 for the second), and that everything else is identical.

The result is `{ cycleId, groupId, totalRounds, contributionAmount, startedAt, contributionGate,
nextRound, flaggedCount, rounds: [{ round, dueAt, revealedAt }], members: [{ memberId, active,
winRound, cells: [{ round, status, entryId, source }] }], gateEvents, overrides }`;
`flaggedCount` counts flagged cells of active members. Client-side, `parseCycleContributions`
re-validates it (a met cell names its entry and source, the others name neither; there is exactly
one cell per round) and `flaggedBefore` / `previewGate` compute what the gate will see.

**`/draw`** shows it as `ContributionGrid`, right under the cycle card: a real table (caption,
column headers "Round n", row headers), the member column sticky, **scrolling sideways inside its own
region only** (the page never does), each cell saying `Met` / `Flagged` / `Not yet due` in words
with a decorative glyph, a met cell saying whether the payer is bank-verified or recorded by the
treasurer, and the winner's round and "no longer active" marked on the row. English and Amharic
(`contributions.*`). The ledger panel keeps its totals and the count of entries nobody attributed;
the old per-member "paid since the cycle began" list is gone because the grid answers it per round.

### 18.2 The gate: a flagged round and the next draw

`draw_cycles.contribution_gate` is `off` (default; every existing cycle), `warn` or `block`, chosen
in the cycle form (`create_draw_cycle_v1` gains a trailing `p_contribution_gate text default 'off'`).
`draw_cycles` is append-only, so the column is the **initial** policy; the **effective** policy is the
latest row of the append-only `draw_cycle_gate_events` (who, when, from, to, a 10..1000 character
reason), written by `set_draw_cycle_contribution_gate_v1` (owner/treasurer; the policy already in
force is a replay and records nothing). It is shown on the cycle card and changed from the grid panel.

**Enforcement point: `open_draw_v1`**, when a *new* draw session would be created for round R. The
gate input is every **active** member's `flagged` cell for a round **before R** (R itself is not
looked at: it has only just become due).

| policy | at open |
|---|---|
| `off` | nothing is computed |
| `warn` | allowed; the flagged pairs are returned (`contributionGate.flagged`), and `/draw` lists them and requires the owner/treasurer to tick a confirmation before the button works |
| `block` | refused with `draw_contribution_gate_blocked` (`P0001`, DETAIL = a JSON array of `{ memberId, round }`; HTTP 409 `contribution_gate_blocked` with `flagged`), unless `p_override_reason` (10..1000 characters, trimmed) is supplied |

An override is written in the same transaction as the session to the append-only
`draw_contribution_gate_overrides`: who, when, the reason, the round opened, the draw, and **exactly
which flagged (member, round) pairs were overridden**; members read it (`overrides` in the grid
response, and a "Policy changes and overrides" list on `/draw`). Only an owner or treasurer reaches
this code at all (the role is checked first, so a plain member, an outsider and an anonymous caller
are refused before the reason is considered); a supplied reason must be 10..1000 characters even if it
turns out not to be needed (`draw_override_reason_invalid`), and one that is not needed (`off`, `warn`,
nothing flagged) is not recorded.

**Why open and not commit.** Opening is the decision point: it is when round R becomes due (the flag
clock starts), when members start sealing, and when the treasurer commits to running the ceremony.
Refusing at commit would let the owner open the ceremony, gather every member's seal and only then
find the block; one override record per opened draw is also a cleaner audit than one per commit retry.
Replays by idempotency key and the continuation of a draw that is already sealing for the round return
the existing session and are not gated again (nothing new is opened). **Residual (closed by
20261013, §18.5):** this migration did not re-check at commit, so a flag that appeared after the open or a
policy switched to `block` while members were sealing did not stop the draw. `commit_draw_from_seals_v1`
now checks again.

**`/draw` opening a draw:** under `warn` or `block`, when something earlier is flagged, a notice
(`role="alert"` for block) says how many rounds, lists each member and their flagged rounds, and holds
the button until the confirmation (warn) or a reason of at least 10 characters (block) is given; the
button then reads "Open round R with this reason". If the grid was stale and the server refuses
anyway, the refusal is shown in words and the grid is read again.

### 18.3 Who can call what

| RPC | Caller | Identity |
|---|---|---|
| `get_draw_cycle_contributions_v1` | any active member | `sened_ledger_can_access_group` |
| `set_draw_cycle_contribution_gate_v1` | owner or treasurer | `auth.uid()` via `sened_ledger_can_manage_group` |
| `create_draw_cycle_v1`, `open_draw_v1` | owner or treasurer | as before; the new parameters are optional |
| `get_draw_cycle_collateral_v1` | any active member | unchanged |
| `commit_draw_from_seals_v1` | owner or treasurer | `auth.uid()` via `sened_ledger_can_manage_group`; the optional `p_override_reason` is considered only after that |

`create_draw_cycle_v1` and `open_draw_v1` change arity, so the old signatures are **dropped** before
the new ones are created (the same device the bank and commit migrations used; a second overload
would make the PostgREST call ambiguous). The helpers (`sened_draw_cycle_member_rounds`,
`sened_draw_cycle_gate_flags`, `sened_draw_cycle_gate`) are granted to nobody. Both audit tables
have RLS on, every privilege revoked, `select` granted back through a group-access policy, and
update, delete and truncate refused by triggers (`gate_history_immutable`). Nothing here writes the
ledger.

### 18.4 Deploy order

Apply the migration together with the application release. The new application sends
`p_contribution_gate` and `p_override_reason` and reads `/api/draw/contributions`; the previous
application calls the old arities, which no longer exist. A client that reads a cycle from a server
without the migration treats the missing `contributionGate` as `off`. `20261013100000` is deployed the
same way: the new application sends `p_override_reason` on every commit (null when none), and the previous
application calls the nine-argument commit, which that migration drops.

### 18.5 The gate at commit

`commit_draw_from_seals_v1` gains an optional trailing `p_override_reason text default null` (the nine-argument
signature is dropped first, as in §18.3, so PostgREST has one function of that name). After the role check,
the reason check, the replay by idempotency key and the existing seal checks, and before the commitment is
inserted, it takes a share lock on the cycle (serialising with policy changes), reads the *effective* policy and
the flagged (active member, round before this draw's round) pairs **now**, and decides:

| policy | at commit |
|---|---|
| `off` | nothing is computed |
| `warn` | allowed; the pairs are returned in `contributionGate.flagged` and `/draw` asks for a confirmation first |
| `block`, nothing flagged | allowed |
| `block`, every flagged pair is one the override **given when this draw was opened** named | allowed, no new reason (`carriedOver: true`, nothing recorded) |
| `block`, some flagged pair that override did not name (or the draw was opened without one) | refused with `draw_contribution_gate_blocked` (`P0001`, DETAIL = every flagged pair; 409 `contribution_gate_blocked` with `flagged`), unless `p_override_reason` (10..1000 characters, trimmed) is given: the commitment is written and the override is recorded with every pair flagged now and `stage = 'commit'` |

"Covered" is set containment, not a count: the flagged set may be the same or smaller than the recorded one,
but one new pair (a reversed payment) uncovers it even when the set is no larger (a payment recorded for one
member and another's reversed leaves the size alone and is still refused). A draw opened under `off` or `warn`
records no override, so a flag found at commit after the policy was switched to `block` always needs a
reason. A supplied reason must be 10..1000 characters even when it turns out not to be needed
(`draw_override_reason_invalid`); one that is not needed is not recorded; the role is checked first, so a plain
member, an outsider and an anonymous caller are refused before the reason is read. A replay of a commit by its
idempotency key returns the existing commitment and records nothing.

**One table, a stage column, not a sibling table.** An override at commit is the same fact as one at open
(an owner or treasurer let this draw proceed past this named set of flags, with a reason), read by the same list
and compared with the same recorded set. A sibling table would copy the table, its triggers, its read policy and
the union that answers "the override in force for this draw". So `draw_contribution_gate_overrides` gains
`stage text not null default 'open' check (stage in ('open', 'commit'))`, and the unique constraint on `draw_id`
becomes unique `(draw_id, stage)`: at most one override per draw per stage. Existing rows are `open`. The grid
response (`overrides`) gains `stage` on each entry (an older server omits it and a client reads that as `open`),
and `/draw` lists a commit override as "committed round R despite ..." beside the ones at open.

**Members are not stranded.** A refused commit writes nothing, so the seals stay stored and valid; members need
do nothing again. The treasurer can record the missing payment (the flag clears by itself) and commit with no
override, or commit with a reason. The Commit control on `/draw` reads the same grid and the draw's open override
(`previewCommitGate`) and shows, before the request, the flagged members and rounds: an alert and a reason box
when a new pair needs a reason (the button then reads "Commit the draw with this reason" and waits for 10
characters), a status with a confirmation tick under `warn`, and a quiet note that the open override still
covers the rounds when it does. If the grid was stale and the server refuses anyway, the refusal is shown in words
("the seals stay valid"), and the grid is read again. English and Amharic: `drawLive.commitGate*`,
`drawLive.error.commitGateBlocked`, `contributions.gate.commitOverrideRow`.

**Residual, stated plainly.** The gate is read when the commit is made; a payment reversed between the commit
and the reveal does not undo a commit that was allowed, and neither reveal nor payout re-reads it. The
derivation is a snapshot at the moment of the call, not a lock on the ledger, so a payment recorded in the same
instant may or may not be seen. The default stays `off`.


### 5.6 Integrity rules added by 20261014100000_draw_integrity.sql

* **The database derives the winner.** The reveal trigger recomputes the nonce
  digest, the transcript digest, the rejection-sampled index and the winner from
  the stored commitment and the opened nonces; whatever the caller typed must
  equal it or the reveal is refused. Golden vectors are shared with
  `test/draw.sql-parity.test.ts`.
* **One live draw per round.** `open_draw_v1` refuses while a committed,
  uncancelled, unrevealed draw exists for the round; the commitments table
  refuses a second live commitment; the reveals table has one row per
  (cycle, round).
* **The payout split** is the cycle's `reserve_ratio_bps` of the committed pot,
  rounded half up to the cent; payout = pot - reserve.
* **Cancel, for members who do not respond.** A cycle carries a seal window and a
  nonce-release window (default 48 hours each, 1 to 720). They are stamped on the
  session and on the commitment and cannot be shortened. Before the commit, after
  the seal deadline, an owner or treasurer may cancel with a reason; after the
  commit, only after the nonce deadline, with a nonce still missing, and only if
  the reveal has NOT been opened. Once the reveal is opened the seed is public and
  any owner or treasurer can finish the draw, so it cannot be abandoned. Every
  cancel is append-only (who, when, why, stage, the missed members) and visible to
  all members. At most two cancels a round by a treasurer; a third needs a group
  owner. A re-opened round may leave out only the recorded non-responders, and
  that is shown to everyone.
