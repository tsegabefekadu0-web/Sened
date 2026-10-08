# Getting Amharic in, and Amharic out

> **Scope:** how a Sened treasurer *speaks* Amharic into the app, and how the app
> *speaks Amharic back*. A companion to [`voice.md`](./voice.md), which owns the
> parser and the fail-closed contract.

> **Status:** the Amharic server lane is implemented with Addis AI, unverified
> against a live key. Voxide is the English voice assistant (a client-side
> widget, a hackathon requirement) and is built separately. Browser speech and
> "type instead" remain the fallbacks. Voice output stays **provisional**:
> nothing a model hears or says is a verified fact.

---

## 1. Two voice products, two jobs

| | Voxide | Addis AI |
|---|---|---|
| Role | The **English** voice assistant | The **Amharic** voice-in / voice-out lane |
| Where it runs | In the browser: the `@voxide/react` widget | On our server, behind `/api/voice/transcribe` and `/api/voice/speak` |
| Key | Public, client-side (`NEXT_PUBLIC_VOXIDE_KEY`) | Server secret (`ADDIS_AI_API_KEY`) |
| Required by | The hackathon | Amharic entry and the spoken balance sheet |

**Why there is no server-side Voxide adapter.** The first adapters assumed
Voxide exposed an HTTP endpoint that takes audio or text and returns text or
audio. It does not. `voxide.app/docs` describes a browser SDK that lets a
**Gemini-powered Live AI** call your client-side JavaScript functions; its
privacy policy names Google as the processor of voice and text. There is no STT
endpoint, no TTS endpoint and no language setting, and its language coverage is
Gemini's. The `VOXIDE_API_URL` / `VOXIDE_API_KEY` variables and the
`Voxide*Provider` classes never reached a real endpoint and were removed. That
removal says nothing against the widget, which stays.

## 2. Architecture: three seams, only one of them ours

```
[Mic] ──ASR──▶ [ text ] ──▶ parseContributionUtterance() ──▶ [ intent ] ──▶ [ bank ] ──▶ TTS ──▶ [ Speaker ]
            swappable        src/lib/voice/parser.ts        swappable    Links.et       swappable
```

ASR and TTS are bought; the parse seam (Amharic numerals, months, channels,
refusing ambiguity) is Sened's and is never delegated to a model. Output stays
`status: "PROVISIONAL"`, `verified: false` until Links.et confirms
(`AGENTWORK.md` §12.4: voice proposes, the bank disposes).

## 3. Amharic lane: Addis AI

Verified against `docs.addisassistant.com` and the official `addisai@0.5.0` npm
SDK source on 2026-10-08. Both directions are server-side only; the key is never
sent to the browser. Base URL `https://api.addisassistant.com`, auth header
`x-api-key: <key>`.

| Item | STT | TTS |
|---|---|---|
| Endpoint | `POST /api/v2/stt` | `POST /api/v1/voice/generations` |
| Request | multipart: `audio` (a file with name and extension) and `request_data` = JSON `{"language_code":"am"}` | JSON: `text`, `voice_id`, `language: "am"`, `output_format: "mp3_44100"`, `voice_settings.speed`, `stream: false` |
| Formats / limits | WAV, MP3, M4A, WebM; **60 s and 10 MB** | MP3 output; we cap text at 4,000 characters |
| Response | `{status, data:{transcription, usage_metadata}, confidence}` | **metadata**, not audio: `{status, data:{id, audio_url, mime_type, duration_seconds, ...}}` |
| Languages | `am` only is documented | Amharic voices (default `am-hamen`, female); Oromo exists but we keep TTS Amharic-only |
| Errors | `{status:"error", error:{code,message}}` with 400, 401, 402 (insufficient credits), 403, 404, 429, 500, 503 | same |
| Price | 3.5 ETB per 1K characters | 5 ETB per minute |

Free plan: 60 requests per minute.

**TTS is two calls.** The generation reply carries a signed `audio_url`; the
server then GETs it and returns base64 audio to our client. That URL is
untrusted data from an upstream body, so it is fetched only if it is `https:`
with a hostname of `addisassistant.com` or a subdomain of it (parsed host, so
`https://addisassistant.com@evil.com`, `evil-addisassistant.com` and a custom
port all fail). The fetch carries no API key, follows no redirects, is capped
at 10 MB and shares the timeout. Anything else fails closed as
`PROVIDER_REJECTED`. Neither the SDK nor the docs name Addis AI's storage host,
so a storage domain outside `addisassistant.com` would be refused until it is
confirmed and added.

