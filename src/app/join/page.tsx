import type { Metadata } from "next";

import { JoinPanel } from "@/components/ledger/JoinPanel";

export const metadata: Metadata = {
  title: "Sened | Join a group",
  description: "Join a group with an invite link.",
  // The page is useless to a crawler and its URL fragment is a credential.
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

/** `GET /join#token=...` — redeem an invite link. See `JoinPanel`. */
export default function JoinPage() {
  return <JoinPanel />;
}
