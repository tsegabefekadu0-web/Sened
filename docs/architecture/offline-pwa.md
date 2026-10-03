# Offline-First PWA — AGENT-4 (Roadmap M6.1)

> A treasurer runs an Equb in a room with no signal. If Sened stops working when
> the network does, it does not work for the one person who needs it most.
> Offline here is not a nice-to-have; it is a correctness feature.

Branch: `feat/agent-4-offline-pwa` · 101 tests across 3 files · one new
dependency (`dexie@4.4.6`).

---

## 1. What this lane builds, and what it deliberately does not

**Builds**

| Path | What it is |
|---|---|
| `src/lib/db/**` | Dexie/IndexedDB stores: roster, spoken notes, draft ledger entries, outbox, a server-confirmed ledger mirror, sync metadata |
| `src/lib/offline/contract.ts` | The typed Wave 2 sync contract, shared by client and server |
| `src/lib/offline/chain.ts` | Pure hash-chain divergence detection — no merge, ever |
| `src/lib/offline/engine.ts` | The outbox drain and the mirror pull |
| `src/lib/offline/transport.ts` | `UnconfiguredSyncTransport` (fail-closed) and `HttpSyncTransport` (real, tested against a mocked `fetch`) |
| `src/lib/offline/backoff.ts` | Jittered exponential backoff, `Retry-After` parsing |
| `src/lib/offline/hash.ts` | Browser-side WebCrypto SHA-256 for note integrity |
| `src/lib/offline/copy.ts` | Lane-local `en`/`am` copy, pending A2 integration |
| `src/app/offline/**` | The treasurer's offline desk at `/offline` |
| `public/manifest.json`, `public/sw.js`, `public/icons/**` | Installability and the app shell |
| `next.config.mjs` | Service-worker scope, revalidation and manifest headers |

**Deliberately deferred (Wave 2, AGENTWORK §10)**

- **`/api/sync` now exists** (`src/app/api/sync/route.ts`, logic in
  `src/lib/sync/routeHandlers.ts`); §3 describes what it does. The app still
  *defaults* to `UnconfiguredSyncTransport`: wiring `HttpSyncTransport` into the
  console is a separate, deliberate step.
- **No Playwright E2E.** `@playwright/test` is not installed, and the brief
  forbids adding it this wave.
- **No SQL migration.** Nothing here needs a table; the server is A1's.

---

## 2. The data model

Six tables, in `sened-offline` v1.

| Table | Holds | Written by |
|---|---|---|
| `roster` | Members, plus `contributedEtbOnDevice` — money typed on *this* phone | The treasurer |
| `spokenNotes` | Transcript, provenance, amount, channel, `contentHash` | The treasurer |
| `drafts` | A `LedgerEntryRequest` that has **not** been hashed, numbered or committed | The treasurer |
| `outbox` | Transport bookkeeping for every queued mutation | The engine |
| `ledgerMirror` | Server-confirmed entries, cached for offline reading | The engine, from a pull |
| `syncMeta` | Pull cursor, last sync time, unresolved fork | The engine |

The load-bearing distinction: **a draft is not an entry.** `drafts` holds a
`LedgerEntryRequest` — an intent. The `id`, `sequence` and `entryHash` only ever
appear in `ledgerMirror`, written from a server response. A treasurer reading
offline can therefore trust the mirror and must not trust a draft, and the
schema makes that distinction impossible to blur.

### Why `declare` and not `!` on the Dexie table fields

`tsconfig.json` targets `ES2022`, which turns on `useDefineForClassFields`. A
non-initialised class field would then emit
`Object.defineProperty(this, "roster", { value: undefined })` in the constructor
and clobber the tables Dexie assigns. `declare` emits nothing. This is the
single most common Dexie 4 + TypeScript trap and it is why
`src/lib/db/schema.ts` looks the way it does.

### Why `sequenceNumber` exists

`ledger_entries.sequence` is `bigint`. IndexedDB cannot order decimal strings
numerically, so the mirror keeps a `number` mirror purely as a sort key.
`storeMirrorEntries` **refuses** any sequence above `Number.MAX_SAFE_INTEGER`
rather than storing a subtly wrong order, and the authoritative `sequence`
string is what every comparison uses.

