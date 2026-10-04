"use client";

import React, { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";
import { DebterCard } from "@/components/treasury/DebterCard";
import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";
import { BottomVoiceNav } from "@/components/navigation/BottomVoiceNav";
import { VoiceModal } from "@/components/voice/VoiceModal";
import { AudioDigestModal } from "@/components/voice/AudioDigestModal";
import { TabPanel } from "@/components/shell/TabPanel";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { useSession } from "@/lib/auth/useSession";
import type { HomeLedgerResult } from "@/lib/ledger/clientHome";
import { useHomeLedger } from "@/lib/ledger/useHomeLedger";
import { requestBankVerification } from "@/lib/voice/clientVerify";
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

/**
 * The sample figures shown only when nobody is signed in, and labelled as such
 * on screen and in the spoken digest. They are not a group's numbers.
 */
const SAMPLE_POT_BALANCE = 175000;
const SAMPLE_CONTRIBUTED_COUNT = 17;
const SAMPLE_TOTAL_MEMBERS = 20;

const PROVIDER_LABEL_KEY = {
  telebirr: "shell.feed.channelTelebirr",
  cbe: "shell.feed.channelCbe",
  awash: "shell.feed.channelAwash"
} as const satisfies Record<"telebirr" | "cbe" | "awash", MessageKey>;

const LIVE_NOTICE_KEYS: Readonly<Record<Exclude<HomeLedgerResult["status"], "ready">, MessageKey>> = {
  empty: "home.live.empty",
  unauthorized: "home.live.unauthorized",
  "no-group": "home.live.noGroup",
  "multiple-groups": "home.live.multipleGroups",
  error: "home.live.error"
};

export default function SenedHome() {
  const router = useRouter();
  // The shell is Ge'ez-primary, so it opens in Amharic. It is also the first
  // surface to call `t()` rather than hard-coding literals, which the rest of
  // the Gen A tree still does.
  const [locale] = useState<Locale>("am");
  const t = useMemo(() => createTranslator(locale), [locale]);
  // Signed in -> the voice flow POSTs to /api/bank-verifications. Anything else
  // (loading, unconfigured, signed out) keeps the on-device provisional path.
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [activeTab, setActiveTab] = useState<"home" | "ledger" | "members" | "profile">("home");
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  const [isDigestModalOpen, setIsDigestModalOpen] = useState(false);

  // On-device spoken notes. They are provisional rows beside the feed and are
  // never added to the pot balance, which comes from the ledger (or the sample).
  const [localNotes, setLocalNotes] = useState<MemberContribution[]>([]);
  const home = useHomeLedger(session);
  const ledger = home.kind === "live" && home.result.status === "ready" ? home.result.summary : null;

  // Signed out shows the labelled sample; signed in shows the ledger or nothing.
  const memberLabels = home.kind === "live" && home.result.status === "ready" ? home.result.memberLabels : null;
  const ledgerRows = useMemo<MemberContribution[]>(
    () =>
      (ledger?.contributions ?? []).map((contribution) => {
        const base = {
          id: contribution.id,
          name: t("shell.feed.ledgerContribution", { sequence: contribution.sequence }),
          amountWire: contribution.amount,
          transactionId: `#${contribution.sequence}`,
          source: "ledger" as const
        };
        const proof = contribution.provenance;
        if (!proof) {
          return { ...base, status: "PROVISIONAL" as const };
        }
        // A verified bank receipt posted this entry. The badge's evidence is the
        // provider and the time it answered; the payer is the verification's
        // user, named the way the members screen names them (email only if the
        // members API showed it to this caller, else the anonymous label).
        const provider = t(PROVIDER_LABEL_KEY[proof.provider]);
        return {
          ...base,
          channel: proof.provider,
          status: "VERIFIED" as const,
          verifiedBy: provider,
          verifiedAt: new Date(proof.verifiedAt).toLocaleString(locale === "am" ? "am-ET" : "en-US"),
          memberLabel:
            memberLabels?.[proof.memberUserId] ?? t("members.anonymous", { id: proof.memberUserId.slice(0, 8) })
        };
      }),
    [ledger, memberLabels, t, locale]
  );
  const contributions = [
    ...localNotes,
    ...(home.kind === "sample" ? referenceContributions : ledgerRows)
  ];
  const potBalance: number | string | null =
    home.kind === "sample" ? SAMPLE_POT_BALANCE : home.kind === "live" && home.result.status === "empty" ? "0.00" : ledger?.potBalance ?? null;
  const notice: string | null =
    home.kind === "sample"
      ? t("home.sample.notice")
      : home.kind === "loading"
        ? t("home.live.loading")
        : home.result.status === "ready"
          ? home.result.feedTruncated
            ? t("home.live.feedTruncated")
            : null
          : t(LIVE_NOTICE_KEYS[home.result.status]);

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

      setLocalNotes((previous) => [
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
      {/* Responsive Shell Frame: Native 100% on phone, expansive premium dashboard canvas on desktop */}
      <div className="w-full md:max-w-5xl lg:max-w-6xl bg-[#FAF6F0] h-[100dvh] md:h-[92vh] md:min-h-[820px] md:max-h-[960px] flex flex-col relative overflow-hidden md:rounded-3xl md:border md:border-[#382B24]/50 md:shadow-[0_25px_80px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)]">
        {/* Dark Ethiopian Coffee Header with Embroidery, Meskel Cross & Audio Plaque */}
        <Header
          onOpenDigest={() => setIsDigestModalOpen(true)}
          isPlayingAudio={isDigestModalOpen}
        />

        {/* Main Content Area: Native vertical stream on mobile, 2-column responsive dashboard on desktop */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar">
          <div className="w-full md:grid md:grid-cols-12 md:gap-6 md:p-6 md:items-start max-w-5xl mx-auto">
            {/* Left Column on Desktop: Debter Treasury Card & Built Tools */}
            <div className="md:col-span-6 space-y-4">
              {notice !== null && (
                <p
                  role={home.kind === "live" && home.result.status !== "empty" && home.result.status !== "ready" ? "alert" : "status"}
                  className="mx-4 md:mx-0 mt-4 rounded-xl border border-dashed border-[#C6532B]/50 bg-[#FBEFE6] px-3 py-2 text-xs font-semibold leading-5 text-[#8A4B2A]"
                >
                  {notice}
                </p>
              )}
              <DebterCard potBalance={potBalance} onDrawClick={() => router.push("/draw")} />
              <WorkspaceLinks />
              <p className="px-4 md:px-0 text-center">
                <Link
                  href="/sign-in"
                  className="inline-flex min-h-11 items-center text-xs font-semibold text-[#8A4B2A] underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
                >
                  {signedIn ? t("auth.linkSignedIn") : t("auth.link")}
                </Link>
              </p>
            </div>

            {/* Right Column on Desktop: Member Contribution Feed */}
            <div className="md:col-span-6">
              <ContributionFeed contributions={contributions} />
            </div>
          </div>
        </div>

        {/* Curved Dark Espresso Voice Navigation Bar.
            The slots are real where a destination exists and say so plainly
            where one does not — see `TabPanel` below. */}
        <BottomVoiceNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onVoiceClick={() => setIsVoiceModalOpen(true)}
        />

        {activeTab !== "home" && (
          <TabPanel
            tab={activeTab}
            onBack={() => setActiveTab("home")}
            locale={locale}
          />
        )}

        {/* Spoken Voice Logging Modal.
            Signed in: the primary action POSTs to /api/bank-verifications with
            the session's Bearer token (`requestBankVerification`), and only a
            server VERIFIED counts. Signed out or unconfigured: the primary
            action is a local provisional record — honest, and what a treasurer
            during a meeting actually has. See board task #14 / O-1. */}
        <VoiceModal
          isOpen={isVoiceModalOpen}
          onClose={() => setIsVoiceModalOpen(false)}
          onRequestVerification={signedIn ? requestBankVerification : undefined}
          onRecordLocally={signedIn ? undefined : recordVoiceNoteLocally}
        />

        {/* Spoken Audio Balance Sheet Modal (Voxide TTS Digest) */}
        <AudioDigestModal
          isOpen={isDigestModalOpen}
          onClose={() => setIsDigestModalOpen(false)}
          potBalance={potBalance}
          isSample={home.kind === "sample"}
          contributedCount={home.kind === "sample" ? SAMPLE_CONTRIBUTED_COUNT : undefined}
          totalMembers={home.kind === "sample" ? SAMPLE_TOTAL_MEMBERS : undefined}
        />
      </div>
    </main>
  );
}
