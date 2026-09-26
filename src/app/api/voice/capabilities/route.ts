import { createSpeechToTextProvider } from "@/lib/voice/stt";
import { createTextToSpeechProvider } from "@/lib/voice/tts";
import { createCapabilitiesHandler } from "@/lib/voice/routeHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/voice/capabilities` — what is actually wired up.
 *
 * Two booleans and two provider names. No auth, because it exposes nothing
 * about a user, and gating it would force the UI to guess whether speech is
 * available — a guess that fails mid-meeting, in front of a treasurer, is
 * exactly the failure this product is arguing against.
 *
 * The honest empty state lives here: `configured: false` is the expected
 * answer in this environment, and the UI renders it as a real message rather
 * than a spinner.
 */
export const GET = createCapabilitiesHandler(
  () => createSpeechToTextProvider(),
  () => createTextToSpeechProvider()
);
