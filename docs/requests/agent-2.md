# AGENT-2 — Request Log

> Target owners: A1 (ledger/banking/shared), A3 (draw), A4 (offline/build).
> One row per request. No bundling. I never edit another agent's file.
>
> Status vocabulary: `OPEN` · `ANSWERED` · `WITHDRAWN` · `CLOSED (resolution)`.

---

## R-1 — rate-limit bucket for `/api/voice/*` (owner: **A1**)

| Field | Value |
|---|---|
| Target | A1, `src/middleware.ts` |
| Status | **CLOSED (done: `/api/voice/transcribe` and `/api/voice/speak` are in `RATE_LIMITED` in `src/middleware.ts`, commit 2257934)** |
| Blocks my lane? | **No.** I ship without it and document the exposure. |

**What I need.** `src/middleware.ts:4-8` — add:

```ts
"/api/voice/transcribe",
"/api/voice/speak"
```

to the `RATE_LIMITED` set.

**Why.** `resolveRateLimit` already returns `WRITE_RULE` for `…/sync` and
`PROXY_RULE` for everything unrecognised, so no new rule is required — but the
`matcher: "/api/:path*"` only *enforces* limits for paths in that set. As
written, `/api/voice/transcribe` is an **unauthenticated-by-rate-limit** POST
that shells out to a third-party speech provider. One rule, same as
`/api/bank-verifications`.

**Current mitigation on my side.** `MAX_BODY_BYTES` is enforced in the handler
(8 KiB), the request schema is `.strict()` and length-bounded, and a
`Cache-Control: no-store` header is always set. I do not want to lean on that
as a substitute for a real limiter.

---

## R-2 — `voice → /api/bank-verifications` wiring (owner: **A1**, cross-lane task **#14**)

| Field | Value |
|---|---|
| Target | A1, integration step |
| Status | **CLOSED (wired: `src/app/page.tsx` passes `requestBankVerification` from `src/lib/voice/clientVerify.ts` as `onRequestVerification` when signed in, commit 2d8f5c8; signed out, voice notes are saved on the device via `onRecordLocally` instead, and the submit button is no longer permanently disabled)** |
| Blocks my lane? | **No.** By design — `AGENTWORK.md` §8.2 assigns this to you. |

**What I hand you.** `src/lib/voice/intent.ts` exports:

- `type ProvisionalContribution` — the zero-trust payload, explicitly
  `PROVISIONAL`.
- `toBankVerificationIntent(input)` → the exact payload accepted by
  `bankVerificationRequestSchema` in `src/lib/banking/schemas.ts:147`.

**What I need from you.** The POST in `src/app/voice/page.tsx`. I deliberately
render that button as **disabled with the reason shown on screen**
("pending bank verification wiring — see `docs/architecture/voice.md`") rather
than ship a dead fetch or, worse, a local success that fabricates a verified
balance.

**Note on the request shape.** `bankVerificationRequestSchema` requires
`bankAccountBindingId` and `occurredAt`, neither of which speech can produce.
I fill `occurredAt` from the utterance's own capture time (ISO 8601, the one
honest source) and leave `bankAccountBindingId` to the treasurer's selection,
which is A1's surface.

---

## R-3 — link `/voice` from the mobile shell (owner: **A1**)

| Field | Value |
|---|---|
| Target | A1, `src/app/page.tsx` |
| Status | **CLOSED (done: `src/components/shell/WorkspaceLinks.tsx`, rendered on the home screen, links `/voice`, `/draw` and more, commit 2257934)** |
| Blocks my lane? | **No.** I have my own route. |

**What I need.** A link/nav entry to `/voice` during integration. The M1 shell
(`page.tsx`) owns the mic dock, and I must not edit it.

**Why it matters.** `/voice` is where the real pipeline is provable: live
`AnalyserNode` waveform, real `MediaRecorder`, the parser output next to the
transcript, and a TTS digest with a genuine speed control. A judge who only
ever opens `/` will still see the old fabricated `Verified 0.4s` badge
(`ContributionFeed.tsx:76-77`, your §10 M1-polish item) and could reasonably
conclude the voice engine is also fake.

---

## R-5 — `page.tsx` turns a voice note into a "verified" badge (owner: **A1**, §12.3)

| Field | Value |
|---|---|
| Target | A1, `src/app/page.tsx:39-57` and `src/components/contributions/ContributionFeed.tsx` |
| Status | **CLOSED (removed: `handleAddContribution` / `onAddContribution` no longer exist in `src/app/page.tsx`; `ContributionFeed.tsx` only shows a verified badge for a row with `status: "VERIFIED"` and `verifiedBy`, and the hard-coded `verifiedBy` string is gone; commit 2257934)** |
| Blocks my lane? | **No.** I cannot edit either file. |

**What the code does today.** `handleAddContribution` maps the channel a
*voice note* claimed onto a verification flag:

```ts
telebirrVerified: newEntry.channel === "Telebirr",
cbeVerified: newEntry.channel === "CBE Birr",
```

and `ContributionFeed.tsx:76-77` already hard-codes
`verifiedBy: "Links.et Core Trust Engine"`.

**Why it is a blocker for M3.** My brief says the fakes in
`VoiceModal.tsx` and `AudioDigestModal.tsx` must go. I removed mine. But the
consumer of the callback still asserts that a *spoken sentence* settled a bank
transaction, and adds it to `potBalance` (`setPotBalance((prev) => prev +
newEntry.amount)`). Under my rewrite the modal no longer calls that callback
from speech at all — the submit control is disabled until an
`onRequestVerification` handler exists — so the path is currently dead. It
needs a decision, not a workaround:

- **Recommended:** delete `handleAddContribution` and the
  `onAddContribution` prop, and add a `provisional` state to the contribution
  type that the feed renders with the same honest treatment
  `m2-dashboard.tsx:562` gives "Not configured". Then a voice note shows as a
  draft awaiting bank verification, which is the truth.
- **Alternative:** keep the prop, have it fire only from a real
  `VERIFIED` response from `/api/bank-verifications`, and remove the hard-coded
  `verifiedBy` string.

**What I did instead of editing it.** I kept the prop signature byte-compatible
so your file keeps compiling, and typed it so a voice transcript *cannot* be
the thing that calls it — the call site is guarded by
`outcome.verified === true` from a caller-supplied verifier. That is a safety
rail, not a fix.

---

## R-4 — no dependency needed, but flagging the audio format (owner: **A4**)

| Field | Value |
|---|---|
| Target | A4 |
| Status | **ANSWERED (the Dexie `spokenNotes` row has a per-row `audioMimeType`, not a constant: `src/lib/db/notes.ts`, `src/lib/db/types.ts`, commit 93b96f6. Note that the voice flow in `src/app/page.tsx` currently saves the transcript only and passes no audio, so no mime type is actually stored yet)** — informational |
| Blocks my lane? | **No.** |

`MediaRecorder` negotiates `audio/webm;codecs=opus` in Chromium and
`audio/mp4` in Safari. My `src/lib/voice/recorder.ts` probes
`isTypeSupported` in that order and records the *actual* negotiated
`mimeType` on the recording. If your Dexie "spoken notes" store (§2, AGENT-4)
records a fixed `audio/webm` MIME string, Safari users will be unable to play
back their own notes. Please store the observed `mimeType` per row rather than
a constant.

I am not asking for an `npm install`. I need **zero** new dependencies:
`getUserMedia`, `MediaRecorder`, `AudioContext`, `AnalyserNode`,
`SpeechSynthesis` and `AbortSignal` are all native.