---

## 3. The sync contract (implemented server half)

```ts
interface SyncTransport {
  push(authorization: string, envelopes: readonly SyncPushEnvelope[]): Promise<readonly SyncPushResult[]>;
  pull(authorization: string, query: SyncPullQuery): Promise<SyncPullResult>;
}
```

`POST /api/sync` with `{ mutations: SyncPushEnvelope[] }` →
`{ results: SyncPushResult[] }`, or `{ groupId, sinceSequence, limit }` →
`SyncPullResult`. One URL, two disjoint strict shapes, chosen by body
(pulls are metered by `/api/sync`'s write rule because the middleware cannot see
the body). Requests require a Bearer token, `application/json`, a 256 KiB body cap, and answer
`Cache-Control: no-store`.

**Push.** Each envelope is replayed, in order, through `LedgerService.append`
-> `post_ledger_entry_v1`, the same path as `POST /api/ledger/entries`, so
validation, balancing, the owner/treasurer role gate and idempotency are that
path's. Idempotency is the RPC's unique `(group, idempotency key)` row plus the
request fingerprint: a replay returns the stored entry as `REPLAYED`, a
different body under the same key is `idempotency_conflict`. The **envelope's**
`idempotencyKey` is the ledger key (the outbox derives it from the draft id and
keeps it across retries; the payload's own `idempotencyKey` is only a local
label and is overridden). The envelope's `groupId` must equal the payload's
(`envelope_mismatch` otherwise). The response always holds one result per envelope, in order; a
failure is that item's `REJECTED` + `error` (`invalid_request`, `forbidden`,
`not_found`, `idempotency_conflict`, `unprocessable_ledger_entry`,
`unsupported_mutation_kind`). Transient ledger failures (`ledger_unavailable`,
`ledger_write_failed`) are `REJECTED` **with `retryAfterMs`**, which the engine
turns into a bounded retry rather than a dead end. Only `ledger-draft` has a
server path; `spoken-note` and `roster-member` are refused, never faked.

**Pull.** Reads under the caller's JWT (RLS): the group's `ledger_group_heads`
row, then entries with `sequence > sinceSequence` and `<= head.lastSequence`
ascending (so head and slice are one snapshot), `limit` 1..500, `hasMore` from a
`limit + 1` read. Before returning, the server checks the slice for sequence
gaps, `previousHash` links, and that a slice ending at the head hashes to
`head.lastHash`; a failure is a 502, never a page to trust. A group the caller
cannot see is 404. Entries omit tenant id, request fingerprint and idempotency
key; the head carries the tenant id.

Rules the server must honour, in priority order:

1. **`push` is idempotent per `idempotencyKey`.** Replaying an accepted key
   returns `REPLAYED` with the original `serverEntryId`/`serverEntryHash` —
   never a second entry. A treasurer who reloads mid-sync must not double-post.
2. **A `LedgerEntryRequest` is judged by A1's ledger rules, not by the client's.**
   The client pre-validates with the *same* `normalizeLedgerEntryRequest`, so a
   422 means the two devices disagreed about something the rules cover.
3. **An `ACCEPTED`/`REPLAYED` result without `serverEntryId` *and*
   `serverEntryHash` is a protocol violation.** `HttpSyncTransport` throws
   `SYNC_CORRUPT_PAYLOAD` rather than reporting a success the client cannot
   re-verify later. This is a **tested** branch, not a comment.
4. **`pull` returns a contiguous, hash-linked slice** in ascending sequence.
5. **A result for an unknown `mutationId` is rejected**, not silently ignored.
6. Status mapping the client already implements: 401 → `SYNC_UNAUTHENTICATED`,
   403 → `SYNC_FORBIDDEN`, 404 → `SYNC_NOT_CONFIGURED`, 409 →
   `SYNC_IDEMPOTENCY_CONFLICT`, 422 → `SYNC_REJECTED`, 429 → `SYNC_RATE_LIMITED`
   (honouring `Retry-After`), 5xx → `SYNC_UNAVAILABLE`.

