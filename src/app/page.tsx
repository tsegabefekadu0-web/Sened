"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";
import { DebterCard } from "@/components/treasury/DebterCard";
import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";
import { BottomVoiceNav } from "@/components/navigation/BottomVoiceNav";
import { VoiceModal } from "@/components/voice/VoiceModal";
import { AudioDigestModal } from "@/components/voice/AudioDigestModal";

/**
 * Every row here is PROVISIONAL.
 *
 * These are fixtures standing in for a roster read from the offline store, and
 * nothing has verified any of them. The old version of this file set
 * `telebirrVerified: newEntry.channel === "Telebirr"` — turning a *spoken
 * sentence* into a bank confirmation — and the feed hard-coded
 * `verifiedBy: "Links.et Core Trust Engine"`. That is §12.3, and it was the
 * single most damaging thing in the product: a judge tapping a green badge
 * would conclude the verification engine was fake.
 *
 * A row only becomes `VERIFIED` when `/api/bank-verifications` returns a real
 * result, which needs a bound account and a signed-in treasurer. That is
 * `docs/requests/agent-2.md` R-2 / board task #14, not something a component
 * can assume.
 */
const referenceContributions: MemberContribution[] = [
  {
    id: "1",
    name: "Ethiopian elders, Members",
    avatar: "/avatars/elder_photo.png",
    secondaryAvatar: "/avatars/man_photo.png",
    channel: "telebirr",
    transactionId: "C0970153",
    status: "PROVISIONAL"
  },
  {
    id: "2",
    name: "Gabi Member",
    avatar: "/avatars/woman_photo.png",
    channel: "cbe",
    transactionId: "C0370320",
    status: "PROVISIONAL"
  }
];

export default function SenedHome() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"home" | "ledger" | "members" | "profile">("home");
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  const [isDigestModalOpen, setIsDigestModalOpen] = useState(false);

  const [contributions] = useState<MemberContribution[]>(referenceContributions);
  const [potBalance] = useState(175000);

  return (
    <main className="min-h-screen w-full bg-[#120D0A] flex flex-col items-center justify-center sm:py-6 antialiased selection:bg-amber-500 selection:text-coffee-950">
      {/* Mobile Shell Frame: Native 100% on phone, sleek mobile canvas on desktop */}
      <div className="w-full max-w-[396px] bg-[#FAF6F0] h-[100dvh] sm:h-[844px] flex flex-col relative overflow-hidden sm:rounded-[48px] sm:border-[8px] sm:border-[#261E1A] sm:shadow-[0_25px_80px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.08)]">
        {/* Dark Ethiopian Coffee Header with Embroidery, Meskel Cross & Audio Plaque */}
        <Header
          onOpenDigest={() => setIsDigestModalOpen(true)}
          isPlayingAudio={isDigestModalOpen}
        />

        {/* Scrollable Main Content Area */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar">
          {/* Floating Stitched Leather Debter Card with Mesob & Carousel Peek.
              The card says "ቀጣይ እጣ" (next draw), so tapping it goes to the draw
              engine. It used to open the audio digest, which is a placeholder
              for a different feature — A3 R-4. */}
          <DebterCard potBalance={potBalance} onDrawClick={() => router.push("/draw")} />

          <WorkspaceLinks />

          {/* Member contributions on Parchment */}
          <ContributionFeed contributions={contributions} />
        </div>

        {/* Curved Dark Espresso Voice Navigation Bar */}
        <BottomVoiceNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onVoiceClick={() => setIsVoiceModalOpen(true)}
        />

        {/* Spoken Voice Logging Modal.
            No `onRequestVerification` is wired yet: that handler must POST to
            /api/bank-verifications, which requires a signed-in treasurer with a
            bound account. Until it exists the submit control stays disabled and
            says why — better than a local success that fabricates a verified
            balance. See board task #14. */}
        <VoiceModal isOpen={isVoiceModalOpen} onClose={() => setIsVoiceModalOpen(false)} />

        {/* Spoken Audio Balance Sheet Modal (Voxide TTS Digest) */}
        <AudioDigestModal
          isOpen={isDigestModalOpen}
          onClose={() => setIsDigestModalOpen(false)}
          potBalance={potBalance}
        />
      </div>
    </main>
  );
}
