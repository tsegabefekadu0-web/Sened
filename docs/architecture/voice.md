# A2 — Zero-Trust Voice Pipeline (M3)

Design notes for `src/lib/voice/**`, `src/app/api/voice/**`,
`src/app/voice/**` and `src/components/voice/**`.

> **One-sentence thesis:** speech is a *proposal*, never a *receipt*. This
> lane can prove a sentence was understood; it can never prove money moved.

---

## 1. What replaced what

| Before (Gen A) | After (A2) | Why the old one was a lie |
|---|---|---|
| `VoiceModal.tsx:32-41` — two `setTimeout`s revealing a hard-coded Amharic transcript | real `getUserMedia` → `MediaRecorder` → `AnalyserNode` pipeline in `src/lib/voice/recorder.ts` | a timer invents a sentence the treasurer never spoke |
| `VoiceModal.tsx:100-116` — CSS `animate-ping` divs as a "waveform" | 32 bars sized inline from real `AnalyserNode` frames at ~30 fps (`voice.css` §waveform) | a ping animation is a heartbeat, not audio |
| `VoiceModal.tsx:59-65` — a **literal object inside a callback** as "extraction" | `parseContributionUtterance()` in `src/lib/voice/parser.ts` | the amount was typed by a developer, not read from speech |
| `VoiceModal.tsx:180` — "ክፍያው በባንክ ተረጋግጦ ደብተር ላይ ሰፍሯል" (added to the ledger!) | that string does not exist. Signed in, the submit control posts to `/api/bank-verifications` and shows the real outcome (verified / pending / no account / error); signed out it saves a provisional note on the device instead | §12.3: no fabricated trust signals |
| `AudioDigestModal.tsx:89-98` — bar heights from `Math.sin((progress + i * 10) * 0.1)` | bars lit by real `speechSynthesis` `boundary` events | a sine wave is a screensaver |
| `AudioDigestModal.tsx:27-40` — `setInterval` assuming a 12 s duration at 1× | progress = boundary count ÷ sentence count | Amharic at 0.75× on a cheap phone is not 12 seconds |
| No speed control | `TTS_SPEEDS` selector driving `utterance.rate` | ROADMAP §3.2 requires play, pause **and** speed |

---

## 2. Two halves, deliberately unequal

```
CREDENTIAL-FREE, PROVABLE NOW          CREDENTIAL-GATED, FAILS CLOSED
─────────────────────────────────       ──────────────────────────────────
normalize.ts   Ge'ez digits, punct      stt.ts   VoxideSpeechToTextProvider
numerals.ts    Amharic + Oromo numbers  tts.ts   VoxideTextToSpeechProvider
months.ts      13 Ethiopian months      routeHandlers.ts
lexicon.ts     providers, verbs, refs   api/voice/{transcribe,speak}
parser.ts      the extraction           api/voice/capabilities
waveform.ts    AnalyserNode arithmetic
intent.ts      the hand-off to A1
```

The left column is why M3 is worth anything at all: **no network,
no credential, no `AudioContext`** (the voice suite is 212 tests, §9). The right column is inert until someone
sets `VOXIDE_API_URL` / `VOXIDE_API_KEY`, and until then every call raises
`PROVIDER_NOT_CONFIGURED`.

`GET /api/voice/capabilities` exists so the UI can say *not configured* before
the treasurer records anything, instead of failing four minutes into a Sunday
meeting.

---

## 3. The parser

### 3.1 The reference utterance

`ROADMAP.md` §3.1 asks for:

> `ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው`
> → `{ month, amount, channel, tx_ref }`

Delivered as:

```ts
parseContributionUtterance(text) → {
  status: "PROVISIONAL",        // literal type, cannot be widened
  verified: false,              // literal type, no code path sets true
  month: "meskerem", monthLabel: "Meskerem",
  amount: 5000, amountWire: "5000.00",   // A1's formatEtbAmount
  currency: "ETB", currencySource: "explicit",
  rail: "bank", provider: "telebirr",
  txRef: "9BF42", txRefSource: "labelled",
  issues: [], blocking: false
}
```

### 3.2 Numerals: the prefix/suffix ambiguity, resolved conservatively

Both languages put the unit *before* the tens for round tens and *after* it
otherwise:

| Form | Amharic | Oromo | Value |
|---|---|---|---|
| prefix | `አምስት አስራ` | `shan digdama` | 50 |
| suffix | `ሃያ አንድ` | `digdama kanaa` | 21 |

`አምስት አስራ` (five-ten) and a mis-phrased 51 are the same string. The
composer resolves the prefix form to the **round multiple** and returns `null`
for anything it cannot defend. `composeNumeralWords` uses lookahead rather
than carried state, because only lookahead can tell `አምስት ሺህ` (5 × 1,000)
from `ሃያ አንድ` (20 + 1) *and* keep a finished `tokkoma dugum` (70,000) from
becoming 70,070.