### Credentials never touch storage

`authorization` is a **parameter** of `drain()`/`pull()`, never a stored field.
A bearer token in IndexedDB is readable by any script on the origin and survives
a logout that forgot to clear it. There is a test that dumps every table after a
successful drain and asserts the token appears nowhere in it.

---

## 4. Conflict resolution: there is none, on purpose

> *"The append-only hash chain means conflict resolution has a correct answer:
> you cannot merge two divergent histories, you must detect and surface it."*

Each entry commits to `previousHash`. Change one entry and every hash after it
changes. Two histories that share a sequence number but not a hash describe
**different events**, not two views of one. There is no last-write-wins merge
that is not a lie, and no three-way merge that does not rewrite history — which
§12.2 forbids. So the client does exactly one thing: notice the fork and put a
person in front of it.

### Why nothing in the offline lane hashes anything

The server already publishes every `entryHash` and `previousHash`. Divergence is
a question about whether two *published* values agree, so **comparing them is
complete**. This matters twice over: `src/lib/ledger/canonical.ts` imports
`node:crypto` and cannot ship to a browser, and A1 owns that file (§8.5).
Re-deriving a hash client-side would mean re-implementing the single most
safety-critical function in the product in a second place. A1's
`verifyLedgerChain` still runs server-side during a Wave 2 pull, where Node is
available.

### What the client refuses to write

`storeMirrorEntries` will not write three things, and reports each instead:

| Refused | Reported as | Why |
|---|---|---|
| A different `entryHash` at a sequence already held | `conflicting` → `hash-mismatch` fork | Rewriting it would erase the only evidence a fork happened |
| The same hash under a **different** `id` | `conflicting` | The id is inside the hash; both cannot be right |
| An entry that does not descend from the held head, or leaves a sequence gap | `unlinked` → `height-mismatch` fork | The offline read model must never be a mixture of two histories |

The lookup is keyed on `(groupId, sequenceNumber)`, **not** on entry id. A
server that rewrote history would issue a fresh id for a sequence already held,
and an id-keyed lookup would happily store a second row at the same height —
precisely the corruption the fork check exists to catch.

### The four outcomes, and what a treasurer should read

| Relation | Meaning | Action |
|---|---|---|
| `identical` | Same head, same hash | Nothing |
| `server-ahead` | Device is simply behind | Fast-forward. **Not** a conflict — treating it as one would cry wolf on every ordinary sync |
| `local-ahead` | Device holds sequences the server never issued | A fork. An append-only ledger cannot un-issue an entry |
| `diverged` | Histories meet, then differ | A fork. Stop pushing |

`compareContinuation` additionally refuses to call an unverifiable **gap** "no
change": if the server reports a taller head but returns no entries, the missing
links cannot be checked, and that is reported as a divergence rather than
quiet. There is a test named *"refuses to call an unverifiable gap 'no change'"*.

### Resolution is bookkeeping, not repair

`resolveDivergence` records a person's decision and stops the console pushing on
top of an unknown head. It does **not** delete a local row, re-parent an entry,
or recompute a hash. `accept-server-as-truth` is a presentation decision: the
server's chain is the only chain, and the local fork stays on disk for a human
to reconcile. A test asserts the mirror is untouched after a resolution.

While a fork is unresolved, `drain()` returns
`skippedReason: "This group has an unresolved ledger fork…"` and sends nothing.

---

## 5. The outbox

```
local-draft → queued → in-flight → synced
                            ├─────→ retry-scheduled → (in-flight) → …
                            ├─────→ rejected        (terminal, a person fixes the draft)
                            └─────→ blocked          (terminal, a person decides)
```

**`synced` is reachable only from a server response.** `enqueue()` writes `queued`
and nothing else; `settleSynced()` requires an `outcome` of `ACCEPTED`/`REPLAYED`
*and* a `serverEntryId` *and* a `serverEntryHash`. This is structural, not a
discipline someone has to remember.

Three failure classes, treated differently because they mean different things:

