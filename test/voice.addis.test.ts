import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADDIS_TTS_VOICE,
  addisLanguageFor,
  isTrustedAudioUrl,
  isValidAddisVoiceId,
  readAddisTtsVoice
} from "@/lib/voice/addisAi";
import {
  AddisAiSpeechToTextProvider,
  UnconfiguredSpeechToTextProvider,
  createSpeechToTextProvider,
  isSttConfigured
} from "@/lib/voice/stt";
import {
  AddisAiTextToSpeechProvider,
  UnconfiguredTextToSpeechProvider,
  createTextToSpeechProvider,
  isTtsConfigured
} from "@/lib/voice/tts";

const KEY = "super-secret-key";
const ENV = { ADDIS_AI_API_KEY: KEY };
const AUDIO = { audioBase64: "QUJD", mimeType: "audio/webm;codecs=opus", language: "am" as const };
const AUDIO_URL = "https://cdn.addisassistant.com/signed/abc.mp3?sig=1";

interface Captured {
  url: string;
  init: RequestInit;
}

function capture(...responses: (() => Response | Promise<Response>)[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve(next());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const sttWith = (fetchImpl: typeof fetch) => new AddisAiSpeechToTextProvider({ apiKey: KEY, fetchImpl });
const ttsWith = (fetchImpl: typeof fetch, voice = DEFAULT_ADDIS_TTS_VOICE) =>
  new AddisAiTextToSpeechProvider({ apiKey: KEY, voice, fetchImpl });

describe("Addis AI configuration", () => {
  it("is unconfigured by default and fails closed", async () => {
    expect(createSpeechToTextProvider({}).isConfigured).toBe(false);
    expect(createSpeechToTextProvider({}).name).toBe("unconfigured-stt");
    expect(createTextToSpeechProvider({}).isConfigured).toBe(false);
    expect(isSttConfigured({})).toBe(false);
    expect(isTtsConfigured({})).toBe(false);
    await expect(new UnconfiguredSpeechToTextProvider().transcribe()).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED"
    });
    await expect(new UnconfiguredTextToSpeechProvider().synthesize()).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED"
    });
  });

  it("treats empty and whitespace values as unset", () => {
    expect(createSpeechToTextProvider({ ADDIS_AI_API_KEY: "" }).isConfigured).toBe(false);
    expect(createSpeechToTextProvider({ ADDIS_AI_API_KEY: "   " }).isConfigured).toBe(false);
    expect(readAddisTtsVoice({ ADDIS_AI_TTS_VOICE: "  " })).toBe("am-hamen");
    expect(createSpeechToTextProvider({ ...ENV, VOICE_STT_PROVIDER: "" }).isConfigured).toBe(true);
  });

  it("constructs real clients named addis-ai when the key is present", () => {
    const stt = createSpeechToTextProvider(ENV);
    const tts = createTextToSpeechProvider(ENV);
    expect(stt.isConfigured && tts.isConfigured).toBe(true);
    expect(stt.name).toBe("addis-ai");
    expect(tts.name).toBe("addis-ai");
  });

  it("lets VOICE_*_PROVIDER switch a direction off, and any unknown value fails closed", () => {
    expect(createSpeechToTextProvider({ ...ENV, VOICE_STT_PROVIDER: "addis-ai" }).isConfigured).toBe(true);
    expect(createSpeechToTextProvider({ ...ENV, VOICE_STT_PROVIDER: "azure" }).isConfigured).toBe(false);
    expect(createTextToSpeechProvider({ ...ENV, VOICE_TTS_PROVIDER: "voxide" }).isConfigured).toBe(false);
    expect(createSpeechToTextProvider({ ...ENV, VOICE_TTS_PROVIDER: "voxide" }).isConfigured).toBe(true);
  });

  it("REJECTS (leaves TTS unconfigured for) a voice id that is not a plain token", () => {
    expect(readAddisTtsVoice({})).toBe(DEFAULT_ADDIS_TTS_VOICE);
    expect(readAddisTtsVoice({ ADDIS_AI_TTS_VOICE: "am-hamen" })).toBe("am-hamen");
    expect(readAddisTtsVoice({ ADDIS_AI_TTS_VOICE: "om-abc-1" })).toBe("om-abc-1");
    for (const bad of ["Am-Hamen", "hamen", "am_hamen", 'am-"x', "am-../x", "am-a b", "am-", `am-${"a".repeat(41)}`]) {
      expect(isValidAddisVoiceId(bad)).toBe(false);
      expect(createTextToSpeechProvider({ ...ENV, ADDIS_AI_TTS_VOICE: bad }).isConfigured).toBe(false);
    }
    expect(() => ttsWith(capture(() => new Response()).fetchImpl, "bad voice")).toThrow();
  });

  it("maps Amharic only; Oromo has no documented STT code", () => {
    expect(addisLanguageFor("am")).toBe("am");
    expect(addisLanguageFor("om")).toBeNull();
    expect(addisLanguageFor("fr")).toBeNull();
    expect(addisLanguageFor("__proto__")).toBeNull();
  });
});

