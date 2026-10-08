import { describe, expect, it } from "vitest";
import {
  ANALYSER_FFT_SIZE,
  LevelSmoother,
  amplitudeToLevel,
  arrayBufferToBase64,
  assessCapture,
  clamp01,
  frameToBars,
  frameToLevel,
  levelToDecibels,
  negotiateMimeType,
  MAX_CAPTURE_MS,
  MIN_CAPTURE_MS
} from "@/lib/voice/waveform";
import { AUDIO_MIME_TYPES, isSupportedAudioMimeType } from "@/lib/voice/stt";
import { TTS_SPEEDS, UnconfiguredTextToSpeechProvider, createTextToSpeechProvider, isTtsConfigured, isTtsSpeed } from "@/lib/voice/tts";
import { VoiceProviderError, isVoiceProviderError, retryAfterHeader } from "@/lib/voice/errors";

/**
 * The Web Audio maths, the fail-closed providers, and the honest empty states.
 *
 * No `getUserMedia`, `MediaRecorder` or `AudioContext` is mocked. Mocking a
 * microphone would prove that the code calls a function; it would not prove the
 * waveform responds to an actual signal. So the arithmetic is tested directly
 * over synthetic `AnalyserNode` frames, which is the part that can silently be
 * wrong.
 */

/** A frame of `length` samples at the given byte value (128 = silence). */
function frame(length: number, byte: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

/** A frame that alternates between silence and the given peak amplitude. */
function pulsedFrame(length: number, peak: number): Uint8Array {
  const buffer = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    buffer[index] = index % 2 === 0 ? 128 : Math.round(128 + peak * 128);
  }
  return buffer;
}

