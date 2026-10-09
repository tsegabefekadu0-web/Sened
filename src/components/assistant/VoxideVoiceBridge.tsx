"use client";

import { useEffect } from "react";
import { useVoxideVoice, type VoxideClient } from "@voxide/react";

/**
 * Headless: connects the English Voxide voice session while the voice sheet is
 * open in English, ends it when the sheet closes or the language changes, and
 * reports its status. Loaded lazily, only when a key is configured.
 */
export default function VoxideVoiceBridge({
  client,
  active,
  onStatus
}: {
  readonly client: unknown;
  readonly active: boolean;
  readonly onStatus: (status: string) => void;
}) {
  const voice = useVoxideVoice((client as VoxideClient | null) ?? null);
  const { connect, disconnect, status } = voice;

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  useEffect(() => {
    if (!active) return;
    void connect().catch(() => undefined);
    return () => disconnect();
    // connect/disconnect are stable per client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, client]);

  return null;
}
