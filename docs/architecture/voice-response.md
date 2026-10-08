# Getting Amharic in, and Amharic out

> **Scope:** how a Sened treasurer *speaks* Amharic into the app, and how the app
> *speaks Amharic back*. This is a companion to
> [`voice.md`](./voice.md), not a replacement. `voice.md` is owned by AGENT-2
> (`AGENTWORK.md` §3); this file is additive and edits nothing it owns.

> **Status:** research + design. Nothing in here is implemented. Read §1 before
> you touch `src/lib/voice/stt.ts` or `src/lib/voice/tts.ts` — the current
> adapters in those files are built on a Voxide endpoint that does not exist.

---

## 1. The finding that changes the plan

Sened's STT and TTS adapters both assume Voxide exposes an HTTP endpoint that
accepts audio/text and returns audio/text. It does not.

From Voxide's own privacy policy (`voxide.app/privacy`), under service providers:

> **Google** — Runs the Gemini models that understand speech and generate
> replies. Voice and text are sent to Google during a conversation.
>
> Audio is not stored. Speech is transcribed to text during the conversation and
> the audio itself is not written to our systems.

From `voxide.app/docs`:

> Voxide allows you to expose your existing client-side JavaScript functions to a
> **Gemini-powered Live AI**.

**What Voxide actually is:** a browser SDK (`@voxide/react`) that maps a spoken or
typed request to *your* JavaScript function. It owns the microphone handling, the
waveform, the orb, live state binding (`ai.bindState`), action dispatch, and a
`dangerous: true` confirmation step.

**What Voxide is not:** a speech provider. It exposes no STT endpoint, no TTS
endpoint, and no language setting. `voxide.app/docs/languages` returns **404**;
there is no language configuration surface to find. Language coverage is exactly
Gemini's — which is the whole reason it does not respond in an Ethiopian voice.

### 1.1 What this breaks in the tree today

| File | Current premise | Status |
|---|---|---|
| `src/lib/voice/stt.ts` | `VOXIDE_API_URL` + `VOXIDE_API_KEY`, `POST` audio, `Authorization: Bearer` | Endpoint does not exist. Fails closed at 503 — correct behaviour, permanently unsatisfiable. |
| `src/lib/voice/tts.ts` | `VOXIDE_TTS_API_URL` + `VOXIDE_TTS_API_KEY`, expects `{ audio \| audio_base64 \| data.audio \| result.audio }` | Same. The `AUDIO_PATHS`/`MIME_PATHS` candidate sets are guesses at a response shape that was never documented. |

Both fail closed, which is the right instinct and should not change. What must
change is *which* provider they are aiming at. Keeping the current premise would
be worse than useless: a judge reading `stt.ts` sees a credential-gated client
for an API that isn't real, and that discounts the honesty built everywhere else
in this repository.

**Keep:** the interfaces (`SpeechToTextProvider`, `TextToSpeechProvider`), the
`VoiceProviderError` status map, and every test in `test/voice.audio.test.ts`
that asserts fail-closed behaviour.
**Replace:** the two `Voxide*Provider` implementations and their env-var names.

---

## 2. The architecture: three seams, only one of them ours

The mistake to avoid is treating "voice" as one vendor. It is three
independently swappable problems, and only the middle one is a moat.

```
[Mic] ──ASR──▶ [ text ] ──▶ parseContributionUtterance() ──▶ [ intent ] ──▶ [ bank ] ──▶ TTS ──▶ [ Speaker ]
            swappable        src/lib/voice/parser.ts        swappable    Links.et       swappable
                              + numerals / months / lexicon   (A1)
```

| Seam | Job | Who owns it | Who should own it |
|---|---|---|---|
| **ASR** | turn sound into characters | a vendor | a vendor — buy it |
| **Parse** | turn Amharic characters into a typed intent | **Sened** | **nobody else, ever** |
| **TTS** | turn a typed sentence back into sound | a vendor | a vendor — buy it |

