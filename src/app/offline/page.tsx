import type { Metadata } from "next";
import { OfflineConsole } from "./offline-console";

/**
 * The treasurer's offline desk — AGENT-4 (M6.1).
 *
 * This is my own route so my lane can be proved in a browser without touching
 * `src/app/page.tsx`, which A1 owns and integrates at the end.
 *
 * The page is honest about what it is: a local record-keeping surface, not the
 * ledger. Nothing rendered here claims to be verified, and nothing it stores can
 * reach the hash chain without the server's rules accepting it.
 */
export const metadata: Metadata = {
  title: "Sened · የመስመር መዝገብ ጠረጴዛ — Offline ledger desk",
  description:
    "Record contributions, spoken notes and draft ledger entries with no connection. Nothing is committed until it syncs."
};

export default function OfflinePage() {
  return <OfflineConsole />;
}
