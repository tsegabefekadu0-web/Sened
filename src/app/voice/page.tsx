import type { Metadata } from "next";
import "./voice-workbench.css";
import { VoiceWorkbench } from "@/components/voice/VoiceWorkbench";

export const metadata: Metadata = {
  title: "Sened | Voice pipeline",
  description:
    "Amharic and Afaan Oromoo contribution extraction, real microphone capture, and a fail-closed speech provider."
};

/**
 * `GET /voice` — AGENT-2's own route (AGENTWORK.md §2: "Each agent gets their
 * own route so they can prove their work in a browser without touching anyone
 * else's mount point").
 *
 * `src/app/page.tsx` belongs to AGENT-1, so this page is self-contained: it
 * links nothing outside my lane, and AGENT-1 links *to* it at integration
 * (`docs/requests/agent-2.md` R-3).
 */
export default function VoicePage() {
  return <VoiceWorkbench />;
}
