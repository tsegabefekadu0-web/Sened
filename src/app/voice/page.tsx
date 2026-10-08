import type { Metadata } from "next";
import "./voice-workbench.css";
import { VoiceScreen } from "@/components/voice/VoiceScreen";
import { VoiceWorkbench } from "@/components/voice/VoiceWorkbench";

export const metadata: Metadata = {
  title: "Sened | Record by voice",
  description: "Record a contribution by voice or by typing. A bank check makes it final."
};

/**
 * `GET /voice` is the plain screen for members and treasurers.
 *
 * The developer workbench (entity extraction lab, microphone capture, provider
 * status, hand-off body) is kept, unchanged, at `GET /voice?debug=1`.
 */
export default function VoicePage({
  searchParams
}: {
  readonly searchParams?: Record<string, string | string[] | undefined>;
}) {
  return searchParams?.debug === "1" ? <VoiceWorkbench /> : <VoiceScreen />;
}