| Class | Codes | Effect |
|---|---|---|
| **Not an attempt** | `SYNC_NOT_CONFIGURED` | `attempts` untouched, lease released, row returns to `queued`. Retrying against a server that does not exist must not burn a Sunday's budget |
| **Transient** | `SYNC_NETWORK`, `SYNC_TIMEOUT`, `SYNC_UNAVAILABLE`, `SYNC_RATE_LIMITED` | `retry-scheduled` with jittered backoff; `Retry-After` beats the curve. `blocked` after the budget |
| **Needs a person** | `SYNC_UNAUTHENTICATED`, `SYNC_FORBIDDEN`, `SYNC_IDEMPOTENCY_CONFLICT` | `blocked` immediately, at zero attempt cost — retrying cannot help |

**Leases, not deletes.** A drain claims rows with `leaseOwner` +
`leaseExpiresAt` inside one `readwrite` transaction. A crash mid-drain leaves
`in-flight` rows that any device reclaims once the lease expires. That is what
makes a browser crash during a Sunday meeting recoverable rather than lost work.
Requeueing a settled row requires a **written reason**, so a background timer can
never quietly re-open a human decision.

### Backoff

Window is `[ceiling/4, ceiling]`, `ceiling = base · 2^(attempt-1)`. Jitter
because the failure is shared — a room full of treasurers all coming back when
the venue's wifi returns would stay synchronised forever on a deterministic
curve. The quarter floor rather than full jitter because a full-jitter draw can
land on 0, and a client that retries instantly on every failure is a small
denial-of-service tool aimed at its own sync service. There is a test asserting
the delay is never 0.

---

## 6. i18n — the `offline.*` triples to fold into `src/lib/i18n.ts`

`src/lib/i18n.ts` belongs to AGENT-2 alone (§4.1) and a key in `en` without its
`am` twin is a compile error, so these are **filed, not added** (request R3).
`src/lib/offline/copy.ts` mirrors them and must be deleted at integration.