**Mapping.** App `am` becomes `am`. Afaan Oromoo (`om`) has no documented STT
code; it is refused with `UNSUPPORTED_LANGUAGE` instead of being run through an
Amharic model. `TtsSpeed` maps directly to `voice_settings.speed` (1 is normal).
The transcript is read from `data.transcription`; confidence from the top-level
`confidence`, else `data.confidence`.

**Limits we enforce.** Recording up to **60 s** (the recorder's `MAX_CAPTURE_MS`,
the request schema and `MAX_STT_DURATION_MS` agree; longer is `INVALID_AUDIO`),
decoded audio up to 10 MB, base64 payload up to 8 MiB, digest text up to 4,000
characters, STT timeout 30 s, TTS timeout 60 s (the SDK's own floor is 95 s).
Status mapping: 429 is `PROVIDER_RATE_LIMITED` (with `Retry-After`); 400, 413,
415 and 422 are `PROVIDER_REJECTED`; 401, 402, 403 and 5xx are
`PROVIDER_UNAVAILABLE` (a bad key or empty credit is ours to fix, not the
user's); a network fault or timeout is `PROVIDER_TIMEOUT`. Upstream bodies are
never copied into errors. Middleware still rate-limits both routes as
`WRITE_RULE`; those buckets are unchanged.

**Configuration** (see `.env.example`): `ADDIS_AI_API_KEY`, optional
`ADDIS_AI_TTS_VOICE` (a plain id token such as `am-hamen`; anything else leaves
TTS unconfigured), optional `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER`
(`addis-ai` or unset; any other value disables that direction).
`GET /api/voice/capabilities` reports `addis-ai` and a configured flag per
direction.

**Azure considered and dropped.** Azure AI Speech (`am-ET`, fast transcription,
neural voices) was implemented first and works on paper, but it has no Afaan
Oromoo model, needs a cloud region and a subscription, and Addis AI is built for
Ethiopian languages. It was removed rather than kept as dead code.

## 4. Degradation ladder

| # | Condition | Behaviour |
|---|---|---|
| 1 | Addis AI configured, network fine | recording, then Addis AI transcript, then parser, then read-back, then Links.et |
| 2 | Addis AI absent, out of credit, rate limited or failing | browser `SpeechRecognition` where an `am` engine exists, otherwise the *Type instead* path |
| 3 | Links.et unreachable | `PENDING_RECONCILIATION`; the draft stays provisional and is spoken as such |
| 4 | No network | Dexie draft, content-hashed, shown as pending |
| 5 | No Amharic voice (server or device) | the digest renders as text with a stated reason |

A provider fault is a named error code, never silence that reads as success.

## 5. Benchmark before relying on it

1. Record 30 clips on real phones: 10 numeric contributions ("5000 ብር በቴሌብር"),
   10 with a month and a reference code, 10 noisy or accented.
2. Hand-transcribe each as ground truth.
3. Score character error rate **and** the field that matters: did
   `parseContributionUtterance()` extract the right amount, rail and reference
   (exact match, no partial credit).
4. Record latency and cost per clip.
5. Listen to 10 digests with two native speakers (clarity, number reading,
   speed settings).

A wrong amount is a real member credited wrongly, so amount and reference
accuracy decide whether the server lane is trusted.

## 6. Not verified

- No live Addis AI call has been made from this repo.
- **WebM/Opus acceptance.** Addis AI lists WebM, but whether the exact
  `audio/webm;codecs=opus` that Chrome and Firefox record is accepted needs a
  live test. Safari's `audio/mp4` is covered by the M4A entry. Old Firefox
  `audio/ogg` is not on the documented list and may be rejected.
- The lifetime of the signed `audio_url`, and the storage host it points at (we
  accept only `addisassistant.com` and subdomains).
- Privacy, hosting and retention terms for voice and text sent to Addis AI.
- Real Amharic accuracy on Ethiopian phone audio (§5 exists for this).
- What the service returns for pure silence is undocumented; any result without
  text is treated as no speech (`PROVIDER_REJECTED`).
- Whether `voice_settings.speed` accepts every `TtsSpeed` value (0.75 to 2).

## 7. Do not do these

- Do not let a model extract the amount; the parser exists to refuse ambiguity.
- Do not transcode on the server to satisfy an API; pick the API that accepts the browser's format.
- Do not translate Amharic to English to feed a model; the ledger is ETB-only and the parser is built on Ge'ez.
- Do not expose the Addis AI key as `NEXT_PUBLIC_*`, log it, or log audio or text.
- Do not fetch an `audio_url` without the host check.