Oromo's compound tens (`sadde tokkoma` = 80, not 78) live in an explicit
`COMPOSITES` table. `tokkee` is the Oromo **seven**, not a 1-suffix — a test
asserts `digdama tokkee` = 27.

### 3.3 Prepositions are glued to the noun

Amharic writes `በቴሌብር` (via Telebirr) and `ለመስከረም` (for Meskerem) with no
space. `tokenVariants()` in `normalize.ts` generates the token plus its
marker-stripped forms, and every lexicon lookup tries them. Without this the
parser silently misses *the exact words a treasurer says* — it was the first
thing the benchmark tests caught.

### 3.4 What it refuses, and why

| Input | Result | Reasoning |
|---|---|---|
| two amounts | `AMBIGUOUS_AMOUNT`, blocking | picking one is a coin flip with someone's money |
| `ዶላር 500` | `CURRENCY_MISMATCH` + `NO_AMOUNT` | the ledger is ETB-only; reading dollars as birr is a 57× error |
| `በባንክ` (bank, unnamed) | `AMBIGUOUS_CHANNEL`, blocking | a bank lookup needs a provider |
| Telebirr **and** CBE in one sentence | `AMBIGUOUS_CHANNEL`, blocking | this is a real phishing shape |
| `5.000` | rejected | could be 5.000 birr or 5,000 birr; a comma is one keystroke |
| `12,34` | rejected as a whole | else the parser reads the tail of a typo as the amount |
| `ቁጥር 12345` | amount stays 5,000 | a labelled digit run is a receipt number, not a payment |
| `አሽት ሁለት` | `null` | would be 1,002; not a number anyone says |
| empty / whitespace | `UNPARSEABLE` | — |

`parseNumericToken` also rejects any token containing a letter. A reference
must never become an amount — that single confusion is how a receipt number
turns into a five-hundred-thousand-birr contribution.

### 3.5 The Ge'ez escape convention

Every Ge'ez literal in `src/lib/voice/**` and `test/voice.*` is a `\uXXXX`
escape. Not stylistic: a literal `፯` was silently mangled to `���` while
authoring this lane, which would have shipped a parser that stopped
recognising 60, 1,000 and every month name. `test/voice.numerals.test.ts`
therefore asserts the **rendered** forms (`expect("\u1274\u120c\u1265\u122d").toBe("ቴሌብር")`),
so a bad codepoint fails CI instead of reaching a treasurer.

### 3.6 A note on the calendar

`AGENTWORK.md` §2 lists `ታኅሣሥ` twice. Tahsas (month 4) and Nehase (month 12)
are different words; `docs/AGENT_BRIEFINGS.md` carries the corrected list and
that is what `months.ts` implements, with both spellings accepted and asserted
in tests. The Oromo names are the **Gecal** calendar — what Ethiopia actually
administers — not the Maddale Walaam names.

---

## 4. Web Audio

`recorder.ts` is the first code in this repository to touch `getUserMedia`,
`MediaRecorder`, `AudioContext` or `AnalyserNode`. Structure:

```
getUserStream → MediaStream
              ├→ MediaStreamAudioSourceNode → AnalyserNode → rAF at ~30 fps
              │     getByteTimeDomainData → frameToBars / frameToLevel
              └→ MediaRecorder → Blob → base64
```

Design points that are not obvious:

- **MIME is probed, never assumed.** `audio/webm;codecs=opus` in Chromium,
  `audio/mp4` in Safari. The *observed* `mimeType` travels with the recording
  (also flagged to A4 in `docs/requests/agent-2.md` R-4).
- **A missing `AudioContext` costs the meter, not the audio.** The graph is
  built in a `try`; recording proceeds without it.
- **`assessCapture` refuses a muted microphone.** Silence is not a transcript;
  transcribing it produces a hallucination. Below ≈ −56 dBFS, or under 600 ms,
  the capture is rejected with a human-readable reason.
- **A missing `AudioContext`/permission is reported, never faked.** `stop()`
  returns `null` and the UI says why.
- The maths lives in `waveform.ts`, pure over a byte frame, so
  `test/voice.audio.test.ts` feeds synthetic frames. Mocking a microphone would
  prove the code *calls* a function; it would not prove the waveform responds
  to a signal.

---

## 5. Fail-closed, by construction

`VoiceProviderError` mirrors A1's `src/lib/banking/errors.ts`: a named code, an
HTTP status, `Retry-After` when rate limited. Status map:

| Code | Status | Meaning |
|---|---|---|
| `PROVIDER_NOT_CONFIGURED` | 503 | no credential — the expected state here |
| `PROVIDER_UNAVAILABLE` | 502 | upstream fault |
| `PROVIDER_TIMEOUT` | 504 | `AbortSignal` fired |
| `PROVIDER_RATE_LIMITED` | 429 | `Retry-After` echoed |
| `PROVIDER_REJECTED` | 422 | malformed or empty provider body |
| `INVALID_AUDIO` / `INVALID_REQUEST` | 400 | our request was wrong |

