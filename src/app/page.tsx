"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";
import { DebterCard } from "@/components/treasury/DebterCard";
import {
  ContributionFeed,
  type MemberContribution,
  type PayerAttribution
} from "@/components/contributions/ContributionFeed";
import { BottomNav } from "@/components/navigation/BottomNav";
import { AppFrame } from "@/components/shell/AppFrame";
import { VoiceModal } from "@/components/voice/VoiceModal";
import { AudioDigestModal } from "@/components/voice/AudioDigestModal";
import { ProfilePanel } from "@/components/shell/ProfilePanel";
import { TabPanel } from "@/components/shell/TabPanel";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { useAppLocale } from "@/lib/appLocale";
import { OPEN_DIGEST_EVENT, OPEN_DRAFT_EVENT, type OpenDraftDetail } from "@/lib/voice/assistantBridge";
import { useSession } from "@/lib/auth/useSession";
import { attributePayer, supersedePayer } from "@/lib/ledger/clientAttribution";
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
    memberId: "sample-member-1",
    name: "አቶ በቀለ ገ",
    avatar: "/avatars/elder_photo.png",
    channel: "telebirr",
    transactionId: "C0970153",
    status: "PROVISIONAL"
  },
  {
    id: "2",
    memberId: "sample-member-2",
    name: "ወ/ሮ አልማዝ ተ",
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
  "choose-group": "home.live.chooseGroup",
  error: "home.live.error"
};

