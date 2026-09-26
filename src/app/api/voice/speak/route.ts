import { createTextToSpeechProvider } from "@/lib/voice/tts";
import { createSpeakHandler } from "@/lib/voice/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/voice/speak` — text to speech for the `አድምጥ` digest.
 *
 * Requires a Bearer session and **fails closed** with 503 `not_configured`
 * when no synthesis provider is configured. The browser-native
 * `speechSynthesis` engine in `src/lib/voice/synthesis.ts` provides the real
 * audio without any credential, including the speed control ROADMAP §3.2
 * requires.
 */
export const POST = createSpeakHandler(() => createTextToSpeechProvider());
