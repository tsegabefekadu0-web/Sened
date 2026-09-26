"use client";

import {
  ANALYSER_FFT_SIZE,
  DEFAULT_BAR_COUNT,
  LevelSmoother,
  arrayBufferToBase64,
  assessCapture,
  frameToBars,
  frameToLevel,
  negotiateMimeType,
  type CaptureQuality
} from "./waveform";

/**
 * Real microphone capture: `getUserMedia` → `MediaStream` → `AnalyserNode`
 * for a live level meter → `MediaRecorder` for the audio.
 *
 * This is the replacement for the CSS `animate-ping` divs that stood in for a
 * waveform in the previous `VoiceModal`. Nothing here is simulated: if the
 * browser denies the microphone, the recorder reports `permission_denied` and
 * the UI says so.
 *
 * All browser API access is behind `typeof window` guards so the module is
 * importable from a server component.
 */

export const VOICE_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4"
] as const;

export type RecorderStatus =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "stopping"
  | "ready"
  | "permission_denied"
  | "unsupported"
  | "failed";

export interface RecorderError {
  readonly reason:
    | "permission_denied"
    | "no_device"
    | "unsupported_browser"
    | "no_mime_type"
    | "recorder_failed";
  readonly message: string;
}

export interface RecordingResult {
  readonly audioBase64: string;
  /** The MIME type the browser actually negotiated — never a hard-coded one. */
  readonly mimeType: string;
  readonly durationMs: number;
  readonly quality: CaptureQuality;
  /** Final level-meter history, for a static waveform after the fact. */
  readonly bars: readonly number[];
}

export interface VoiceRecorderOptions {
  readonly barCount?: number;
  readonly onBars?: (bars: readonly number[]) => void;
  readonly onLevel?: (level: number) => void;
  readonly onStatus?: (status: RecorderStatus) => void;
  readonly onError?: (error: RecorderError) => void;
  /** ~30 fps. Lower it on a low-end phone. */
  readonly frameIntervalMs?: number;
}

/** Does this browser have everything we need for real capture? */
export function isRecordingSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const hasMedia = typeof navigator.mediaDevices?.getUserMedia === "function";
  const hasRecorder = typeof window.MediaRecorder === "function";
  return hasMedia && hasRecorder;
}

function unavailable(reason: RecorderError["reason"], message: string): RecorderError {
  return { reason, message };
}

export class VoiceRecorder {
  private readonly options: VoiceRecorderOptions;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private frame: Uint8Array = new Uint8Array(0);
  private rafHandle: number | null = null;
  private startedAt = 0;
  private stoppedAt = 0;
  private peak = 0;
  private levelSum = 0;
  private levelSamples = 0;
  private readonly smoother = new LevelSmoother();
  private readonly history: number[] = [];
  private mimeType = "";
  private state: RecorderStatus = "idle";

  constructor(options: VoiceRecorderOptions = {}) {
    this.options = options;
  }

  get status(): RecorderStatus {
    return this.state;
  }

  get elapsedMs(): number {
    if (this.startedAt === 0) {
      return 0;
    }
    return (this.stoppedAt === 0 ? Date.now() : this.stoppedAt) - this.startedAt;
  }

  /**
   * Ask for the microphone and begin recording.
   *
   * Rejects — it does not fall back — when permission is denied, when there is
   * no input device, or when the browser cannot produce a supported container.
   */
  async start(): Promise<void> {
    if (!isRecordingSupported()) {
      this.fail(
        unavailable(
          "unsupported_browser",
          "This browser cannot record audio. A recent Chrome, Safari or Firefox build is required."
        )
      );
      throw new Error("Recording is not supported in this browser");
    }

    this.setStatus("requesting_permission");
    this.reset();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.fail(
          unavailable(
            "permission_denied",
            "Microphone access was denied. A treasurer must grant it to record a contribution."
          )
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        this.fail(unavailable("no_device", "No microphone was found on this device."));
      } else {
        this.fail(
          unavailable("recorder_failed", `The microphone could not be opened (${name || "unknown"}).`)
        );
      }
      throw error instanceof Error ? error : new Error("Microphone unavailable");
    }

    this.stream = stream;