export default function SenedHome() {
  const router = useRouter();
  // The shell is Ge'ez-primary, so it opens in Amharic. It is also the first
  // surface to call `t()` rather than hard-coding literals, which the rest of
  // the Gen A tree still does.
  const [locale] = useAppLocale("am");
  const t = useMemo(() => createTranslator(locale), [locale]);
  // Signed in -> the voice flow POSTs to /api/bank-verifications. Anything else
  // (loading, unconfigured, signed out) keeps the on-device provisional path.
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [activeTab, setActiveTab] = useState<"home" | "profile">("home");
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
  const [isDigestModalOpen, setIsDigestModalOpen] = useState(false);
  // Text the voice assistant handed over for review in the existing draft modal.
  const [assistantDraft, setAssistantDraft] = useState<string | undefined>(undefined);

  // The voice assistant can ask this screen to open the digest or a draft for
  // review. It only opens existing UI; the person finishes with a tap.
  useEffect(() => {
    const openDigest = () => setIsDigestModalOpen(true);
    const openDraft = (event: Event) => {
      const detail = (event as CustomEvent<OpenDraftDetail>).detail;
      if (typeof detail?.utterance === "string" && detail.utterance.trim().length > 0) {
        setAssistantDraft(detail.utterance);
        setIsVoiceModalOpen(true);
      }
    };
    window.addEventListener(OPEN_DIGEST_EVENT, openDigest);
    window.addEventListener(OPEN_DRAFT_EVENT, openDraft);
    return () => {
      window.removeEventListener(OPEN_DIGEST_EVENT, openDigest);
      window.removeEventListener(OPEN_DRAFT_EVENT, openDraft);
    };
  }, []);

  // On-device spoken notes. They are provisional rows beside the feed and are
  // never added to the pot balance, which comes from the ledger (or the sample).
  const [localNotes, setLocalNotes] = useState<MemberContribution[]>([]);
  const home = useHomeLedger(session);
  const ledger = home.kind === "live" && home.result.status === "ready" ? home.result.summary : null;

  // Signed out shows the labelled sample; signed in shows the ledger or nothing.
  const memberLabels = home.kind === "live" && home.result.status === "ready" ? home.result.memberLabels : null;
  const memberAttire = home.kind === "live" && home.result.status === "ready" ? home.result.memberAttire ?? null : null;
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
          // No bank receipt. If the treasurer recorded who paid, say so, as the
          // treasurer's record: the row stays PROVISIONAL ("Recorded in ledger"),
          // gets no verified badge, and the payer line names its source.
          const recorded = contribution.attribution;
          if (recorded?.source === "treasurer") {
            const payerAttire = memberAttire?.[recorded.memberUserId];
            return {
              ...base,
              status: "PROVISIONAL" as const,
              memberId: recorded.memberUserId,
              ...(payerAttire === "gabi" || payerAttire === "netela" ? { attire: payerAttire } : {}),
              treasurerPayer: {
                memberId: recorded.memberUserId,
                memberLabel:
                  memberLabels?.[recorded.memberUserId] ?? t("members.anonymous", { id: recorded.memberUserId.slice(0, 8) }),
                revision: recorded.revision,
                recordedAtLabel: new Date(recorded.recordedAt).toLocaleString(locale === "am" ? "am-ET" : "en-US"),
                channel: recorded.channel ?? null,
                note: recorded.note ?? null
              }
            };
          }
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
          memberId: proof.memberUserId,
          // The payer's own choice, from the members read. `none` and unknown draw no shawl.
          ...(memberAttire?.[proof.memberUserId] === "gabi" || memberAttire?.[proof.memberUserId] === "netela"
            ? { attire: memberAttire[proof.memberUserId] as "gabi" | "netela" }
            : {}),
          ...(proof.referenceMasked ? { referenceMasked: proof.referenceMasked } : {}),
          memberLabel:
            memberLabels?.[proof.memberUserId] ?? t("members.anonymous", { id: proof.memberUserId.slice(0, 8) })
        };
      }),
    [ledger, memberLabels, memberAttire, t, locale]
  );
  // The owner's / treasurer's "attribute payer" action on a ledger row. Offered
  // only to them (the database refuses anyone else regardless).
  const liveReady = home.kind === "live" && home.result.status === "ready" ? home.result : null;
  const reloadHome = home.reload;
  const payerAttribution = useMemo<PayerAttribution | undefined>(() => {
    if (!liveReady || !liveReady.groupId || (liveReady.role !== "owner" && liveReady.role !== "treasurer")) {
      return undefined;
    }
    const groupId = liveReady.groupId;
    return {
      members: (liveReady.attributableMembers ?? []).map((member) => ({
        userId: member.userId,
        label: member.email ?? t("members.anonymous", { id: member.userId.slice(0, 8) })
      })),
      onAttribute: async ({ entryId, memberUserId, reason, channel, note }) => {
        const result =
          reason === undefined
            ? await attributePayer({
                groupId,
                entryId,
                memberUserId,
                ...(channel === undefined || channel === null ? {} : { channel }),
                ...(note === undefined || note === null ? {} : { note })
              })
            : await supersedePayer({
                groupId,
                entryId,
                memberUserId,
                reason,
                ...(channel === undefined ? {} : { channel }),
                ...(note === undefined ? {} : { note })
              });
        if (result.status === "ok") {
          reloadHome();
        }
        return result;
      }
    };
  }, [liveReady, reloadHome, t]);
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
    <AppFrame>
      {/* Dark Ethiopian header: diamond border, group name, gold listen pill */}
      <Header
        locale={locale}
        onOpenDigest={() => setIsDigestModalOpen(true)}
        isPlayingAudio={isDigestModalOpen}
      />

      {/* One column, top to bottom: balance, the one big action, the list, then the quiet links.
          The bottom padding keeps the last row clear of the navigation bar. */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-8">
        <div className="space-y-4">
          {notice !== null && (
            <p
              role={home.kind === "live" && home.result.status !== "empty" && home.result.status !== "ready" ? "alert" : "status"}
              className="mx-4 mt-9 rounded-2xl border border-dashed border-[#A9411D]/60 bg-[#FBEFE6] px-4 py-3 font-ethiopic text-[18px] font-semibold leading-[1.65] text-[#6E3414]"
            >
              {notice}
            </p>
          )}
          <div className={notice !== null ? "[&>div]:pt-0" : ""}>
            <DebterCard potBalance={potBalance} onDrawClick={() => router.push("/draw")} />
          </div>

          {/* The one thing people do most: say a contribution out loud. */}
          <div className="px-4">
            <button
              type="button"
              onClick={() => setIsVoiceModalOpen(true)}
              className="flex min-h-[76px] w-full items-center gap-4 rounded-2xl border-2 border-[#F3C769]/70 bg-gradient-to-b from-[#B84A22] to-[#8F2D12] px-4 py-3 text-left text-white shadow-[0_10px_22px_rgba(143,45,18,0.35)] transition-transform active:scale-[0.98] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
            >
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1A1412] ring-2 ring-[#F3C769]">
                <Mic className="h-7 w-7 text-[#F3C769]" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block font-ethiopic text-[22px] font-bold leading-snug">{t("shell.nav.voiceAria")}</span>
                <span className="block font-ethiopic text-[18px] leading-snug text-[#FFE9DA]">{t("home.speak.hint")}</span>
              </span>
            </button>
          </div>

          {/* Owner / treasurer only (the same gate as "attribute payer"): a quick way in
              to the record-contribution form on the ledger page. */}
          {payerAttribution ? (
            <p className="px-4">
              <Link
                href="/ledger#record-contribution"
                data-testid="home-record-contribution"
                className="flex min-h-[64px] w-full flex-col justify-center rounded-2xl border border-[#A9411D]/50 bg-[#FBEFE6] px-4 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                <span className="font-ethiopic text-[18px] font-bold leading-snug text-[#6E3414]">{t("home.record.cta")}</span>
                <span className="font-ethiopic text-base leading-snug text-[#4F4137]">{t("home.record.ctaHelp")}</span>
              </Link>
            </p>
          ) : null}

          <ContributionFeed contributions={contributions} locale={locale} attribution={payerAttribution} />

          <WorkspaceLinks locale={locale} />

          <p className="px-4 text-center">
            <Link
              href="/sign-in"
              className="inline-flex min-h-12 items-center px-4 font-ethiopic text-[18px] font-bold text-[#6E3414] underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
            >
              {signedIn ? t("auth.linkSignedIn") : t("auth.link")}
            </Link>
          </p>
        </div>
      </div>

      {/* The one navigation: four places, each with its name under its icon. */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} locale={locale} />

        {activeTab === "profile" && signedIn && (
          <ProfilePanel onBack={() => setActiveTab("home")} locale={locale} />
        )}
        {activeTab !== "home" && !(activeTab === "profile" && signedIn) && (
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
          onClose={() => {
            setIsVoiceModalOpen(false);
            setAssistantDraft(undefined);
          }}
          initialTyped={assistantDraft}
          locale={locale}
          onRequestVerification={signedIn ? requestBankVerification : undefined}
          onRecordLocally={signedIn ? undefined : recordVoiceNoteLocally}
        />

        {/* Spoken Audio Balance Sheet Modal (spoken digest) */}
        <AudioDigestModal
          isOpen={isDigestModalOpen}
          onClose={() => setIsDigestModalOpen(false)}
          potBalance={potBalance}
          locale={locale}
          isSample={home.kind === "sample"}
          contributedCount={home.kind === "sample" ? SAMPLE_CONTRIBUTED_COUNT : undefined}
          totalMembers={home.kind === "sample" ? SAMPLE_TOTAL_MEMBERS : undefined}
        />
    </AppFrame>
  );
}
