"use client";

import React, { useState } from "react";
import { Header } from "@/components/shell/Header";
import { DebterCard } from "@/components/treasury/DebterCard";
import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";
import { BottomVoiceNav } from "@/components/navigation/BottomVoiceNav";
import { VoiceModal } from "@/components/voice/VoiceModal";
import { AudioDigestModal } from "@/components/voice/AudioDigestModal";

const referenceContributions: MemberContribution[] = [
  {
    id: "1",
    name: "Ethiopian elders, Members",
    avatar: "/avatars/elder_photo.png",
    secondaryAvatar: "/avatars/man_photo.png",
    telebirrVerified: true,
    cbeVerified: true,
    transactionId: "C0970153",
  },
  {
    id: "2",
    name: "Gabi Member",
    avatar: "/avatars/woman_photo.png",
    telebirrVerified: true,
    cbeVerified: true,
    transactionId: "C0370320",
  },
];

export default function SenedHome() {
  const [activeTab, setActiveTab] = useState<"home" | "ledger" | "members" | "profile">("home");
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  const [isDigestModalOpen, setIsDigestModalOpen] = useState(false);

  const [contributions, setContributions] = useState<MemberContribution[]>(referenceContributions);
  const [potBalance, setPotBalance] = useState(175000);

  const handleAddContribution = (newEntry: {
    name: string;
    amount: number;
    channel: "Telebirr" | "CBE Birr";
    txRef: string;
  }) => {
    const contribution: MemberContribution = {
      id: String(Date.now()),
      name: newEntry.name,
      avatar: "/avatars/elder_photo.png",
      telebirrVerified: newEntry.channel === "Telebirr",
      cbeVerified: newEntry.channel === "CBE Birr",
      transactionId: newEntry.txRef,
      amount: newEntry.amount,
    };

    setContributions([contribution, ...contributions]);
    setPotBalance((prev) => prev + newEntry.amount);
  };

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
          {/* Floating Stitched Leather Debter Card with Mesob & Carousel Peek */}
          <DebterCard
            potBalance={potBalance}
            onDrawClick={() => setIsDigestModalOpen(true)}
          />

          {/* Verified Member Contributions Section directly on Parchment */}
          <ContributionFeed
            contributions={contributions}
            onSelectMember={(c) => console.log("Selected member receipt:", c)}
          />
        </div>

        {/* Curved Dark Espresso Voice Navigation Bar */}
        <BottomVoiceNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onVoiceClick={() => setIsVoiceModalOpen(true)}
        />

        {/* Spoken Voice Logging Modal (Voxide STT + Links.et) */}
        <VoiceModal
          isOpen={isVoiceModalOpen}
          onClose={() => setIsVoiceModalOpen(false)}
          onAddContribution={handleAddContribution}
        />

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