| key | en | am |
|---|---|---|
| `offline.title` | Offline ledger desk | የመስመር መዝገብ ጠረጴዛ |
| `offline.subtitle` | Record contributions with no connection. Nothing here is in the ledger until it syncs. | ያለ ግንኙነት ስጠታዎችን ይመዝግቡ። እስኪመልስ እስከም አንድም ነገር አልተካተለም። |
| `offline.connectivity.online` | Online | ተገናኝቷል |
| `offline.connectivity.offline` | No connection | ግንኙነት የለም |
| `offline.connectivity.unknown` | Connection unknown | የግንኙነት ሁኔታ አውቅቷል |
| `offline.storage.unavailable` | This device cannot store anything offline, so nothing can be recorded here. | ይህ መሣሪያ ከመስመር ላይ ምንም ማስቀመጥ አይችልም፤ ስለዚህ እነዚህ ላይ ምንም መመዝግብ አይቻልም። |
| `offline.storage.full` | This device is out of storage. Free space before recording more. | የይህ መሣሪያ ቦታ አልቋል። ከበለጠ መመዝግብዎ በፊት ቦታ ያስቀምሩ። |
| `offline.roster.title` | Roster on this device | በዚህ መሣሪያ ላይ ያለው የአባላት ዝርዝር |
| `offline.roster.empty` | No members are stored on this device yet. They arrive after the first sync. | በዚህ መሣሪያ ላይ እስካሁን አባላት የለም። ከመጀመሪያው ማስመሳለያ በኋላ ይደርሳሉ። |
| `offline.roster.onDeviceTotal` | Recorded on this device, not in the ledger: {amount} | በዚህ መሣሪያ ላይ የተመዘገበ፣ በመዝገቡ ውስጥ በስተቀር የለም፦ {amount} |
| `offline.roster.memberCount` | {count} members | {count} አባላት |
| `offline.notes.title` | Spoken notes | የተናገሩ ማስታወሻዎች |
| `offline.notes.empty` | No notes are stored on this device yet. | በዚህ መሣሪያ ላይ እስካሁን ማስታወሻዎች የለም። |
| `offline.notes.transcriptLabel` | What was said | ምን ተናገር |
| `offline.notes.transcriptPlaceholder` | Type or dictate the contribution as it was spoken | በቃል እንደተናገረው ስጠታውን ይጻፉ ወይም ይጨምሩ |
| `offline.notes.amountLabel` | Amount in birr | በብር የሚሆን መጠን |
| `offline.notes.channelLabel` | How it was paid | እንዴት እንደተከፈለ |
| `offline.notes.save` | Save note on this device | ማስታወሻውን በዚህ መሣሪያ ላይ አስቀምጥ |
| `offline.notes.saved` | Saved on this device. It has not been sent to the ledger. | በዚህ መሣሪያ ላይ ተስቀምጧል። ወደ መዝገቡ አልተላከም። |
| `offline.notes.delete` | Delete this note | ይህን ማስታወሻ አጥፋ |
| `offline.notes.deleteBlocked` | This note is still waiting to sync. It can only be deleted after it settles. | ይህ ማስታወሻ እየጠበቀ ነው። ከተረጋጠነ በኋላ ብቻ ልለጸመር ይችላሉ። |
| `offline.notes.source.humanTyped` | Typed by hand | በእጅ ተጻፍቷል |
| `offline.notes.source.asr` | Transcribed by speech recognition | በድምፅ ማረጋገጫ ተቀርቧል |
| `offline.notes.noHash` | Integrity hashing is unavailable on this connection, so this note is not hashed. | በዚህ ግንኙነት ላይ የታስተካከል አስተማርጠኛ ግንዙነት የለም፤ ስለዚህ ይህ ማስታወሻ አልተሰራም። |
| `offline.drafts.title` | Draft ledger entries | የማስከረዳ የመዝገብ መግቦች |
| `offline.drafts.empty` | No draft entries yet. Compose one below. | እስካሁን የማስከረዳ መግቦች የለም። ከታች አንድ ይምረጡ። |
| `offline.drafts.draftOnly` | Draft — not sent | ማስከረዳ — አልተላክም |
| `offline.drafts.amountLabel` | Amount in birr | በብር የሚሆን መጠን |
| `offline.drafts.entryTypeLabel` | Entry kind | የመዝገቡ ዓይነት |
| `offline.drafts.cashAccountLabel` | Cash account | የጥሬ ሂሳብ |
| `offline.drafts.incomeAccountLabel` | Contribution income account | የስጠታ ገቢ ሂሳብ |
| `offline.drafts.occurredAtLabel` | When it happened | የተከሳተው ጊዜ |
| `offline.drafts.save` | Save as draft | እንደማስከረዳ አስቀምጥ |
| `offline.drafts.queue` | Queue for sync | ለማስመሳለያ ወረፋ ላይ አስገባ |
| `offline.drafts.queued` | Queued — waiting to sync | በወረፋ ላይ — ማስመሳለያን እየጠበቀ ነው |
| `offline.drafts.queuedSaved` | Queued on this device. It will be sent when there is a connection. | በዚህ መሣሪያ ላይ ተሮምሯል። ግንኙነት ሲኖር ይላካል። |
| `offline.drafts.saved` | Draft saved on this device. It has not been queued. | የማስከረዳ መዝገቡ በዚህ መሣሪያ ላይ ተስቀምጧል። ወደ ወረፋ አልተላከም። |
| `offline.drafts.unbalanced` | A ledger entry must balance: the debits and credits must be equal. | የመዝገብ መግቢያ ማመጣጠኝ ካለበለድ፦ ብርሃዎችና ክሬዲቶች እኩል መሆናቸው አለበት። |
| `offline.drafts.invalidAmount` | That amount is not a valid birr value. | ያ መጠን ትክክል የብር እሴት አይደለም። |
| `offline.queue.title` | Sync queue | የማስመሳለያ ወረፋ |
| `offline.queue.empty` | Nothing is waiting to sync. | ለማስመሳለያ የሚጠብቅ ምንም የለም። |
| `offline.queue.oldest` | Oldest waiting since {date} | ከመጀመሪያው ጀምሮ {date} ጀምሮ የሚጠብቅ |
| `offline.queue.synced` | Synced | ተመሳልቷል |
| `offline.queue.syncedBody` | The server accepted this and returned entry {entry}. | አገልጋይው ይህን ተቀብሏል ከመዝገብ {entry} ጋር መልሷል። |
| `offline.queue.pending` | Waiting to sync | ለማስመሳለያ ይጠብቃል |
| `offline.queue.retrying` | Will retry | እንደገና ይሞክራል |
| `offline.queue.rejected` | Rejected by the server | በአገልጋዩ ውድቅ ተደርጓል |
| `offline.queue.blocked` | Needs a person | ሰው ያስፈልጋል |
| `offline.sync.title` | Sync | ማስመሳለያ |
| `offline.sync.notConfigured` | The sync service is not configured yet, so queued work stays on this device. | የማስመሳለያ አገልገሎቱ ገና አልቋቀረም፤ በወረፋ ላይ ያለው ሥራ በዚህ መሣሪያ ላይ ይቀራል። |
| `offline.sync.pull` | Pull from server | ከአገልጋይ ገባ |
| `offline.sync.push` | Send queued work | የወረፋ ላይ ያለውን ሥራ ላክ |
| `offline.sync.needsToken` | Sign in before syncing. No credential is stored on this device. | ከመማስመሳለያ በፊት ይግቡ። በዚህ መሣሪያ ላይ ምንም ምልክት አይቀምጠም። |
| `offline.sync.drained` | Sent {sent} of {total}. | ከ{total} ውስጥ {sent} ተልኳል። |
| `offline.sync.nothingQueued` | There was nothing queued to send. | ለማስተላከት ምንም በወረፋ ላይ አልነበረም። |
| `offline.sync.ahead` | This device is {count} entries behind the server. Nothing conflicts. | ይህ መሣሪያ ከአገልጋዩ {count} መግቦች ወደኋላ ነው። ምንም ግጭት የለም። |
| `offline.sync.identical` | This device and the server agree on the whole chain. | ይህ መሣሪያና አገልጋዩ ስለ ሙሉ የመስክ ተስማምተዋል። |
| `offline.mirror.empty` | This device has no confirmed entries yet. A chain head appears after the first successful pull. | ይህ መሣሪያ ገና የምንም የተረጋገጠ መግቢያ የለም። ከመጀመሪያው የተሳካ ገባ በኋላ የተከታታይ ርዕስ ይታያል። |
| `offline.mirror.entries` | Confirmed entries on this device: {count} | በዚህ መሣሪያ ላይ የተረጋገጡ መግቦች፦ {count} |
| `offline.integrity.sequenceValue` | Sequence {sequence} | ተከታታይ {sequence} |
| `offline.divergence.title` | Ledger histories have split | የመዝገብ ታሪኮች ተዋግደዋል |
| `offline.divergence.explain` | Two devices recorded different entries for the same position in the chain. Sened cannot merge them, because an append-only chain has no merge. Nothing was deleted or rewritten — a person has to decide what the group actually agreed. | ሁለት መሣሪያዎች በተከታታይ መስፍ ላይ የተያያዙ ልዩ መግቦች አስቀምጠዋል። Sened አንድም ያለ አይዋልቃል፤ ምክንያቱም በአካል የሚጨምር የመስክ ያለው መፃሙ የለም። ምንም አልተጠፋረቀም ወይም አልተቀየረም — ቡዙኑ ምን ስምምተቋቸው ይሆን አስፈልጋል። |
| `offline.divergence.localBroken` | The copy on this device is damaged. It has not been repaired or deleted. | በዚህ መሣሪያ ላይ ያለው ቅጂ ተጎዳል። አልተጠረገረም ወይም አልተጠፋረቀም። |
| `offline.divergence.forkAt` | They agree through sequence {prefix}, then differ at sequence {fork}. | እስከ ተከታታይ {prefix} ድረስ ተስማምተዋል፤ ከዚያ በተከታታይ {fork} ላይ ይለያሉ። |
| `offline.divergence.acceptServer` | Treat the server's chain as the record | የአገልጋዩን ተከታታይ እንደ መዝገብ ተቀበል |
| `offline.divergence.escalate` | Keep both and escalate to the group | ሁለቱንም ያስቀምጥና ወደ ቡዙኑ አላስተላለፍ |
| `offline.divergence.resolved` | A person recorded a decision on {date}. | በ{date} ሰው ውሳኔ አስቀምጧል። |
| `offline.a11y.state` | Sync state | የማስመሳለያ ሁኔታ |
| `offline.a11y.hashUnavailable` | Integrity hash unavailable | የታስተካከል አስተማርጠኛ ግንዙነት የለም |