`AGENTWORK.md` §12.4 says *voice is never a committer*. This diagram is that rule
made architectural: **a model may produce the sentence. It may never produce the
truth.** The parse seam is where the product's integrity lives, and it is
credential-free, pure, and already tested — see `voice.md` §2 and §3.

### 2.1 Why the parse seam must not be delegated

A general model will not reliably produce `አምስት ሃምሳ` (55) rather than 50,
`shan digdama` (50) rather than 100, or `መስከረም` as a month. `src/lib/voice/numerals.ts`
handles the prefix/suffix ambiguity that a model will guess at, and
`voice.md` §3.4 lists the eleven inputs it *refuses* — `AMBIGUOUS_AMOUNT`,
`CURRENCY_MISMATCH`, `AMBIGUOUS_CHANNEL` — each for a reason that is about
someone's money.

A model that guesses 55 → 50 is a 500-bir error credited to a real member. So the
utterance is routed into `parseContributionUtterance()` and its output stays
`status: "PROVISIONAL"`, `verified: false` — a literal type no code path widens —
until Links.et confirms.

---

## 3. Amharic IN — speech to text

| Option | Amharic quality | Cost | Credential | Verdict |
|---|---|---|---|---|
| **Gemini, via Voxide** | decent on code-switched `am`/English (`አምስት ሃምሶ ብር አስገባለሁ`) | 5 free sessions, then $29/mo or $0.03/session | `vox_pub_…` (publishable, safe in frontend) | **Use it.** Free, already mandatory, and good enough to hand a sentence to the parser. |
| **Addis AI** (`addisassistant.com`, PyPI `addisai`) | purpose-built Amharic + Afaan Oromo STT; their copy claims most providers "go silent on Amharic" | ~1.40 ETB/min, billed on **transcribed text only — audio input is free** | `ADDIS_API_KEY` | **The fallback.** ~20 ETB covers a 15-minute demo. Node + Python SDKs, `am`/`om`/`en`/`ha`/`sw`. |
| **EthiopicAI** (`ethiopic.ai` / `.io`) | ASR for `am`, `om`, `ti`, `so`, built for low bandwidth and code-mixing | not published | account | Fallback if Addis AI is unavailable. |
| **Browser `SpeechRecognition`** | browser-dependent; **no shipped BCP-47 tag for Oromo in any major engine** | free | none | `recognition.ts` already reports the truth and disables the control. Keep as a fallback only, never as the plan. |

**Recommendation:** Voxide/Gemini primary, Addis AI fallback, `recognition.ts`
last. A `SpeechToTextProvider` chain with a documented order — first configured
wins, and a miss is `PROVIDER_UNAVAILABLE`, never a partial parse.

### 3.1 The one thing that makes this work

Voxide hands you **the utterance**, not the intent. So the capability registered
with `ai.register()` must take the raw string and pass it to the parser:

```ts
ai.register({
  logContribution: {
    description:
      "Record a member contribution to the Equb. The treasurer speaks in Amharic " +
      "or Afaan Oromoo. Pass the sentence through exactly as spoken.",
    params: { utterance: { type: "string", required: true } },
    // §12.4: voice proposes, the bank disposes. This is the UI half of that.
    dangerous: true,
    handler: ({ utterance }) => {
      const parsed = parseContributionUtterance(utterance);
      // Parsed output is provisional. Hand it to the UI for read-back, then to
      // A1's /api/bank-verifications. Never to the ledger directly.
      return { status: parsed.status, ...parsed };
    },
  },
});
```

`dangerous: true` forces a UI confirmation before the handler runs. That
confirmation *is* the `እሁን ነው?` read-back a treasurer needs before someone else's
money is credited — Voxide's safety feature and this repository's central
non-negotiable are the same mechanism.

### 3.2 Integration notes, from the docs

- Mount `<VoxideWidget client={ai} />` **once, in the root layout** — anywhere
  else it remounts on navigation and any in-flight call is cut off.
