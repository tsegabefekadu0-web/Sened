"use client";

import React, { useMemo, useState } from "react";
import Image from "next/image";
import { Check, Clock, FileText, ShieldCheck, X } from "lucide-react";

import { MemberAvatar } from "@/components/cultural/MemberAvatar";
import { isMaskedReference } from "@/lib/banking/referenceMask";
import type { MemberAttire } from "@/lib/memberAvatarStyle";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import type { AttributeResult } from "@/lib/ledger/clientAttribution";
import { formatEtbGrouped } from "@/lib/ledger/money";
import {
  CONTRIBUTION_CHANNELS,
  CONTRIBUTION_NOTE_MAX,
  checkContributionNote,
  isBlankNote,
  isContributionChannel,
  type ContributionChannel
} from "@/lib/ledger/paymentChannel";

/**
 * A contribution's trust state.
 *
 * `VERIFIED` is a claim about a *bank*, not about a sentence somebody spoke.
 * AGENTWORK.md §12.3: a "Verified" badge must correspond to a real verification
 * result. So a row carries the state explicitly, and `VERIFIED` additionally
 * requires `verifiedBy` — the provider that actually answered. A row that says
 * `VERIFIED` with no provenance renders as provisional anyway; see `isVerified`.
 *
 * `channel` and `transactionId` are what a member *said*. They are never
 * evidence. Deriving a badge from them is what this component used to do.
 *
 * Every string comes from the shared dictionary in both languages. This file
 * used to hard-code Amharic and never call `t()`, which is a standing §12.6
 * violation on the first surface a reviewer sees.
 */
export type ContributionStatus = "PROVISIONAL" | "VERIFIED";

export interface MemberContribution {
  id: string;
  name: string;
  /** Absent when no photo is on record; the row draws a neutral placeholder. */
  avatar?: string;
  secondaryAvatar?: string;
  amount?: number;
  /**
   * A ledger amount in ETB with two decimals, shown as written. Preferred over
   * `amount`, which is a float and only for the on-device fixtures.
   */
  amountWire?: string;
  /**
   * `ledger` marks a row read from the group ledger. It is still not a bank
   * verification: only `status` plus `verifiedBy` earn the badge.
   */
  source?: "ledger";
  /** The rail the member named. A claim, not a confirmation. */
  channel?: ContributionChannel;
  /** A bank reference, when one was read out. A claim, not a confirmation. */
  transactionId?: string;
  status: ContributionStatus;
  /** Required for `VERIFIED`: the provider that actually returned the result. */
  verifiedBy?: string;
  /** Required for `VERIFIED`: when that provider answered. */
  verifiedAt?: string;
  /**
   * Who paid, from the verification's own user. Shown only on a verified row:
   * naming a payer for an unverified one would be a claim nothing backs.
   */
  memberLabel?: string;
  /**
   * The paying member's opaque id, from the verification's own user. Seeds the
   * avatar's Tibeb frame (deterministic, never derived from `name`). Absent when
   * the payer is unknown: the neutral default frame is drawn.
   */
  memberId?: string;
  /** The shawl this member chose for their avatar. No profile field exists yet, so nothing sets it today. */
  attire?: MemberAttire;
  /**
   * Masked bank reference (`••••2F42`) from the verification. Shown on the
   * verified badge only, and only if it is exactly the masked shape.
   */
  referenceMasked?: string;
  /**
   * Who the TREASURER recorded as the payer of a row that has no bank
   * verification (cash, a manual entry). It is the treasurer's own record: the row
   * stays "Recorded in ledger", the payer is labelled as recorded by the
   * treasurer, and it never earns the verified badge or the verified "Paid by"
   * line. Bank provenance wins, so a verified row never carries this.
   */
  treasurerPayer?: {
    readonly memberId: string;
    readonly memberLabel: string;
    /** How many records the entry's history holds (1 = never corrected). */
    readonly revision: number;
    readonly recordedAtLabel: string;
    /** How it was paid, in the treasurer's words (not a verification). Absent or `null` = not said. */
    readonly channel?: ContributionChannel | null;
    /**
     * The treasurer's plain-text note. Rendered ONLY as text (React escapes it); it is
     * never interpreted as markup, and a verified row never shows it.
     */
    readonly note?: string | null;
  };
}