describe("AddisAiSpeechToTextProvider", () => {
  const good = () =>
    Response.json({ status: "success", data: { transcription: "እቁብ 5000 ብር", usage_metadata: {} }, confidence: 0.98 });

  it("posts a multipart upload to /api/v2/stt with x-api-key, audio and request_data", async () => {
    const { fetchImpl, calls } = capture(good);
    const result = await sttWith(fetchImpl).transcribe(AUDIO);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.addisassistant.com/api/v2/stt");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.redirect).toBe("error");

    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const audio = form.get("audio") as File;
    expect(audio.type).toBe("audio/webm");
    expect(audio.name).toBe("audio.webm");
    expect(audio.size).toBe(3);
    const requestData = form.get("request_data") as Blob;
    expect(requestData.type).toBe("application/json");
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(requestData);
    });
    expect(JSON.parse(json)).toEqual({ language_code: "am" });

    expect(result).toEqual({ transcript: "እቁብ 5000 ብር", confidence: 0.98, provider: "addis-ai", detectedLanguage: "am" });
  });

  it("reads confidence from data.confidence when the top level has none, and clamps it", async () => {
    const a = capture(() => Response.json({ data: { transcription: "x", confidence: 0.5 } }));
    expect((await sttWith(a.fetchImpl).transcribe(AUDIO)).confidence).toBe(0.5);
    const b = capture(() => Response.json({ data: { transcription: "x" }, confidence: 7 }));
    expect((await sttWith(b.fetchImpl).transcribe(AUDIO)).confidence).toBe(1);
    const c = capture(() => Response.json({ data: { transcription: "x" } }));
    expect((await sttWith(c.fetchImpl).transcribe(AUDIO)).confidence).toBeNull();
  });

  it("names the upload part by container (m4a, webm)", async () => {
    const mp4 = capture(good);
    await sttWith(mp4.fetchImpl).transcribe({ ...AUDIO, mimeType: "audio/mp4" });
    const part = (mp4.calls[0].init.body as FormData).get("audio") as File;
    expect([part.type, part.name]).toEqual(["audio/mp4", "audio.m4a"]);
  });

  it("REJECTS (UNSUPPORTED_LANGUAGE) Oromo and unknown languages before any network call", async () => {
    const { fetchImpl, calls } = capture(good);
    for (const language of ["om", "fr"]) {
      await expect(sttWith(fetchImpl).transcribe({ ...AUDIO, language: language as never })).rejects.toMatchObject({
        code: "UNSUPPORTED_LANGUAGE"
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("REJECTS (INVALID_AUDIO) empty, over 60 s, over 10 MB and wrong-container audio before any network call", async () => {
    const { fetchImpl, calls } = capture(good);
    const provider = sttWith(fetchImpl);
    await expect(provider.transcribe({ ...AUDIO, audioBase64: "" })).rejects.toMatchObject({ code: "INVALID_AUDIO" });
    await expect(provider.transcribe({ ...AUDIO, durationMs: 60_001 })).rejects.toMatchObject({
      code: "INVALID_AUDIO"
    });
    await expect(provider.transcribe({ ...AUDIO, mimeType: "video/mp4" })).rejects.toMatchObject({
      code: "INVALID_AUDIO"
    });
    // 10 MB + 1 byte of decoded audio, but under the base64 character cap's own check.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    await expect(provider.transcribe({ ...AUDIO, audioBase64: big })).rejects.toMatchObject({
      code: "INVALID_AUDIO"
    });
    expect(calls).toHaveLength(0);
    await expect(provider.transcribe({ ...AUDIO, durationMs: 60_000 })).resolves.toBeDefined();
  });

  it("maps 401/403 and 402 to PROVIDER_UNAVAILABLE without leaking the upstream body or key", async () => {
    for (const status of [401, 402, 403]) {
      const { fetchImpl } = capture(
        () => new Response(`{"status":"error","error":{"message":"bad ${KEY} for acct"}}`, { status })
      );
      const error = await sttWith(fetchImpl).transcribe(AUDIO).catch((e: Error) => e);
      expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).not.toContain("acct");
    }
  });

  it("maps 429 to PROVIDER_RATE_LIMITED with Retry-After", async () => {
    const { fetchImpl } = capture(() => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    await expect(sttWith(fetchImpl).transcribe(AUDIO)).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retryAfterSeconds: 30
    });
  });

  it("maps 400 to PROVIDER_REJECTED and 5xx to PROVIDER_UNAVAILABLE", async () => {
    const bad = capture(() => new Response("nope", { status: 400 }));
    await expect(sttWith(bad.fetchImpl).transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    for (const status of [500, 503]) {
      const { fetchImpl } = capture(() => new Response("boom", { status }));
      await expect(sttWith(fetchImpl).transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    }
  });

  it("maps a network fault to PROVIDER_TIMEOUT and aborts a hung request at the timeout", async () => {
    const down = sttWith((() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    await expect(down.transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const slow = new AddisAiSpeechToTextProvider({ apiKey: "k", timeoutMs: 20, fetchImpl: hanging });
    await expect(slow.transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("rejects a malformed body, an error envelope and an empty transcript — silence is not a transcript", async () => {
    const malformed = capture(() => new Response("not json", { status: 200 }));
    await expect(sttWith(malformed.fetchImpl).transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    const bodies: unknown[] = [
      {},
      [],
      { status: "success", data: { transcription: "" } },
      { status: "success", data: { transcription: "   " } },
      { status: "success", data: {} },
      { status: "error", error: { code: "x", message: "m" }, data: { transcription: "leaked" } }
    ];
    for (const body of bodies) {
      const { fetchImpl } = capture(() => Response.json(body));
      await expect(sttWith(fetchImpl).transcribe(AUDIO)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    }
  });

  it("caps transcript length", async () => {
    const { fetchImpl } = capture(() => Response.json({ data: { transcription: "x".repeat(5000) } }));
    expect((await sttWith(fetchImpl).transcribe(AUDIO)).transcript).toHaveLength(2000);
  });
});

describe("isTrustedAudioUrl", () => {
  it("accepts https on addisassistant.com and its subdomains only", () => {
    expect(isTrustedAudioUrl("https://addisassistant.com/a.mp3")).toBe(true);
    expect(isTrustedAudioUrl("https://cdn.addisassistant.com/a.mp3?sig=1")).toBe(true);
    expect(isTrustedAudioUrl("https://A.B.AddisAssistant.com:443/a.mp3")).toBe(true);
  });

  it("accepts extra configured storage hosts and their subdomains", () => {
    expect(isTrustedAudioUrl("https://storage.googleapis.com/audio/1.mp3", ["storage.googleapis.com"])).toBe(true);
    expect(isTrustedAudioUrl("https://mybucket.r2.cloudflarestorage.com/1.mp3", ["r2.cloudflarestorage.com"])).toBe(true);
    expect(isTrustedAudioUrl("https://unrelated.com/1.mp3", ["storage.googleapis.com"])).toBe(false);
  });

  it("REJECTS http, foreign hosts, userinfo tricks, lookalikes and junk", () => {
    for (const bad of [
      "http://cdn.addisassistant.com/a.mp3",
      "https://evil.com/a.mp3",
      "https://addisassistant.com@evil.com/a.mp3",
      "https://cdn.addisassistant.com@evil.com/a.mp3",
      "https://user:pw@cdn.addisassistant.com/a.mp3",
      "https://evil-addisassistant.com/a.mp3",
      "https://addisassistant.com.evil.com/a.mp3",
      "https://notaddisassistant.com/a.mp3",
      "https://cdn.addisassistant.com:8443/a.mp3",
      "file:///etc/passwd",
      "//cdn.addisassistant.com/a.mp3",
      "",
      "not a url",
      undefined,
      null,
      42
    ]) {
      expect(isTrustedAudioUrl(bad)).toBe(false);
    }
  });
});

describe("AddisAiTextToSpeechProvider", () => {
  const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  const meta = (url: unknown = AUDIO_URL) => () =>
    Response.json({ status: "success", data: { id: "g1", audio_url: url, mime_type: "audio/mpeg", duration_seconds: 2 } });
  const mp3 = () => new Response(audioBytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
  const speak = { text: "የዚህ ወር ሂሳብ", language: "am" as const, speed: 1 as const };

  it("posts JSON to /api/v1/voice/generations, then fetches the signed audio_url", async () => {
    const { fetchImpl, calls } = capture(meta(), mp3);
    const result = await ttsWith(fetchImpl).synthesize({ ...speak, speed: 1.25 });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.addisassistant.com/api/v1/voice/generations");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      text: speak.text,
      voice_id: "am-hamen",
      language: "am",
      output_format: "mp3_44100",
      voice_settings: { speed: 1.25 },
      stream: false
    });

    expect(calls[1].url).toBe(AUDIO_URL);
    expect(calls[1].init.method).toBe("GET");
    expect(JSON.stringify(calls[1].init.headers)).not.toContain(KEY);
    expect(calls[1].init.redirect).toBe("error");

    expect(result).toEqual({
      audioBase64: Buffer.from(audioBytes).toString("base64"),
      mimeType: "audio/mpeg",
      provider: "addis-ai"
    });
  });

  it("uses the configured voice, and accepts playback.url", async () => {
    const { fetchImpl, calls } = capture(
      () => Response.json({ data: { playback: { url: AUDIO_URL } } }),
      mp3
    );
    await ttsWith(fetchImpl, "am-other1").synthesize(speak);
    expect(JSON.parse(calls[0].init.body as string).voice_id).toBe("am-other1");
    expect(calls[1].url).toBe(AUDIO_URL);
  });

  it("REJECTS an audio_url that is not https on addisassistant.com, without fetching it", async () => {
    for (const url of [
      "http://cdn.addisassistant.com/a.mp3",
      "https://evil.com/a.mp3",
      "https://addisassistant.com@evil.com/a.mp3",
      "https://evil-addisassistant.com/a.mp3",
      null,
      ""
    ]) {
      const { fetchImpl, calls } = capture(meta(url), mp3);
      await expect(ttsWith(fetchImpl).synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
      expect(calls).toHaveLength(1);
    }
  });

  it("REJECTS an oversized download, by header and by stream", async () => {
    const declared = capture(
      meta(),
      () => new Response(audioBytes, { status: 200, headers: { "content-length": String(10 * 1024 * 1024 + 1) } })
    );
    await expect(ttsWith(declared.fetchImpl).synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });

    const streamed = capture(meta(), () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200 }));
    await expect(ttsWith(streamed.fetchImpl).synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });

  it("rejects an empty audio body and a malformed metadata body", async () => {
    const empty = capture(meta(), () => new Response(new Uint8Array(0), { status: 200 }));
    await expect(ttsWith(empty.fetchImpl).synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    const bad = capture(() => new Response("nope", { status: 200 }));
    await expect(ttsWith(bad.fetchImpl).synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });

  it("falls back to audio/mpeg when the metadata mime type is not audio/*", async () => {
    const { fetchImpl } = capture(
      () => Response.json({ data: { audio_url: AUDIO_URL, mime_type: "text/html" } }),
      mp3
    );
    expect((await ttsWith(fetchImpl).synthesize(speak)).mimeType).toBe("audio/mpeg");
  });

  it("REJECTS empty, oversized, bad-speed and non-Amharic requests before any network call", async () => {
    const { fetchImpl, calls } = capture(meta(), mp3);
    const provider = ttsWith(fetchImpl);
    await expect(provider.synthesize({ ...speak, text: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.synthesize({ ...speak, text: "x".repeat(4001) })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(provider.synthesize({ ...speak, language: "om" })).rejects.toMatchObject({
      code: "UNSUPPORTED_LANGUAGE"
    });
    await expect(provider.synthesize({ ...speak, speed: 3 as never })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    expect(calls).toHaveLength(0);
  });

  it("maps upstream failures, on either call, without leaking bodies or the key", async () => {
    const cases: [number, string][] = [
      [401, "PROVIDER_UNAVAILABLE"],
      [402, "PROVIDER_UNAVAILABLE"],
      [429, "PROVIDER_RATE_LIMITED"],
      [400, "PROVIDER_REJECTED"],
      [500, "PROVIDER_UNAVAILABLE"],
      [503, "PROVIDER_UNAVAILABLE"]
    ];
    for (const [status, code] of cases) {
      const failing = () => new Response(`secret upstream ${KEY}`, { status });
      for (const responses of [[failing], [meta(), failing]]) {
        const { fetchImpl } = capture(...responses);
        const error = await ttsWith(fetchImpl).synthesize(speak).catch((e: Error) => e);
        expect(error).toMatchObject({ code });
        expect((error as Error).message).not.toContain("secret upstream");
        expect((error as Error).message).not.toContain(KEY);
      }
    }
  });

  it("maps a network fault and a hung request to PROVIDER_TIMEOUT", async () => {
    const down = ttsWith((() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    await expect(down.synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const slow = new AddisAiTextToSpeechProvider({ apiKey: "k", voice: "am-hamen", timeoutMs: 20, fetchImpl: hanging });
    await expect(slow.synthesize(speak)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
});
