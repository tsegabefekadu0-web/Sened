# AGENT-2 — Claim: Zero-Trust Voice Pipeline (M3)

| Field | Value |
|---|---|
| Agent | **AGENT-2** |
| Lane | Zero-Trust Voice Pipeline — Roadmap **M3** (`ROADMAP.md` §3.1, §3.2) |
| Branch | `feat/agent-2-voice` |
| Branched from | `main` @ `ca3a512` (baseline `d2eac5b` + coord-ignore commit) |
| Start time | 2026-09-26 |
| Status | **DONE (`107e9f3`)** — 184 tests, baseline 75/75 unchanged |

## §3 rows I am taking (exhaustive)

| Path | Nature |
|---|---|
| `src/lib/voice/**` | ➕ new — parser, Web Audio, STT/TTS provider interface |
| `src/app/api/voice/**` | ➕ new — transcription + speech routes |
| `src/app/voice/**` | ➕ new — my own route, for browser proof |
| `src/components/voice/VoiceModal.tsx` | 🔒 existing — rewrite to use the real pipeline |
| `src/components/voice/AudioDigestModal.tsx` | 🔒 existing — rewrite to use the real pipeline |
| `src/components/voice/voice.css` | ➕ new — my keyframes (NOT `globals.css`, §4.2) |
| `test/voice.*.test.ts` | ➕ new |
| `src/lib/i18n.ts` | 🔒 **single-writer** (§4.1) — only A2 may edit |
| `docs/architecture/voice.md` | ➕ new |
| `docs/claims/agent-2.md`, `docs/requests/agent-2.md` | ➕ new (per-agent, no shared writes) |

New i18n keys are confined to my prefixes: **`voice.*`** and **`audio.*`**.

## Lane check (§5 step 3)

`docs/claims/` did not exist before I created it. I read
`docs/AGENT_BRIEFINGS.md` in full: A1 = ledger/banking, A3 = draw,
A4 = offline PWA. No other agent claims any path in my rows. **Lane is free.**
No conflict to report to the human.

## Plan (4 work items, matching the cross-lane task board)

| # | Task | Board # | Status |
|---|---|---|---|
| 1 | Amharic/Afaan Oromoo entity-extraction parser + benchmark tests | 6 | ✅ DONE |
| 2 | Web Audio recorder + live `AnalyserNode` waveform | 7 | ✅ DONE |
| 3 | Real STT/TTS behind a fail-closed interface | 8 | ✅ DONE |
| 4 | Voice route at `/voice` + modals rebuilt on the real pipeline | — | ✅ DONE |

## What shipped

**`src/lib/voice/`** — 13 new modules.

