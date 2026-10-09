import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function openVoiceSheet(): void {
  open = true;
  emit();
}

export function closeVoiceSheet(): void {
  open = false;
  emit();
}

export function useVoiceSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false
  );
}
