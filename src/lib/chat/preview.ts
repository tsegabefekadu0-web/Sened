/**
 * The last line shown for each group in the chat list. Filled when a
 * conversation is open and by `useChatPreviews`; read by `previewFor`.
 */
export interface ChatPreview {
  readonly text: string;
  readonly time: string;
}

const previews = new Map<string, ChatPreview>();
const listeners = new Set<() => void>();

export function getChatPreview(groupId: string): ChatPreview | undefined {
  return previews.get(groupId);
}

export function setChatPreview(groupId: string, preview: ChatPreview): void {
  const old = previews.get(groupId);
  if (old && old.text === preview.text && old.time === preview.time) return;
  previews.set(groupId, preview);
  for (const l of listeners) l();
}

export function subscribeChatPreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