> Note for A2: none of these need plural forms in the repo's current
> `translate()` shape. `offline.roster.memberCount` and `offline.mirror.entries`
> read acceptably at any count as written, but if A2 introduces `.one`/`.many`
> keys, those two are the ones to convert.

---

## 7. Service worker and manifest

`public/sw.js` is plain, build-free JavaScript served verbatim, on purpose: a
worker whose job is to replace itself on a new deploy should not need a build
step to do that.

It does three things and refuses several others:

- **Precaches the offline desk shell** with `cache.addAll`, which is atomic —
  one 404 and nothing is cached, so a half-working offline shell is never
  presented as a working one.
- **Serves navigations from cache** when the network is gone.
- **Forwards `sened:drain-outbox` messages to the page.** The worker only
  relays. The queue, the backoff and the idempotency keys live in the page's
  IndexedDB, so the worker never holds a credential or a ledger payload.

Refusals, each with a reason:

| Refused | Why |
|---|---|
| Any non-`GET` under `/api/` | A cached `POST` result is a fabricated success. The outbox owns retries because it can reason about idempotency keys; a worker cannot |
| `/api/` entirely | Same |
| Cross-origin requests | Not ours |
| HMR and `__nextjs` paths | Dev-only |

`next.config.mjs` sets `Service-Worker-Allowed: /` and
`Cache-Control: no-cache, no-store, must-revalidate` on `/sw.js`. `no-cache`
does not mean "do not store" — it means "revalidate every time", which is the
only correct policy for a worker that must replace itself. The manifest and
icons get a long immutable `max-age`; `/offline` gets `private, no-store`,
because it renders per-device queue state.