/**
 * The owner's / treasurer's "attribute payer" action on a ledger row. Absent for
 * everyone else, so a plain member sees no control (and the database refuses them
 * regardless).
 */
export interface PayerAttribution {
  /** Members who can be named as the payer: the group's active members. */
  readonly members: readonly { readonly userId: string; readonly label: string }[];
  /**
   * `reason` is sent only when correcting an existing record. `channel` and `note` are
   * sent only when there is something to say: on a first record, when given; on a
   * correction, when CHANGED (`null` clears, a value sets, absent keeps). Resolves to
   * the call's outcome.
   */
  readonly onAttribute: (input: {
    readonly entryId: string;
    readonly memberUserId: string;
    readonly reason?: string;
    readonly channel?: ContributionChannel | null;
    readonly note?: string | null;
  }) => Promise<AttributeResult>;
}

const ATTIRE_KEY: Readonly<Record<MemberAttire, string>> = {
  gabi: "shell.feed.attireGabi",
  netela: "shell.feed.attireNetela"
};

const CHANNEL_KEY: Readonly<Record<ContributionChannel, string>> = {
  telebirr: "shell.feed.channelTelebirr",
  cbe: "shell.feed.channelCbe",
  awash: "shell.feed.channelAwash",
  cash: "shell.feed.channelCash",
  other: "shell.feed.channelOther"
};

/**
 * The channel to show for a row. A verified row shows the provider that answered; any
 * other ledger row shows the treasurer's recorded channel (which is their word, shown
 * as plain text beside the "recorded by the treasurer" label, never as a badge).
 */
function shownChannel(contribution: MemberContribution): ContributionChannel | undefined {
  if (isVerified(contribution)) {
    return contribution.channel;
  }
  return contribution.treasurerPayer?.channel ?? contribution.channel;
}

/** The note to show, only for a row that is not bank-verified. */
function shownNote(contribution: MemberContribution): string | null {
  return !isVerified(contribution) && contribution.treasurerPayer?.note ? contribution.treasurerPayer.note : null;
}

/**
 * Fail closed in the view.
 *
 * The type says a verified row carries provenance; this is where a row that
 * lies about it is caught. Rendering the badge from the status alone would put
 * the trust decision back in the hands of whoever assembled the array.
 */
function isVerified(contribution: MemberContribution): boolean {
  return (
    contribution.status === "VERIFIED" &&
    typeof contribution.verifiedBy === "string" &&
    contribution.verifiedBy.trim().length > 0
  );
}

/** The masked reference to show: only on a verified row, and only in the masked shape. */
function shownReference(contribution: MemberContribution): string | null {
  return isVerified(contribution) && isMaskedReference(contribution.referenceMasked) ? contribution.referenceMasked : null;
}

/** The message key for each way recording a payer can fail. */
function attributeErrorKey(result: Exclude<AttributeResult, { status: "ok" }>): MessageKey {
  switch (result.status) {
    case "refused":
      return `shell.feed.attribute.error.${result.code}` as MessageKey;
    case "forbidden":
      return "shell.feed.attribute.error.forbidden";
    case "unauthorized":
      return "shell.feed.attribute.error.unauthorized";
    case "rate-limited":
      return "shell.feed.attribute.error.rate_limited";
    case "error":
      return "shell.feed.attribute.error.error";
  }
}

