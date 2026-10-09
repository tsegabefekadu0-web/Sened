/**
 * Carries what was said from the listening screen to the draft screen. The text
 * only (never audio); kept in sessionStorage so a refresh of the draft keeps it.
 */
const KEY = "sened.voice.handoff.v1";

export interface VoiceHandoff {
  readonly utterance: string;
  readonly source: "asr" | "human-typed";
}

export function saveVoiceHandoff(value: VoiceHandoff): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: the draft screen then starts empty.
  }
}

export function readVoiceHandoff(): VoiceHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoiceHandoff>;
    if (typeof parsed.utterance !== "string" || parsed.utterance.trim() === "") return null;
    return { utterance: parsed.utterance, source: parsed.source === "human-typed" ? "human-typed" : "asr" };
  } catch {
    return null;
  }
}

export function clearVoiceHandoff(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
