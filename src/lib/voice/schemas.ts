import { z } from "zod";
import { WIRE_ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import { AUDIO_MIME_TYPES, MAX_AUDIO_BASE64_CHARS, MAX_TRANSCRIPT_CHARS } from "./stt";
import { MAX_DIGEST_CHARS } from "./tts";
import { VOICE_LANGUAGES, VOICE_PAYMENT_RAILS } from "./types";

/**
 * Zod schemas for A2's own routes.
 *
 * These live in `src/lib/voice/**`, not in `src/lib/validation.ts`, because
 * AGENTWORK.md §3 assigns that file to A1. I import `parse` from A1's module
 * (read-only) rather than forking it, so error shapes stay identical across
 * lanes.
 *
 * All client-writable schemas are `.strict()` — a smuggled field is rejected,
 * not silently stripped.
 */

const languageSchema = z.enum(VOICE_LANGUAGES);
const railSchema = z.enum(VOICE_PAYMENT_RAILS);

/** `audio/webm;codecs=opus` and friends. */
const mimeTypeSchema = z
  .string()
  .min(1)
  .max(96)
  .refine(
    (value) => (AUDIO_MIME_TYPES as readonly string[]).some((candidate) => value.startsWith(candidate.split(";")[0])),
    "Unsupported audio container"
  );

export const transcriptionRequestSchema = z
  .object({
    audioBase64: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Audio payload is not base64"),
    mimeType: mimeTypeSchema,
    language: languageSchema,
    durationMs: z.number().int().min(0).max(60_000).optional()
  })
  .strict();

export const extractionRequestSchema = z
  .object({
    transcript: z.string().min(1).max(MAX_TRANSCRIPT_CHARS)
  })
  .strict();

export const digestRequestSchema = z
  .object({
    text: z.string().min(1).max(MAX_DIGEST_CHARS),
    language: languageSchema,
    /**
     * Bounded here, then checked against `TTS_SPEEDS` in the handler so a
     * cast is never needed to satisfy the literal union.
     */
    speed: z.number().min(0.5).max(2)
  })
  .strict();

/**
 * Mirrors `ProvisionalContribution` for the wire.
 *
 * `status` and `verified` are declared as literals on the way *out* so a
 * response can never claim a voice-extracted record is anything but
 * provisional, whatever the server felt like doing.
 */
export const provisionalContributionSchema = z
  .object({
    status: z.literal("PROVISIONAL"),
    verified: z.literal(false),
    language: z.enum(["am", "om", "mixed", "unknown"]),
    amount: z.number().int().positive().nullable(),
    amountWire: z
      .string()
      .regex(WIRE_ETB_DECIMAL_PATTERN, "Amount is not in ledger wire format")
      .nullable(),
    currency: z.literal("ETB"),
    currencySource: z.enum(["explicit", "assumed"]),
    month: z
      .enum([
        "meskerem",
        "tikimt",
        "hidar",
        "tahsas",
        "tir",
        "yekatit",
        "megabit",
        "miyazya",
        "ginbot",
        "sene",
        "hamle",
        "nehase",
        "pagumen"
      ])
      .nullable(),
    monthLabel: z.string().min(1).max(32).nullable(),
    rail: railSchema,
    provider: z.enum(["telebirr", "cbe", "awash"]).nullable(),
    txRef: z.string().min(4).max(24).regex(/^[A-Z0-9]+$/, "Reference is not alphanumeric").nullable(),
    txRefSource: z.enum(["labelled", "bare"]).nullable(),
    utterance: z.string().max(MAX_TRANSCRIPT_CHARS),
    normalized: z.string().max(MAX_TRANSCRIPT_CHARS),
    issues: z.array(z.string().min(1).max(64)).max(16),
    blocking: z.boolean()
  })
  .strict();

export const transcriptionResponseSchema = z
  .object({
    transcript: z.string().min(1).max(MAX_TRANSCRIPT_CHARS),
    confidence: z.number().min(0).max(1).nullable(),
    provider: z.string().min(1).max(64),
    detectedLanguage: languageSchema.nullable()
  })
  .strict();

export const extractionResponseSchema = z
  .object({
    contribution: provisionalContributionSchema,
    /** Non-blocking observations the treasurer should still see. */
    warnings: z.array(z.string().min(1).max(64)).max(16)
  })
  .strict();

export const digestResponseSchema = z
  .object({
    audioBase64: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
    mimeType: z.string().min(1).max(96),
    provider: z.string().min(1).max(64),
    /** What the browser should do with the audio. */
    playback: z.object({ speeds: z.array(z.number()).min(1).max(8) }).strict()
  })
  .strict();

/** A pure-parser availability probe, so the UI can be honest before recording. */
export const voiceCapabilitySchema = z
  .object({
    sttProvider: z.string().min(1).max(64),
    sttConfigured: z.boolean(),
    ttsProvider: z.string().min(1).max(64),
    ttsConfigured: z.boolean(),
    languages: z.array(languageSchema).min(1)
  })
  .strict();

export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>;
export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
export type DigestRequest = z.infer<typeof digestRequestSchema>;
export type ProvisionalContributionWire = z.infer<typeof provisionalContributionSchema>;
export type VoiceCapability = z.infer<typeof voiceCapabilitySchema>;