- Whitelist the production domain in the dashboard (project → Settings), or the
  WebSocket is refused by CORS. `localhost` always works. **Add the EthioDeploy
  hostname before deploying** or the demo fails only in production.
- The key is `vox_pub_…` from the project's **Integration** tab, and is safe to
  ship in frontend code. Whitelisting is what makes that safe.
- `npx voxide-mcp` exists: it serves the integration guide, SDK reference, and
  copy-paste examples to a coding assistant.

**On credentials:** hackathon promo codes are account-bound and issued per event,
and Voxide's privacy policy records redemption against a named account specifically
so an event code cannot be scripted. **We do not have a code and must not guess
one.** Sign up at `voxide.app/signup` for 5 free sessions, no card required —
enough for a demo. After that it is $29/mo or $0.03/session, which is not a
constraint at this scale.

---

## 4. Amharic OUT — text to speech

This is the actual gap, and it is the cheaper of the two to close.

| Option | Languages | Cost | Verdict |
|---|---|---|---|
| **Addis AI** | `am`, `om` — **28 production voices** | **$0.032/min (300 ETB/hr)** | **Recommended.** REST + SDK, `mp3_44100` / `wav_44100` / `pcm_16000`, and a `voice_settings.speed` parameter. |
| **EthiopicAI** | `am`, `om`, `ti`, `so` | not published | Fallback. |
| **Browser `speechSynthesis`** | only if the OS has an `am`/`om` voice pack installed | free | Keep. It already works and it is the offline path. |
| **Voxide / Gemini** | Gemini's set — not Amharic | — | Not a TTS option for this product. |

### 4.1 The free win in `voice_settings.speed`

`tts.ts` already defines `TTS_SPEEDS = [0.75, 1, 1.25, 1.5, 2]` and
`synthesis.ts` already implements real play/pause/speed against `utterance.rate`.
Addis AI's `voice_settings.speed` maps onto `TtsSpeed` directly, so ROADMAP §3.2's
play/pause/speed requirement is satisfied by swapping the provider — no UI work.

### 4.2 The digest is text first, audio second

The digest must never depend on audio to exist. `synthesis.ts` already holds the
right rule: if no voice is installed, `canSpeak()` is false, the caption stays,
and it says why. Extend that unchanged to the new provider — a provider fault
renders the digest as text with an honest reason, and never as a beep, a timer,
or silence that reads as success.

---

## 5. Degradation ladder

Every rung is honest. No rung fabricates a transcript, an amount, or an audio
file.

| # | Condition | Behaviour |
|---|---|---|
| 1 | Voxide configured, network fine | Gemini → `parseContributionUtterance()` → read-back → Links.et → Addis AI confirmation |
| 2 | Voxide absent or session exhausted | Browser `SpeechRecognition` if an `am` voice exists; otherwise the *Type instead* path that is already built and tested (`test/voice.local-record.test.tsx`) |
| 3 | Links.et unreachable | `PENDING_RECONCILIATION` + backoff. The draft stays provisional. Spoken confirmation says so — "ተረጋግጧል, ግን አልተረጋገጠም" — never a plain success |
| 4 | No network at all | Dexie draft, `content-hashed`, shown as pending. Already implemented and tested |
| 5 | No Amharic TTS anywhere | Digest renders as text with a caption and a stated reason |

Rung 3 is the one that matters most for the demo: a spoken message that says
*"unverified"* when the bank did not answer is the product working, not failing.

---

## 6. Work list