export function ContributionFeed({
  contributions = [],
  onSelectMember,
  locale = "am",
  attribution
}: {
  contributions?: MemberContribution[];
  onSelectMember?: (c: MemberContribution) => void;
  locale?: Locale;
  attribution?: PayerAttribution;
}) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MemberContribution | null>(null);
  const [payerChoice, setPayerChoice] = useState("");
  const [payerReason, setPayerReason] = useState("");
  const [payerChannel, setPayerChannel] = useState<ContributionChannel | "">("");
  const [payerNote, setPayerNote] = useState("");
  const [payerBusy, setPayerBusy] = useState(false);
  const [payerMessage, setPayerMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);

  // The open row is read from the current list, so a re-read that records a payer
  // updates the open detail; the snapshot is only for a row that left the list.
  const selected = selectedId === null ? null : (contributions.find((entry) => entry.id === selectedId) ?? snapshot);
  const setSelected = (next: MemberContribution | null) => {
    setSelectedId(next?.id ?? null);
    setSnapshot(next);
    setPayerChoice("");
    setPayerReason("");
    // A correction starts from what is recorded, so changing one thing keeps the rest.
    setPayerChannel(next?.treasurerPayer?.channel ?? "");
    setPayerNote(next?.treasurerPayer?.note ?? "");
    setPayerMessage(null);
  };

  const openReceipt = (contribution: MemberContribution) => {
    onSelectMember?.(contribution);
    setSelected(contribution);
  };

  const submitPayer = async (entry: MemberContribution) => {
    if (!attribution || payerBusy) return;
    const correcting = entry.treasurerPayer !== undefined;
    const currentChannel = entry.treasurerPayer?.channel ?? "";
    const currentNote = entry.treasurerPayer?.note ?? "";
    const channelChanged = payerChannel !== currentChannel;
    const noteChanged = payerNote.trim() !== currentNote;
    // Correcting only how it was paid, or only the note: the payer stays as recorded.
    const memberUserId = payerChoice !== "" ? payerChoice : correcting && (channelChanged || noteChanged) ? entry.treasurerPayer!.memberId : "";
    if (memberUserId === "") {
      setPayerMessage({ ok: false, text: t("shell.feed.attribute.pickMember") });
      return;
    }
    let cleanNote: string | null = null;
    if (!isBlankNote(payerNote)) {
      const checked = checkContributionNote(payerNote);
      if (!checked.ok) {
        setPayerMessage({ ok: false, text: t("shell.feed.attribute.noteError") });
        return;
      }
      cleanNote = checked.note;
    }
    const reason = payerReason.trim();
    if (correcting && reason.length < 10) {
      setPayerMessage({ ok: false, text: t("shell.feed.attribute.reasonLabel") });
      return;
    }
    const channelValue: ContributionChannel | null = payerChannel === "" ? null : payerChannel;
    setPayerBusy(true);
    setPayerMessage(null);
    const result = await attribution.onAttribute({
      entryId: entry.id,
      memberUserId,
      ...(correcting
        ? {
            reason,
            ...(channelChanged ? { channel: channelValue } : {}),
            ...(noteChanged ? { note: cleanNote } : {})
          }
        : {
            ...(channelValue === null ? {} : { channel: channelValue }),
            ...(cleanNote === null ? {} : { note: cleanNote })
          })
    });
    setPayerBusy(false);
    if (result.status === "ok") {
      setPayerChoice("");
      setPayerReason("");
      setPayerMessage({ ok: true, text: t("shell.feed.attribute.done") });
    } else {
      setPayerMessage({ ok: false, text: t(attributeErrorKey(result)) });
    }
  };

  const channelLabel = (contribution: MemberContribution): string => {
    const channel = shownChannel(contribution);
    return channel ? t(CHANNEL_KEY[channel] as never) : t("shell.feed.channelNone");
  };

  return (
    <section className="w-full select-none px-4 pb-6 pt-4">
      {/* Section Title */}
      <h3 className="mb-3 px-0.5 font-ethiopic text-[20px] font-bold leading-snug text-[#140E0A]">
        {t("shell.feed.title")}
      </h3>

      {contributions.length === 0 ? (
        // §12.7: an honest empty state. This used to fall back to two fixture
        // rows carrying bank badges nobody verified.
        <div className="rounded-2xl border border-dashed border-[#D9C8B5] bg-[#F3ECE2] px-4 py-8 text-center">
          <p className="text-base font-semibold text-[#4F4137]">{t("shell.feed.empty")}</p>
          <p className="mt-1 text-base leading-relaxed text-[#4F4137]">
            {t("shell.feed.emptyBody")}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {contributions.map((c) => {
            const verified = isVerified(c);
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-label={t("feed.row.aria", {
                  name: c.name,
                  status: verified
                    ? `${channelLabel(c)} ${t("shell.feed.verifiedWord")}`
                    : c.source === "ledger"
                      ? t("shell.feed.recorded")
                      : t("shell.feed.pending")
                })}
                onClick={() => openReceipt(c)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openReceipt(c);
                  }
                }}
                className="group flex min-h-[88px] cursor-pointer items-center justify-between gap-3.5 rounded-2xl bg-white/70 px-3 py-3 transition-transform active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                {/* Left: portrait in a Tibeb border (frame chosen from the member id) */}
                <MemberAvatar
                  memberId={c.memberId}
                  name={c.name}
                  photo={c.avatar}
                  attire={c.attire}
                  attireLabel={c.attire ? t(ATTIRE_KEY[c.attire] as never) : undefined}
                />

                {/* Middle: Trust badge + Name + Reference */}
                <div className="flex-1 min-w-0 pr-1">
                  {verified ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#138A4B] text-white text-base font-semibold shadow-xs">
                      <Check className="w-3 h-3 stroke-[3]" />
                      <span>{channelLabel(c)}</span>{" "}
                      <span>{t("shell.feed.verifiedWord")}</span>
                      {shownReference(c) ? (
                        <>
                          {" "}
                          <span aria-hidden="true">·</span>{" "}
                          {/* Bullets read badly aloud, so the visible mask is hidden from
                              assistive tech and a plain-text equivalent is offered instead. */}
                          <span className="font-mono tracking-tight" data-testid="feed-reference-masked" aria-hidden="true">
                            {shownReference(c)}
                          </span>{" "}
                          <span className="sr-only">
                            {t("shell.feed.referenceEnding", { last: shownReference(c)!.replace(/^\u2022+/, "") })}
                          </span>
                        </>
                      ) : null}
                    </span>
                  ) : c.source === "ledger" ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#E8D9BE] text-[#6B5433] text-base font-semibold">
                      <FileText className="w-3 h-3 stroke-[3]" />
                      {t("shell.feed.recorded")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#E8D9BE] text-[#6B5433] text-base font-semibold">
                      <Clock className="w-3 h-3 stroke-[3]" />
                      {t("shell.feed.pending")}
                    </span>
                  )}

                  <h4 className="mt-1 font-ethiopic text-[18px] font-bold leading-snug text-[#140E0A]">
                    {c.name}
                  </h4>

                  {verified && c.memberLabel ? (
                    <p className="text-base font-semibold text-[#4A3B32] mt-0.5 font-sans" data-testid="feed-paid-by">
                      {t("shell.feed.paidBy")}: {c.memberLabel}
                    </p>
                  ) : null}

                  {/* The treasurer's own record of who paid an entry with no bank
                      verification. Labelled as such and never styled as verified. */}
                  {!verified && c.treasurerPayer ? (
                    <p
                      className="text-base font-semibold text-[#6B5433] mt-0.5 font-sans"
                      data-testid="feed-paid-by-treasurer"
                    >
                      {t("shell.feed.paidBy")}: {c.treasurerPayer.memberLabel} · {t("shell.feed.recordedByTreasurer")}
                    </p>
                  ) : null}

                  {!verified && c.treasurerPayer && (shownChannel(c) || shownNote(c)) ? (
                    <p className="text-base font-normal text-[#6B5433] mt-0.5 font-sans" data-testid="feed-channel-note">
                      {shownChannel(c) ? <span data-testid="feed-channel">{channelLabel(c)}</span> : null}
                      {shownChannel(c) && shownNote(c) ? " · " : null}
                      {shownNote(c) ? <span data-testid="feed-note">{shownNote(c)}</span> : null}
                    </p>
                  ) : null}

                  <p className="text-base font-normal text-[#4F4137] mt-0.5 font-sans">
                    {c.transactionId
                      ? `${t("shell.feed.reference")}: ${c.transactionId}`
                      : t("shell.feed.noReference")}
                  </p>
                </div>

                {/* Right: Secondary Avatar (as featured in Row 1 of reference) */}
                {c.secondaryAvatar ? (
                  <div className="relative w-[70px] h-[76px] rounded-[16px] overflow-hidden shrink-0 shadow-sm border border-[#DECDBB] bg-[#EFE6D9]">
                    <Image
                      src={c.secondaryAvatar}
                      alt={`${c.name}: ${t("shell.feed.secondaryAvatarAlt")}`}
                      fill
                      sizes="70px"
                      className="object-cover"
                      priority
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Contribution detail. The header states the trust state and nothing
          more: there is no verifier name and no latency to show unless a
          provider actually returned one. */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-[28px] bg-[#FAF7F2] border border-[#D9C8B5] p-5 shadow-2xl relative select-text">
            <button
              onClick={() => setSelected(null)}
              className="absolute right-3 top-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#EAE0D3] text-[#4A3B32] transition-all hover:bg-[#DDCFBF]"
              aria-label={t("shell.feed.close")}
            >
              <X className="h-6 w-6" aria-hidden="true" />
            </button>

            <div
              className={`flex items-center gap-2 mb-3 ${isVerified(selected) ? "text-[#138A4B]" : "text-[#6B5433]"}`}
            >
              {isVerified(selected) ? (
                <ShieldCheck className="w-5 h-5 stroke-[2.5]" />
              ) : (
                <Clock className="w-5 h-5 stroke-[2.5]" />
              )}
              <span className="text-base font-bold  ">
                {isVerified(selected)
                  ? t("shell.feed.verifiedTitle")
                  : selected.source === "ledger"
                    ? t("shell.feed.ledgerEntryTitle")
                    : t("shell.feed.unverifiedTitle")}
              </span>
            </div>

            <h3 className="font-ethiopic text-[22px] font-bold leading-snug text-[#1F1714]">{selected.name}</h3>
            <p className="text-2xl font-extrabold text-[#1F1714] mt-1 font-sans">
              {selected.amountWire !== undefined
                ? `${formatEtbGrouped(selected.amountWire)} ${t("shell.debter.currency")}`
                : typeof selected.amount === "number"
                  ? `${selected.amount.toLocaleString(locale === "am" ? "am-ET" : "en-US")} ብር`
                  : "—"}
            </p>

            <div className="mt-4 pt-3 border-t border-[#E5DACD] space-y-2 text-base">
              <div className="flex justify-between gap-4">
                <span className="text-[#4F4137]">{t("shell.feed.channel")}:</span>
                <span className="font-semibold text-[#1F1714] text-right">
                  {channelLabel(selected)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[#4F4137]">{t("shell.feed.reference")}:</span>
                <span className="font-mono font-semibold text-[#1F1714] text-right break-all">
                  {shownReference(selected) ?? selected.transactionId ?? "—"}
                </span>
              </div>
              {isVerified(selected) ? (
                <>
                  {selected.memberLabel ? (
                    <div className="flex justify-between gap-4">
                      <span className="text-[#4F4137]">{t("shell.feed.paidBy")}:</span>
                      <span className="font-semibold text-[#1F1714] text-right break-all">{selected.memberLabel}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-4">
                    <span className="text-[#4F4137]">{t("shell.feed.verifiedBy")}:</span>
                    <span className="font-semibold text-[#138A4B] text-right break-all">
                      {selected.verifiedBy}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[#4F4137]">{t("shell.feed.verifiedAt")}:</span>
                    <span className="font-semibold text-[#1F1714] text-right">
                      {selected.verifiedAt ?? "—"}
                    </span>
                  </div>
                  {selected.source === "ledger" ? (
                    <p className="pt-1 leading-relaxed text-[#6B5433]">{t("shell.feed.verifiedLedgerNote")}</p>
                  ) : null}
                </>
              ) : (
                <>
                  {selected.treasurerPayer ? (
                    <div data-testid="feed-treasurer-payer" className="space-y-2">
                      <div className="flex justify-between gap-4">
                        <span className="text-[#4F4137]">{t("shell.feed.paidBy")}:</span>
                        <span className="font-semibold text-[#1F1714] text-right break-all">{selected.treasurerPayer.memberLabel}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-[#4F4137]">{t("shell.feed.treasurerRecordedAt")}:</span>
                        <span className="font-semibold text-[#6B5433] text-right">
                          {t("shell.feed.recordedByTreasurer")} · {selected.treasurerPayer.recordedAtLabel}
                        </span>
                      </div>
                      {shownNote(selected) ? (
                        <div className="flex justify-between gap-4">
                          <span className="text-[#4F4137]">{t("shell.feed.note")}:</span>
                          <span className="font-semibold text-[#1F1714] text-right break-words" data-testid="feed-detail-note">
                            {shownNote(selected)}
                          </span>
                        </div>
                      ) : null}
                      <p className="leading-relaxed text-[#6B5433]">{t("shell.feed.treasurerPayerNote")}</p>
                      {selected.treasurerPayer.revision > 1 ? (
                        <p className="leading-relaxed text-[#6B5433]">
                          {t("shell.feed.treasurerRevision", { count: selected.treasurerPayer.revision - 1 })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="pt-1 leading-relaxed text-[#6B5433]">
                    {selected.source === "ledger" ? t("shell.feed.ledgerEntryNote") : t("shell.feed.notAContribution")}
                  </p>
                </>
              )}
            </div>

            {/* Owner / treasurer only, and only for a ledger row that no bank
                receipt names (a verified row's payer cannot be overridden). */}
            {attribution && selected.source === "ledger" && !isVerified(selected) ? (
              <div className="mt-4 pt-3 border-t border-[#E5DACD] text-base" data-testid="feed-attribute-payer">
                <p className="font-bold text-[#1F1714]">
                  {selected.treasurerPayer ? t("shell.feed.attribute.correctTitle") : t("shell.feed.attribute.title")}
                </p>
                <p className="mt-1 leading-relaxed text-[#6B5433]">
                  {selected.treasurerPayer ? t("shell.feed.attribute.correctHelp") : t("shell.feed.attribute.help")}
                </p>
                <label className="mt-2 block">
                  <span className="text-[#4F4137]">{t("shell.feed.attribute.memberLabel")}</span>
                  <select
                    data-testid="feed-attribute-member"
                    value={payerChoice}
                    onChange={(event) => setPayerChoice(event.target.value)}
                    className="mt-1 w-full min-h-12 rounded-lg border border-[#D9C8B5] bg-white px-3 py-2 text-base text-[#1F1714]"
                  >
                    <option value="">{t("shell.feed.attribute.choose")}</option>
                    {attribution.members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-2 block">
                  <span className="text-[#4F4137]">{t("shell.feed.attribute.channelLabel")}</span>
                  <select
                    data-testid="feed-attribute-channel"
                    value={payerChannel}
                    onChange={(event) => setPayerChannel(isContributionChannel(event.target.value) ? event.target.value : "")}
                    className="mt-1 w-full min-h-12 rounded-lg border border-[#D9C8B5] bg-white px-3 py-2 text-base text-[#1F1714]"
                  >
                    <option value="">{t("shell.feed.channelNone")}</option>
                    {CONTRIBUTION_CHANNELS.map((option) => (
                      <option key={option} value={option}>
                        {t(CHANNEL_KEY[option] as never)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-2 block">
                  <span className="text-[#4F4137]">{t("shell.feed.attribute.noteLabel")}</span>
                  <input
                    type="text"
                    data-testid="feed-attribute-note"
                    value={payerNote}
                    onChange={(event) => setPayerNote(event.target.value)}
                    maxLength={CONTRIBUTION_NOTE_MAX * 2}
                    autoComplete="off"
                    className="mt-1 w-full min-h-12 rounded-lg border border-[#D9C8B5] bg-white px-3 py-2 text-base text-[#1F1714]"
                  />
                  <span className="mt-1 block text-base leading-relaxed text-[#6B5433]">{t("shell.feed.attribute.noteHelp")}</span>
                </label>
                {selected.treasurerPayer ? (
                  <label className="mt-2 block">
                    <span className="text-[#4F4137]">{t("shell.feed.attribute.reasonLabel")}</span>
                    <textarea
                      data-testid="feed-attribute-reason"
                      value={payerReason}
                      onChange={(event) => setPayerReason(event.target.value)}
                      rows={2}
                      maxLength={1000}
                      className="mt-1 w-full min-h-12 rounded-lg border border-[#D9C8B5] bg-white px-3 py-2 text-base text-[#1F1714]"
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  data-testid="feed-attribute-submit"
                  disabled={payerBusy}
                  onClick={() => void submitPayer(selected)}
                  className="mt-3 min-h-12 w-full py-2 rounded-xl bg-[#6B5433] text-[#FAF7F2] font-semibold text-base disabled:opacity-60"
                >
                  {payerBusy
                    ? t("shell.feed.attribute.saving")
                    : selected.treasurerPayer
                      ? t("shell.feed.attribute.correctSubmit")
                      : t("shell.feed.attribute.submit")}
                </button>
                {payerMessage ? (
                  <p
                    role={payerMessage.ok ? "status" : "alert"}
                    data-testid="feed-attribute-message"
                    className={`mt-2 leading-relaxed ${payerMessage.ok ? "text-[#138A4B]" : "text-[#9A3412]"}`}
                  >
                    {payerMessage.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            <button
              onClick={() => setSelected(null)}
              className="mt-5 min-h-12 w-full py-2.5 rounded-xl bg-[#2A1F1A] text-[#FAF7F2] font-semibold text-base hover:bg-[#3D2E27] active:scale-[0.98] transition-all"
            >
              {t("shell.feed.close")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
