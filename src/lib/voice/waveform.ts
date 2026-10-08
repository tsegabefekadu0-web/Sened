/**
 * Waveform maths, isolated from the Web Audio graph.
 *
 * `getUserMedia`, `MediaRecorder` and `AnalyserNode` are browser-only, so the
 * *arithmetic* they feed is kept here as pure functions over a byte frame.
 * That is what makes the live waveform testable: `test/voice.audio.test.ts`
 * feeds synthetic frames and asserts real behaviour, with no mock of the Web
 * Audio API pretending to be a microphone.
 */

/** FFT size used by the recorder. 2048 gives ~43 Hz resolution at 44.1 kHz. */
export const ANALYSER_FFT_SIZE = 2048;
export const DEFAULT_BAR_COUNT = 48;

/**
 * Roll a time-domain frame (0–255, centred on 128) into `barCount` bar
 * heights in [0, 1] using peak amplitude.
 *
 * Peak, not RMS: a treasurer needs to see that *something* is being picked up
 * between words, and peak is what a clipping risk actually looks like.
 */
export function frameToBars(frame: Uint8Array, barCount = DEFAULT_BAR_COUNT): number[] {
  const bars: number[] = [];
  if (barCount <= 0) {
    return bars;
  }
  if (frame.length === 0) {
    // A flat line, not a shorter one: the renderer indexes by bar position.
    return new Array<number>(barCount).fill(0);
  }
  const perBar = frame.length / barCount;
  for (let bar = 0; bar < barCount; bar += 1) {
    const start = Math.floor(bar * perBar);
    const end = Math.max(start + 1, Math.floor((bar + 1) * perBar));
    let peak = 0;
    for (let index = start; index < end && index < frame.length; index += 1) {
      const amplitude = Math.abs(frame[index] - 128) / 128;
      if (amplitude > peak) {
        peak = amplitude;
      }
    }
    bars.push(peak);
  }
  return bars;
}

/**
 * Perceptual level in [0, 1] from a time-domain frame, on a dBFS curve.
 *
 * -60 dBFS maps to 0 and 0 dBFS to 1. A linear average reads as dead silence
 * for normal speech, which would make a working microphone look broken.
 */
export function frameToLevel(frame: Uint8Array): number {
  if (frame.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const sample = (frame[index] - 128) / 128;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  if (rms <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(rms);
  return clamp01((db + 60) / 60);
}

/** Map a linear amplitude in [0, 1] onto the same dBFS curve. */
export function amplitudeToLevel(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(Math.min(1, amplitude));
  return clamp01((db + 60) / 60);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** dBFS as a number, for display. Returns `-Infinity` for silence. */
export function levelToDecibels(level: number): number {
  if (level <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return level * 60 - 60;
}

/**
 * Running peak with slow decay, for a level meter that feels like hardware.
 * `decayPerFrame` of 0.04 is roughly a 300 ms fall at 30 fps.
 */
export class LevelSmoother {
  private current = 0;
  private readonly attack: number;
  private readonly decay: number;

  constructor(attack = 0.6, decay = 0.04) {
    this.attack = attack;
    this.decay = decay;
  }

  push(level: number): number {
    const next = clamp01(level);
    this.current =
      next > this.current
        ? this.current + (next - this.current) * this.attack
        : Math.max(next, this.current - this.decay);
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }

  get value(): number {
    return this.current;
  }
}

/**
 * Is this recording worth sending to a speech provider?
 *
 * `peak` is the loudest sample observed; `peakDbfs` is that in dBFS. A
 * recording quieter than −55 dBFS is a muted microphone, not a quiet speaker,
 * and transcribing it would only produce a hallucination.
 */
export interface CaptureQuality {
  readonly peak: number;
  readonly peakDbfs: number;
  readonly meanLevel: number;
  readonly usable: boolean;
  readonly reason: "ok" | "silent" | "too_short" | "too_long";
}

export const MIN_USABLE_PEAK = 0.0016; // ≈ -56 dBFS
export const MIN_CAPTURE_MS = 600;
export const MAX_CAPTURE_MS = 60_000;

export function assessCapture(quality: {
  readonly peak: number;
  readonly meanLevel: number;
  readonly durationMs: number;
}): CaptureQuality {
  const peak = clamp01(quality.peak);
  const meanLevel = clamp01(quality.meanLevel);
  const peakDbfs = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;

  if (quality.durationMs > 0 && quality.durationMs < MIN_CAPTURE_MS) {
    return { peak, peakDbfs, meanLevel, usable: false, reason: "too_short" };
  }
  if (quality.durationMs > MAX_CAPTURE_MS) {
    return { peak, peakDbfs, meanLevel, usable: false, reason: "too_long" };
  }
  if (peak < MIN_USABLE_PEAK) {
    return { peak, peakDbfs, meanLevel, usable: false, reason: "silent" };
  }
  return { peak, peakDbfs, meanLevel, usable: true, reason: "ok" };
}

/** Base64-encode an ArrayBuffer without pulling in a dependency. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Pick the best container `MediaRecorder` supports here. */
export function negotiateMimeType(
  candidates: readonly string[],
  isTypeSupported: (type: string) => boolean
): string | null {
  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}