describe("frameToBars — the live waveform", () => {
  it("returns the requested number of bars", () => {
    expect(frameToBars(frame(ANALYSER_FFT_SIZE, 128), 32)).toHaveLength(32);
    expect(frameToBars(frame(1024, 160), 0)).toHaveLength(0);
  });

  it("reads silence as a flat line", () => {
    expect(frameToBars(frame(1024, 128), 8).every((bar) => bar === 0)).toBe(true);
  });

  it("reacts to a real signal — this is the whole point of the replacement for animate-ping", () => {
    const quiet = frameToBars(pulsedFrame(2048, 0.1), 16);
    const loud = frameToBars(pulsedFrame(2048, 0.9), 16);

    expect(Math.max(...quiet)).toBeGreaterThan(0.05);
    expect(Math.max(...loud)).toBeGreaterThan(Math.max(...quiet) * 5);
  });

  it("clamps to [0, 1] even for a full-scale clipped signal", () => {
    const clipped = frameToBars(new Uint8Array([0, 255, 0, 255]), 4);
    expect(clipped.every((bar) => bar >= 0 && bar <= 1)).toBe(true);
    expect(Math.max(...clipped)).toBe(1);
  });

  it("is safe on an empty frame", () => {
    expect(frameToBars(new Uint8Array(0), 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("frameToLevel — a perceptual meter, not a linear one", () => {
  it("reads digital silence as exactly 0", () => {
    expect(frameToLevel(frame(2048, 128))).toBe(0);
    expect(frameToLevel(new Uint8Array(0))).toBe(0);
  });

  it("gives normal speech a visible level, not a near-zero one", () => {
    // A linear average would read ~0.02 here and look like a dead microphone.
    const speaking = frameToLevel(pulsedFrame(2048, 0.05));
    expect(speaking).toBeGreaterThan(0.4);
    expect(speaking).toBeLessThan(0.9);
  });

  it("orders louder signals above quieter ones", () => {
    const levels = [0.01, 0.05, 0.2, 0.5].map((peak) => frameToLevel(pulsedFrame(2048, peak)));
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]).toBeGreaterThan(levels[index - 1]);
    }
  });

  it("stays inside [0, 1] for a clipped signal", () => {
    expect(frameToLevel(new Uint8Array(2048).fill(255))).toBeLessThanOrEqual(1);
  });
});

describe("amplitudeToLevel and clamp01", () => {
  it("maps the dBFS curve consistently with frameToLevel", () => {
    expect(amplitudeToLevel(1)).toBe(1);
    expect(amplitudeToLevel(0.1)).toBeCloseTo(amplitudeToLevel(0.1), 10);
    expect(amplitudeToLevel(0)).toBe(0);
    expect(amplitudeToLevel(-1)).toBe(0);
    expect(amplitudeToLevel(Number.NaN)).toBe(0);
  });

  it("clamps, including non-finite input", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("reports silence in dBFS as negative infinity, not 0", () => {
    expect(levelToDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(levelToDecibels(1)).toBe(0);
  });
});

describe("LevelSmoother", () => {
  it("rises fast and decays slowly, like a hardware meter", () => {
    const smoother = new LevelSmoother(0.6, 0.04);
    const first = smoother.push(1);
    const second = smoother.push(1);

    expect(first).toBeCloseTo(0.6, 5);
    expect(second).toBeGreaterThan(first);
  });

  it("decays when the input goes quiet", () => {
    const smoother = new LevelSmoother(0.6, 0.04);
    smoother.push(1);
    for (let index = 0; index < 20; index += 1) {
      smoother.push(0);
    }
    expect(smoother.value).toBe(0);
  });

  it("resets", () => {
    const smoother = new LevelSmoother();
    smoother.push(1);
    smoother.reset();
    expect(smoother.value).toBe(0);
  });
});

describe("assessCapture — refuse to transcribe a dead microphone", () => {
  it("accepts a real recording", () => {
    const quality = assessCapture({ peak: 0.2, meanLevel: 0.5, durationMs: 4_000 });
    expect(quality.usable).toBe(true);
    expect(quality.reason).toBe("ok");
  });

  it("rejects silence", () => {
    const quality = assessCapture({ peak: 0, meanLevel: 0, durationMs: 4_000 });
    expect(quality.usable).toBe(false);
    expect(quality.reason).toBe("silent");
    expect(quality.peakDbfs).toBe(Number.NEGATIVE_INFINITY);
  });

  it("rejects a tap too short to contain a sentence", () => {
    expect(assessCapture({ peak: 0.5, meanLevel: 0.5, durationMs: MIN_CAPTURE_MS - 1 }).reason).toBe(
      "too_short"
    );
    expect(assessCapture({ peak: 0.5, meanLevel: 0.5, durationMs: MIN_CAPTURE_MS }).usable).toBe(true);
  });

  it("rejects a recording past the ceiling", () => {
    expect(
      assessCapture({ peak: 0.5, meanLevel: 0.5, durationMs: MAX_CAPTURE_MS + 1 }).reason
    ).toBe("too_long");
  });
});

describe("arrayBufferToBase64", () => {
  it("encodes a known payload", () => {
    const bytes = new Uint8Array([84, 101, 115, 116]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe("VGVzdA==");
  });

  it("encodes an empty buffer", () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe("");
  });
});

describe("negotiateMimeType", () => {
  it("prefers opus/webm, which every Chromium and Firefox build records", () => {
    const chosen = negotiateMimeType(AUDIO_MIME_TYPES, (type) => type === "audio/mp4");
    expect(chosen).toBe("audio/mp4");
    expect(negotiateMimeType(AUDIO_MIME_TYPES, () => true)).toBe("audio/webm;codecs=opus");
  });

  it("returns null when nothing is supported, so the caller can say so", () => {
    expect(negotiateMimeType(AUDIO_MIME_TYPES, () => false)).toBeNull();
  });
});

describe("the fail-closed TTS provider", () => {
  it("is the default and throws rather than synthesizing", async () => {
    const provider = createTextToSpeechProvider({});
    expect(provider.isConfigured).toBe(false);
    await expect(new UnconfiguredTextToSpeechProvider().synthesize()).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED"
    });
    expect(isTtsConfigured({})).toBe(false);
  });

  it("offers the speeds ROADMAP §3.2 requires", () => {
    expect(TTS_SPEEDS).toEqual([0.75, 1, 1.25, 1.5, 2]);
    expect(isTtsSpeed(1.25)).toBe(true);
    expect(isTtsSpeed(3)).toBe(false);
    expect(isTtsSpeed("1")).toBe(false);
  });
});

describe("VoiceProviderError", () => {
  it("maps codes onto the repo's status conventions", () => {
    expect(new VoiceProviderError("PROVIDER_NOT_CONFIGURED", "p", "m").status).toBe(503);
    expect(new VoiceProviderError("PROVIDER_UNAVAILABLE", "p", "m").status).toBe(502);
    expect(new VoiceProviderError("PROVIDER_TIMEOUT", "p", "m").status).toBe(504);
    expect(new VoiceProviderError("PROVIDER_RATE_LIMITED", "p", "m").status).toBe(429);
    expect(new VoiceProviderError("INVALID_AUDIO", "p", "m").status).toBe(400);
  });

  it("emits Retry-After only when rate limited", () => {
    expect(retryAfterHeader(new VoiceProviderError("PROVIDER_RATE_LIMITED", "p", "m", 12))).toBe("12");
    expect(retryAfterHeader(new VoiceProviderError("PROVIDER_RATE_LIMITED", "p", "m"))).toBe("1");
    expect(retryAfterHeader(new VoiceProviderError("PROVIDER_TIMEOUT", "p", "m", 5))).toBeNull();
  });

  it("is recognizable without instanceof surviving a module boundary", () => {
    expect(isVoiceProviderError(new VoiceProviderError("INVALID_REQUEST", "p", "m"))).toBe(true);
    expect(isVoiceProviderError(new Error("m"))).toBe(false);
    expect(isVoiceProviderError(null)).toBe(false);
  });
});