**Icons** are generated PNGs (`icon-192`, `icon-512`, `icon-maskable-512`,
`apple-touch-icon`) — a coin stack on a coffee field with a tibeb diamond
lattice. The maskable variant keeps its mark inside the 80% safe circle.

> `src/app/layout.tsx` is A1's. **Installability is not complete until A1 adds
> `<link rel="manifest" href="/manifest.json" />` and the `apple-touch-icon`
> link** (request R2). The manifest is not discoverable until the document links
> it.

---

## 8. The console at `/offline`

Route-agnostic, per §11: it is my own mount point, not `page.tsx`.

Priority-ordered design rules the component follows:

1. **Nothing pending is drawn like something committed.** Every row reads its
   state from the outbox row — the only thing that can reach `synced`. One state
   vocabulary across drafts and the queue, so a pending row cannot be
   mislabelled by whichever panel renders it.
2. **Empty is a real state and says what is missing.** "No notes on this device
   yet" is honest; an empty table with no explanation is not.
3. **Fail closed everywhere, each with its own message:** storage unavailable,
   no WebCrypto, no sync service, unresolved fork, quota exceeded.
4. **Both languages**, always.

Accessibility: state is carried by a border *and* a background *and* an animated
dot, not by hue alone; the pending pulse is slow and disabled under
`prefers-reduced-motion`; hashes are monospaced and never truncated without the
full value present; the fork banner is a `role`-labelled region with a
`data-testid`.

One honest limitation: the note form is a **textarea**. A2's real `AnalyserNode`
capture is not wired in, so the console types or dictates into a field and
records `transcriptSource: "human-typed"`. The `asr` value exists but nothing
sets it, so no note can claim speech recognition that did not happen.

---

## 9. Tests — 101 across 3 files

`fake-indexeddb@6.0.0` was already a devDependency and `test/setup.ts` already
imported `fake-indexeddb/auto` with **zero** tests using it. It is now genuinely
exercised. `test/setup.ts` gained one additive change: Node's `webcrypto` is
installed when `crypto.subtle` is missing, because jsdom does not implement
`SubtleCrypto`. This only *adds* capability, and a test that needs the
`CRYPTO_UNAVAILABLE` path deletes the global itself.

