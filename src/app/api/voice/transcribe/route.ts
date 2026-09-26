import { createSpeechToTextProvider } from "@/lib/voice/stt";
import { createTranscribeHandler } from "@/lib/voice/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/voice/transcribe` — speech to text.
 *
 * Requires a Bearer session (it spends a metered credential) and **fails
 * closed**: with no `VOXIDE_API_URL` / `VOXIDE_API_KEY` it returns 503
 * `not_configured` rather than a fabricated transcript. The browser-native
 * `SpeechRecognition` path in `src/lib/voice/recognition.ts` needs no
 * credential at all and is what the UI prefers when it exists.
 */
export const POST = createTranscribeHandler(() => createSpeechToTextProvider());
