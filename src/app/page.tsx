"use client";

import React, { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";
import { DebterCard } from "@/components/treasury/DebterCard";
import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";
import { BottomVoiceNav } from "@/components/navigation/BottomVoiceNav";
import { VoiceModal } from "@/components/voice/VoiceModal";
import { AudioDigestModal } from "@/components/voice/AudioDigestModal";
import { getSenedDatabase, isOfflineStorageAvailable } from "@/lib/db";
import { saveSpokenNote } from "@/lib/db/notes";
import type { PaymentChannel, SpokenNoteLocale } from "@/lib/db/types";
import type { ProvisionalContribution } from "@/lib/voice/types";

/**
 * The group this shell is looking at.
 *
 * A single treasury is signed in on one device at a time in this build, and the
 * roster arrives from the sync mirror. Until there is a session there is no
 * group to read, so the shell names one — and says so, rather than inventing
 * rows that would look like a synced roster.
 */
const LOCAL_GROUP_ID = "local-unprovisioned-group";

/** The parser's provider names map onto the offline store's rails one-for-one. */
const CHANNEL_FOR_PROVIDER: Readonly<Record<string, PaymentChannel>> = {
  telebirr: "telebirr",
  cbe: "cbe-birr",
  awash: "bank-transfer"
};

/**
 * The parser reports a *detection*, which can be "mixed" or "unknown". The store
 * wants one concrete locale, so an ambiguous detection is recorded as `am` —
 * this is a Ge'ez-primary product and the honest default is the language the
 * note is expected to be in, not a guess at what was said.
 */
const SPOKEN_NOTE_LOCALE_FOR: Readonly<Record<string, SpokenNoteLocale>> = {
  am: "am",
  om: "om",
  en: "en",
  mixed: "am",
  unknown: "am"
};

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

  const [contributions, setContributions] = useState<MemberContribution[]>(referenceContributions);
  const [potBalance] = useState(175000);

  /**
   * Record a spoken contribution on this device, as a provisional note.
   *
   * This is what the mic dock does now, and it is deliberately *not* a
   * verification. `/api/bank-verifications` needs a signed-in treasurer with a
   * bound account; during a Sunday meeting there is no session and often no
   * connection, so the only honest thing the shell can do with a parsed sentence
   * is keep it, label it provisional, and leave it for the sync queue.
   *
   * It goes into the same Dexie store as `/offline`, so there is one set of
   * notes rather than two, and the row is content-hashed by A4's own code.
   *
   * Two things it must never do: report success if the write failed, and touch
   * the pot balance as though the money had arrived. The pot is the sum of
   * *verified* contributions; adding a spoken one to it would make the ደብተር
   * lie in the same way the badge used to.
   */
  const recordVoiceNoteLocally = useCallback(
    async (
      draft: ProvisionalContribution,
      origin: { readonly transcriptSource: "human-typed" | "asr" }
    ) => {
      if (!isOfflineStorageAvailable()) {
        throw new Error("offline-storage-unavailable");
      }
      const note = await saveSpokenNote(getSenedDatabase(), {
        groupId: LOCAL_GROUP_ID,
        locale: SPOKEN_NOTE_LOCALE_FOR[draft.language] ?? "am",
        transcript: draft.utterance,
        // Stated by the caller, never inferred. A note labelled `asr` that was
        // actually typed is a false claim about how a treasurer worked.
        transcriptSource: origin.transcriptSource,
        amountEtb: draft.amountWire,
        channel: draft.provider ? CHANNEL_FOR_PROVIDER[draft.provider] ?? null : null,
        occurredAt: new Date().toISOString()
      });

      setContributions((previous) => [
        {
          id: note.id,
          name: "የተናገረ ልይል",
          avatar: "/avatars/elder_photo.png",
          amount: draft.amount ?? undefined,
          channel: draft.provider ?? undefined,
          transactionId: draft.txRef ?? undefined,
          status: "PROVISIONAL"
        },
        ...previous
      ]);
    },
    []
  );

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
            No `onRequestVerification` is wired: that handler must POST to
            /api/bank-verifications, which requires a signed-in treasurer with a
            bound account. Without it the primary action is a local provisional
            record — honest, and what a treasurer during a meeting actually has.
            See board task #14. */}
        <VoiceModal
          isOpen={isVoiceModalOpen}
          onClose={() => setIsVoiceModalOpen(false)}
          onRecordLocally={recordVoiceNoteLocally}
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