| Module | Role |
|---|---|
| `types.ts` | `ProvisionalContribution` with `status: "PROVISIONAL"` / `verified: false` as **literal types**; 11 issue codes; blocking set |
| `normalize.ts` | Ethiopic + Arabic-Indic digit folding, punctuation, `tokenVariants()` for Amharic's glued prepositions |
| `numerals.ts` | Amharic + Oromo numerals, lookahead composer, digit-group tokens |
| `months.ts` | all 13 Ethiopian months in Amharic, Gecal Oromo and romanized forms |
| `lexicon.ts` | providers (imported from A1's `BANK_PROVIDERS`), currencies, verbs, reference labels |
| `parser.ts` | `parseContributionUtterance()` — pure, credential-free |
| `intent.ts` | `toBankVerificationIntent()` → A1's exact request body, or typed rejections |
| `waveform.ts` | AnalyserNode arithmetic, capture-quality gate |
| `recorder.ts` | real `getUserMedia` → `MediaStream` → `AnalyserNode` + `MediaRecorder` |
| `recognition.ts` | `SpeechRecognition` wrapper, abortable |
| `synthesis.ts` | `speechSynthesis` playback with real boundary-driven progress |
| `stt.ts` / `tts.ts` | real HTTP clients + the fail-closed defaults |
| `errors.ts`, `schemas.ts`, `routeHandlers.ts`, `index.ts` | plumbing |

**`src/app/api/voice/`** — `transcribe` (auth, 503 fail-closed), `speak` (auth,
503 fail-closed), `extract` (pure, unauthenticated, no credential),
`capabilities` (honest empty state).

**`src/app/voice/`** — `page.tsx` + `voice-workbench.css`. Four panels: live
extraction with sample inputs, real microphone capture, provider truth, and the
hand-off body.

**`src/components/voice/`** — `VoiceModal.tsx` and `AudioDigestModal.tsx`
rewritten onto the real pipeline; `voice.css` added; `VoiceWorkbench.tsx`
added. Prop signatures of both modals preserved so A1's `page.tsx` compiles.

**`src/lib/i18n.ts`** — 92 new keys, `en` + `am` parity asserted by
`test/i18n.test.ts`.

**`test/voice.*.test.ts`** — 5 files, 184 tests.

## Verification

| Gate | Result |
|---|---|
| `npm run lint` | clean (1 pre-existing `layout.tsx` font warning, A1's file) |
| `npm run typecheck` | **no errors in any A2 path.** Remaining errors are in `src/lib/draw/**` (A3) and `src/lib/db/**`, `src/lib/offline/**` (A4) — in-flight work in the shared tree, not mine. I did not edit them. |
| `npm test` | 456 tests, 453 pass. The 3 failures are `test/offline.console.test.tsx` — **A4's** file. |
| baseline 12 files / 75 tests | **75/75 pass**, re-run in isolation |
| `git diff --name-only main` | only §3 rows — see below |

### Files I touched (the complete list)

```
docs/architecture/voice.md                              new
docs/claims/agent-2.md                                  new
docs/requests/agent-2.md                                new
src/app/api/voice/capabilities/route.ts                 new
src/app/api/voice/extract/route.ts                      new
src/app/api/voice/speak/route.ts                        new
src/app/api/voice/transcribe/route.ts                   new
src/app/voice/page.tsx                                  new
src/app/voice/voice-workbench.css                       new
src/components/voice/AudioDigestModal.tsx               rewritten
src/components/voice/VoiceModal.tsx                     rewritten
src/components/voice/VoiceWorkbench.tsx                 new
src/components/voice/voice.css                          new
src/lib/i18n.ts                                          +92 keys, en + am
src/lib/voice/*                                          17 new files
test/voice.api.route.test.ts                            new
test/voice.audio.test.ts                                new
test/voice.intent.test.ts                               new
test/voice.numerals.test.ts                             new
test/voice.parser.test.ts                               new
```

Zero edits to `src/app/page.tsx`, `package.json`, `globals.css`,
`tailwind.config.js`, `next.config.mjs`, `src/middleware.ts`,
`src/lib/validation.ts`, `roles.ts`, `rateLimit.ts`, `supabaseServer.ts`,
`src/lib/banking/**`, `src/lib/ledger/**`, `src/lib/db/**`,
`src/lib/offline/**`, `src/components/cultural/**`, `test/setup.ts`,
`vitest.config.ts`, `README.md`, `ROADMAP.md`, `docs/IDEATION.md`,
`AGENTWORK.md`, or any committed SQL migration.

## Requests filed

Five, in `docs/requests/agent-2.md`:

| # | Owner | Summary | Blocks me? |
|---|---|---|---|
| R-1 | A1 | add `/api/voice/*` to the `RATE_LIMITED` set | no |
| R-2 | A1 | the voice → `/api/bank-verifications` POST (task #14) | no, by design |
| R-3 | A1 | link `/voice` from the mobile shell at integration | no |
| R-4 | A4 | store the *observed* audio `mimeType`, not a constant | no |
| R-5 | A1 | `page.tsx:39-57` fabricates `telebirrVerified` from voice input | no, but it is a §12.3 violation |

## What I deliberately did not do

- **No `setTimeout` stand-in for STT.** With no Voxide credential,
  `createSpeechToTextProvider()` returns
  `UnconfiguredSpeechToTextProvider`, which throws
  `PROVIDER_NOT_CONFIGURED`. A test asserts the 503 body contains no
  `"transcript"` key.
- **No new dependency.** `getUserMedia`, `MediaRecorder`, `AudioContext`,
  `AnalyserNode`, `speechSynthesis`, `SpeechRecognition` and `AbortSignal` are
  all native. `npm install` was never run — that is A4's alone (§4.3).
- **Did not implement task #14.** A2 produces the body and the refusals; A1
  does the POST.
- **Did not touch `src/app/page.tsx`'s fabricated verification badge.** That is
  A1's file; filed as R-5.

## Progress log

- **2026-09-26 — CLAIMED.** Read `AGENTWORK.md` (530 lines) and
  `docs/AGENT_BRIEFINGS.md`. Branched from `main`. Lane verified free.
- **2026-09-26 — baseline verified green before I touched anything:**
  `npm test` 75 passed / 12 files, `npm run typecheck` clean, `npm run lint`
  clean.
- **2026-09-26 — parser written, 38 benchmark tests, 11 real bugs found and
  fixed by them**: Amharic's glued prepositions hid `ቴሌብር`/`መስከረም`; the
  composer scaled a finished `tens+unit` pair (`tokkoma dugum` → 70,070); a
  transaction reference made an Amharic sentence look bilingual; a malformed
  `12,34` was split into two plausible amounts; `፯` had been silently mangled
  while authoring, so U+1360 was missing from the digit fold.
- **2026-09-26 — 3 more bugs found by the audio tests:** `frameToBars` returned
  a *shorter* array for an empty frame (the renderer indexes by bar position);
  the STT/TTS response reader walked one path instead of trying candidate
  field names, so a working provider 502'd; `retryAfterHeader` dropped the
  header entirely when the provider gave no delay.
- **2026-09-26 — 1 more found by the intent test:** A1's
  `providerReference.min(1)` means a reference-less draft cannot be submitted.
  `NO_TX_REF` is now a rejection while staying a warning on the draft.
- **2026-09-26 — DONE.** 184 tests green, baseline 75/75 intact, lint clean,
  no type errors in A2's paths. `docs/architecture/voice.md` written.

## Explicitly NOT my lane

- **Task #14 (voice → bank-verification intent wiring).** Deferred to A1 at
  integration. I build against the documented request shape in
  `src/lib/banking/schemas.ts` and export a typed, ready-to-POST
  `toBankVerificationIntent()` helper, but I do not call it.
- Any edit to `src/app/page.tsx`, `package.json`, `globals.css`,
  `tailwind.config.js`, `src/middleware.ts`, `src/lib/validation.ts`,
  `src/lib/roles.ts`, `src/lib/rateLimit.ts`, `src/lib/supabaseServer.ts`,
  `src/lib/banking/**`, `src/lib/ledger/**`, `src/lib/db/**`,
  `src/lib/offline/**`, `src/components/cultural/**`, `test/setup.ts`,
  `vitest.config.ts`, `README.md`, `ROADMAP.md`, `docs/IDEATION.md`,
  `AGENTWORK.md`. Requests filed in `docs/requests/agent-2.md` instead.

## Progress log

- **2026-09-26 — CLAIMED.** Read `AGENTWORK.md` (530 lines) and
  `docs/AGENT_BRIEFINGS.md`. Branched from `main`. Lane verified free.
- **2026-09-26 — baseline verified green before I touched anything:**
  `npm test` 75 passed / 12 files, `npm run typecheck` clean, `npm run lint`
  clean (1 pre-existing App Router font warning).