| File | Tests | Covers |
|---|---|---|
| `test/db.stores.test.ts` | 38 | Schema, close/reopen survival, roster validation, bigint ETB totals, note hashing and the no-hash path, draft validation **through A1's real rules**, idempotency-key stability, outbox leases, mirror append-only refusals |
| `test/offline.sync.test.ts` | 42 | Drain states, `Retry-After`, attempt budget, the unconfigured-vs-transient-vs-credential split, idempotency across retries, token never stored, five distinct fork shapes, backoff, the full `HttpSyncTransport` status map |
| `test/offline.console.test.tsx` | 20 | i18n parity, honest empty states, offline indicator, record-and-survive-reload, protected deletes, no fake success, fork banner and human resolution, on-device money labelling |

Negative and security cases, explicitly: unbalanced drafts, invalid amounts,
non-UUID groups, corrections without rationale, out-of-order and unlinked mirror
entries, out-of-range sequences, an acceptance with no hash, a result for an
unknown mutation, a wrong-group page, a timeout, a non-JSON 200, requeue without
a reason, requeue of an in-flight row, and the token-not-in-storage dump.

Baseline is untouched: **75 tests / 12 files, all still passing.** The full tree
reads 457 passed / 22 files, which includes A1's and A2's concurrent work.

---

## 10. Bugs the tests caught during the build

Recorded because they are the argument for testing rather than a list of
mistakes:

1. **The engine memo read a ref during first render.** `dbRef.current` is always
   `null` there, so the memoised engine was permanently `null` and **the console
   could never push anything**. Found only by a component test; a unit test on
   the engine alone would have passed.
2. **`annotateUnattempted` left the row `in-flight`.** An unconfigured server
   would have stranded the treasurer's own work looking like another device held
   it.
3. **`run()` overwrote its own status message with `null`** — the action set the
   status and then returned `null`, which `run` wrote back.
4. **The mirror accepted an entry that did not link onto its head**, producing a
   local read model that was a mixture of two histories. Found by the
   "does not link" divergence test landing as `local-chain-broken` instead of
   `height-mismatch`.
5. **The mirror looked up by entry id, not by sequence** — a rewriting server
   would have been stored as a second row at the same height.
6. **A first sync reported `server-ahead` after catching up**, which reads as
   "you are still behind" once you are not.

---

## 11. What I need from other agents

| Request | Target | Blocking? |
|---|---|---|
| R1 — add `/api/sync` to `RATE_LIMITED` in `src/middleware.ts` | A1 | Done  |
| R2 — add `<link rel="manifest">` + `apple-touch-icon` to `src/app/layout.tsx` | A1 | **Yes** — installability |
| R3 — fold the 70 `offline.*` triples in §6 into `src/lib/i18n.ts`, then delete `src/lib/offline/copy.ts` | A2 | No |
| R4/R5 — no change requested; `canonical.ts` signatures and the ledger route are dependencies I only read | A1 | No |

---

## 12. Known limitations, stated rather than hidden

- **The server exists but is not wired in by default.** The engine's default
  transport is still `UnconfiguredSyncTransport`, so a drain fails closed with
  `SYNC_NOT_CONFIGURED` until `HttpSyncTransport` is injected.
- **The console uses fixture group and account UUIDs.** A1 supplies real ones at
  integration; they are module constants for that reason.
- **No audio blobs are persisted.** A 25 MB base64 string in IndexedDB is how a
  treasurer loses a Sunday's work to a quota error, so the row keeps mime type,
  byte length and duration, and the caller owns blob storage.
- **No plural forms.** The repo's `translate()` has none; §6 notes which keys
  would need them.
- **Service worker registration is not in `layout.tsx`** (A1's file) — §7.
- **Round trips are a single batch of 25.** A 200-member Sunday with no signal
  produces a 200-row queue that drains over several passes. Correct, but the
  treasurer should see the queue depth, which the console does.