    const mimeType = negotiateMimeType(
      VOICE_MIME_CANDIDATES,
      (candidate) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)
    );
    if (mimeType === null) {
      this.teardownStream();
      this.fail(
        unavailable(
          "no_mime_type",
          "This browser cannot produce a supported audio container for transcription."
        )
      );
      throw new Error("No supported audio container");
    }
    this.mimeType = mimeType;

    this.startAudioGraph();
    this.startRecorder(mimeType);
    this.startMetering();
    this.setStatus("recording");
  }

  private startAudioGraph(): void {
    try {
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (typeof AudioContextCtor !== "function" || this.stream === null) {
        return;
      }
      this.context = new AudioContextCtor();
      this.sourceNode = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = ANALYSER_FFT_SIZE;
      // Waveform display wants the raw time domain, not a frequency log axis.
      this.analyser.smoothingTimeConstant = 0.2;
      this.sourceNode.connect(this.analyser);
      this.frame = new Uint8Array(this.analyser.fftSize);
    } catch {
      // A missing AudioContext costs us the live meter, not the recording.
      this.context = null;
      this.sourceNode = null;
      this.analyser = null;
    }
  }

  private startRecorder(mimeType: string): void {
    if (this.stream === null) {
      return;
    }
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType });
      this.recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };
      this.recorder.start(250);
    } catch {
      this.recorder = null;
    }
  }

  private startMetering(): void {
    if (this.analyser === null) {
      return;
    }
    const barCount = this.options.barCount ?? DEFAULT_BAR_COUNT;
    const interval = this.options.frameIntervalMs ?? 33;
    let last = 0;

    const tick = (timestamp: number): void => {
      this.rafHandle = requestAnimationFrame(tick);
      if (timestamp - last < interval || this.analyser === null) {
        return;
      }
      last = timestamp;
      this.analyser.getByteTimeDomainData(this.frame);

      const rawLevel = frameToLevel(this.frame);
      const level = this.smoother.push(rawLevel);
      this.levelSum += level;
      this.levelSamples += 1;
      if (rawLevel > this.peak) {
        this.peak = rawLevel;
      }

      const bars = frameToBars(this.frame, barCount);
      this.history.push(...bars);
      if (this.history.length > barCount * 120) {
        this.history.splice(0, this.history.length - barCount * 120);
      }
      this.options.onBars?.(bars);
      this.options.onLevel?.(level);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Stop, then return the captured audio. Resolves `null` if nothing usable. */
  async stop(): Promise<RecordingResult | null> {
    if (this.state !== "recording") {
      return null;
    }
    this.setStatus("stopping");
    this.stoppedAt = Date.now();

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    const recorder = this.recorder;
    const blob = await new Promise<Blob | null>((resolve) => {
      if (recorder === null || recorder.state === "inactive") {
        resolve(null);
        return;
      }
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mimeType }));
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

    this.releaseAudioGraph();
    this.teardownStream();

    if (blob === null || blob.size === 0) {
      this.setStatus("failed");
      return null;
    }

    const durationMs = this.elapsedMs;
    const meanLevel = this.levelSamples > 0 ? this.levelSum / this.levelSamples : 0;
    const quality = assessCapture({ peak: this.peak, meanLevel, durationMs });
    const audioBase64 = arrayBufferToBase64(await blob.arrayBuffer());
    this.setStatus("ready");
    return {
      audioBase64,
      mimeType: this.mimeType,
      durationMs,
      quality,
      bars: this.tail()
    };
  }

  /** Discard everything and release the microphone. */
  cancel(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.recorder !== null && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.releaseAudioGraph();
    this.teardownStream();
    this.reset();
    this.setStatus("idle");
  }

  /** Last full bar row, for a static waveform once recording has stopped. */
  private tail(): number[] {
    const count = this.options.barCount ?? DEFAULT_BAR_COUNT;
    if (this.history.length === 0) {
      return [];
    }
    return this.history.slice(this.history.length - count);
  }

  private releaseAudioGraph(): void {
    if (this.sourceNode !== null) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already detached */
      }
      this.sourceNode = null;
    }
    if (this.context !== null) {
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
    this.analyser = null;
  }

  private teardownStream(): void {
    if (this.stream === null) {
      return;
    }
    for (const track of this.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    this.stream = null;
  }

  private reset(): void {
    this.chunks = [];
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.peak = 0;
    this.levelSum = 0;
    this.levelSamples = 0;
    this.history.length = 0;
    this.smoother.reset();
  }

  private fail(error: RecorderError): void {
    this.setStatus(error.reason === "permission_denied" ? "permission_denied" : "failed");
    this.options.onError?.(error);
  }

  private setStatus(status: RecorderStatus): void {
    this.state = status;
    this.options.onStatus?.(status);
  }
}
