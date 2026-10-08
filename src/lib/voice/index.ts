/**
 * Roadmap M3 — Zero-Trust Voice Pipeline.
 *
 * Two halves, deliberately separable:
 *
 * - **Credential-free, provable now** — the Amharic / Afaan Oromoo parser
 *   (`parser`, `numerals`, `months`, `lexicon`, `normalize`), the Web Audio
 *   maths (`waveform`), and the intent bridge (`intent`). Pure functions,
 *   fully unit-tested, no network, no environment.
 * - **Credential-gated, fail-closed** — the STT/TTS providers (`stt`, `tts`)
 *   and the routes built on them. With no credential they raise
 *   `PROVIDER_NOT_CONFIGURED`; they never fake a result.
 *
 * Nothing in this lane can mark a contribution as verified. `verified` is a
 * literal `false` type and there is no code path that widens it.
 */

export {
  ETHIOPIAN_MONTH_IDS,
  ETHIOPIAN_MONTH_LABELS,
  ETHIOPIAN_MONTH_NUMBERS,
  VOICE_BLOCKING_ISSUE_CODES,
  VOICE_ISSUE_CODES,
  VOICE_ISSUE_DETAIL,
  VOICE_LANGUAGES,
  VOICE_PAYMENT_RAILS,
  isBlocking,
  isSubmittableToBank,
  type EthiopianMonthId,
  type ProvisionalContribution,
  type VoiceIssueCode,
  type VoiceLanguage,
  type VoiceLanguageDetection,
  type VoicePaymentRail
} from "./types";

export { parseContributionUtterance, type ParseOptions } from "./parser";
export { monthFormsFor, monthFromToken, monthLabel, monthNumber } from "./months";
export {
  composeNumeralWords,
  isNumeralWord,
  numeralPhraseToBirr,
  parseNumericToken,
  type NumeralPhrase
} from "./numerals";
export {
  foldCase,
  normalizeDigits,
  normalizePunctuation,
  normalizeUtterance,
  tokenizeUtterance,
  type UtteranceToken
} from "./normalize";
export {
  isCashToken,
  isEtbToken,
  isForeignCurrencyToken,
  isPaymentVerbToken,
  isTxRefTriggerToken,
  providerFromToken
} from "./lexicon";

export {
  MAX_CAPTURE_MS,
  MIN_CAPTURE_MS,
  LevelSmoother,
  amplitudeToLevel,
  arrayBufferToBase64,
  assessCapture,
  clamp01,
  frameToBars,
  frameToLevel,
  levelToDecibels,
  negotiateMimeType,
  type CaptureQuality
} from "./waveform";

export {
  rejectionsFor,
  toBankVerificationIntent,
  warningsFor,
  type BankVerificationIntentBody,
  type BankVerificationIntentInput,
  type IntentOutcome,
  type IntentRejectionCode,
  type IntentRejectionReason
} from "./intent";

export {
  VOICE_PROVIDER_ERROR_CODES,
  VoiceProviderError,
  isVoiceProviderError,
  retryAfterHeader,
  type VoiceProviderErrorCode
} from "./errors";

export {
  AUDIO_MIME_TYPES,
  UnconfiguredSpeechToTextProvider,
  AddisAiSpeechToTextProvider,
  createSpeechToTextProvider,
  isSttConfigured,
  isSupportedAudioMimeType,
  type SpeechToTextProvider,
  type SpeechToTextRequest,
  type SpeechToTextResult
} from "./stt";

export {
  DEFAULT_TTS_SPEED,
  TTS_SPEEDS,
  UnconfiguredTextToSpeechProvider,
  AddisAiTextToSpeechProvider,
  createTextToSpeechProvider,
  isTtsConfigured,
  isTtsSpeed,
  type TextToSpeechProvider,
  type TextToSpeechRequest,
  type TextToSpeechResult,
  type TtsSpeed
} from "./tts";