`UnconfiguredSpeechToTextProvider.transcribe()` **throws**. It does not resolve
with an empty string, a canned transcript, or a `null`. The route tests assert
the 503 body contains no `"transcript"` key at all.

The response body is a code, never a message — `provider internal detail` does
not reach the client.

---

## 6. The hand-off to AGENT-1 (cross-lane task #14)

`AGENTWORK.md` §8.2: *neither* agent builds this alone. A2 owns the payload,
A1 owns the POST.

```ts
toBankVerificationIntent({ draft, bankAccountBindingId, occurredAt, idempotencyKey })
  → { ok: true,  body }        // byte-compatible with bankVerificationRequestSchema
  → { ok: false, rejections }  // every reason, each naming a field
```

`test/voice.intent.test.ts` imports **A1's own** `zod` schema and parses the
body with it, so the two lanes cannot drift. That test earned its keep: it
caught that A1 requires `providerReference.min(1)`, which meant a
reference-less draft produced an empty string that would have 400'd at the
boundary. `NO_TX_REF` is now a *rejection* (the bank lookup is keyed on the
reference) while staying a non-blocking *warning* on the draft.

`occurredAt` is **not** defaulted to `new Date()`. Speech cannot produce a
trustworthy clock, and the field feeds A1's request fingerprint and its
`TIMESTAMP_MISMATCH` reconciliation. A missing time is a question, not a guess.

**Status: wired.** `src/app/page.tsx` passes `requestBankVerification`
(`src/lib/voice/clientVerify.ts`) as `onRequestVerification` when the visitor is
signed in. It lists the caller's bank-account bindings, picks the one active
ETB binding that matches the spoken provider (zero or several matches are
refused, never guessed), and POSTs `/api/bank-verifications`; only a server
`VERIFIED` state yields `verified: true`, and `occurredAt` is the submission
time. Signed out, `onRecordLocally` saves a provisional note in the offline
store instead (transcript only; no audio is stored). If neither prop is given the
modal's submit control is disabled and says why. `onAddContribution` no longer
exists. See `docs/requests/agent-2.md` R-2 and R-5.

---

## 7. i18n

A2 is the single writer of `src/lib/i18n.ts` (§4.1). 92 new keys, all under
`voice.*` / `audio.*`, mirrored in `en` and `am`; `test/i18n.test.ts` asserts
parity.

Both modals default to `locale = "am"` because the M1 shell they live in is
Amharic today — flipping the default would be an unrequested UX regression in a
file I am allowed to edit only. The `/voice` workbench defaults to `en` with a
visible en/am switch, so a reviewer can read it.

---

## 8. Known limitations, stated rather than hidden

| Limitation | Why |
|---|---|
| Amharic `SpeechRecognition` support is browser-dependent; Oromo has no shipped BCP-47 tag in any major engine | `canSpeak()` / `isSpeechRecognitionSupported()` report the truth and the UI disables the control |
| No language auto-detect from a BCP-47 tag | the caller picks; guessing a language for a *financial* draft is not acceptable |
| Provider field names are assumed from a small candidate set (`transcript` / `text` / `result.text` / …) | a real integration must confirm Voxide's actual shape; a miss raises `PROVIDER_REJECTED`, never a partial parse |
| `/api/voice/extract` is unauthenticated and not rate limited | pure function, no persistence, no credential, 8 KiB cap. `/api/voice/transcribe` and `/api/voice/speak` are in `RATE_LIMITED` (`src/middleware.ts`); `extract` and `capabilities` are not |
| Voice notes store the transcript, not the audio | the signed-out local path (`recordVoiceNoteLocally` in `src/app/page.tsx`) saves a spoken note without audio; the store has an `audioMimeType` column, unused by this flow |
| Oromo speech recognition and an Oromo UI | the parser reads Oromo text, but `i18n.ts` has only `en` and `am`, and the audio digest speaks Amharic |

---

## 9. Test map

| File | Tests | Covers |
|---|---|---|
| `test/voice.parser.test.ts` | 38 | the ROADMAP utterance, Amharic + Oromo numeral tables, providers, and 11 negative cases |
| `test/voice.numerals.test.ts` | 63 | rendered Ge'ez lexica, composer, digit tokens, normalization, token variants, the 13 months |
| `test/voice.audio.test.ts` | 41 | waveform maths, capture quality, fail-closed STT/TTS, every provider fault |
| `test/voice.intent.test.ts` | 15 | the A1 hand-off, validated against A1's own schema |
| `test/voice.api.route.test.ts` | 27 | auth tiers, 400/401/429/502/503, no fabricated transcript, no smuggled `verified` |
| `test/voice.numerals.regression.test.ts` | 19 | numeral-composition regressions found after the first pass |
| `test/voice.local-record.test.tsx` | 9 | the modal with no verifier wired: records a provisional note on the device |
| **total** | **212** | as of 2026-10-03 (`npx vitest run test/voice`) |