| # | Change | Files | Est. |
|---|---|---|---|
| 1 | Sign up, mint `vox_pub_…`, add EthioDeploy host to the domain whitelist | — | 15 min |
| 2 | Install the SDK — **requires the AGENT-4 install protocol** (`AGENTWORK.md` §4.3) | `package.json` | — |
| 3 | Register Sened's capabilities; mount the widget once in the root layout | new `src/components/voice/VoxideDock.tsx`, `src/app/layout.tsx` **(A1-owned)** | 2 h |
| 4 | Route the utterance into the parser; never into the ledger | `src/components/voice/**`, `src/lib/voice/parser.ts` | 1 h |
| 5 | Add `dangerous: true` to the commit action | as above | 15 min |
| 6 | Replace `VoxideSpeechToTextProvider` with an Addis AI implementation; keep the interface and every fail-closed test | `src/lib/voice/stt.ts` | 1.5 h |
| 7 | Replace `VoxideTextToSpeechProvider` with an Addis AI implementation; map `TtsSpeed` → `voice_settings.speed` | `src/lib/voice/tts.ts` | 1.5 h |
| 8 | Tests for both new providers, mirroring `test/voice.audio.test.ts`: success, timeout, 429, malformed body, unconfigured, wrong currency | `test/voice.*.test.ts` | 1 h |
| 9 | Self-host the Amharic voice note in `.env.example` | `.env.example` **(A1-owned)** | 10 min |

Total ≈ **7 h**, under **1,000 ETB** including demo-length usage.

**`AGENTWORK.md` §4.3:** only AGENT-4 may run `npm install`. Every agent was told
it needed zero new dependencies, and this is the one case that breaks that
promise — so it needs a filed request, not a unilateral install.

---

## 7. Do not do these

- **Do not let a model extract the amount.** `parseContributionUtterance` already
  does it correctly and refuses the ambiguous cases. Delegating it to Gemini is
  how a 500-bir error gets credited.
- **Do not invent a `VOXIDE_TTS_API_URL`.** Documented nowhere; it does not exist.
  An adapter aimed at a fictional endpoint is the exact lie this repository
  refuses to tell elsewhere.
- **Do not add a second browser STT engine** hoping one of them speaks Oromo. None
  ships an Oromo BCP-47 tag; that is a vendor problem, not a code problem.
- **Do not translate Amharic to English to feed a model.** The ledger is ETB-only
  and the parser is built on Ge'ez. `CURRENCY_MISMATCH` exists for a reason.
- **Do not commit a key.** `vox_pub_…` is publishable by design but still belongs
  in the dashboard, not the repo, and the demo key should be revocable after the
  event.

---

## 8. What I could not verify

Stated rather than hidden, per `voice.md` §8.

- **Addis AI's exact REST request/response shape.** Pricing, language coverage and
  the `voice_settings.speed` parameter come from their own marketing material and
  SDK listings, not from an authenticated call. Confirm against a live key before
  the adapter is written — `voice.md` §8 already flags the identical risk for the
  current Voxide field guesses.
- **EthiopicAI pricing and API shape.** Unpublished.
- **Voxide promo codes.** Not public, not requested, not guessed. §3.2.
- **Gemini's actual Amharic transcription accuracy on Ethiopian accents.** Stated
  as "decent on code-switching" on the strength of provider positioning, not
  measurement. **This is the one assumption worth testing first**, because the
  whole rung-1 path rests on it: record thirty seconds of a treasurer on a real
  phone and see what comes back.

---

## 9. References

**Voxide** (read 2026-10-07)
`voxide.app` · `/docs` · `/docs/quickstart` · `/docs/actions` · `/docs/state` ·
`/docs/privacy` — the privacy policy is the load-bearing citation for §1.

**Voice providers**
Addis AI `addisassistant.com`, PyPI `addisai` · EthiopicAI `ethiopic.ai`

**This repository**
[`voice.md`](./voice.md) · `AGENTWORK.md` §3, §4.3, §12 · `ROADMAP.md` §3.1, §3.2 ·
`docs/IDEATION.md` §5.1 · `src/lib/voice/{parser,numerals,months,lexicon,normalize,stt,tts,synthesis,recognition}.ts`

**Regulatory context, for later**
NBE `Draft-Sandbox-Directive` · NBE *National Digital Payments Strategy 2026-2030*
· ECMA *Collective Investment Schemes Directive No. 1150/2026*