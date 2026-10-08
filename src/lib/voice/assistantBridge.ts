/**
 * How the voice assistant asks the home screen to open its existing UI.
 *
 * The assistant (Voxide today, the Amharic lane later) never writes to the
 * ledger. When it has something to show, it asks the screen that already owns
 * the modal to open it, and the person finishes with a tap in that modal.
 * Plain window events, so this module needs no React and no provider.
 */

export const OPEN_DIGEST_EVENT = "sened:assistant-open-digest";
export const OPEN_DRAFT_EVENT = "sened:assistant-open-draft";

export interface OpenDraftDetail {
  /** What the person said, to be shown in the existing draft UI for review. */
  readonly utterance: string;
}

function emit(name: string, detail?: unknown): boolean {
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(name, { detail }));
  return true;
}

export function requestOpenDigest(): boolean {
  return emit(OPEN_DIGEST_EVENT);
}

export function requestOpenDraft(utterance: string): boolean {
  return emit(OPEN_DRAFT_EVENT, { utterance } satisfies OpenDraftDetail);
}
