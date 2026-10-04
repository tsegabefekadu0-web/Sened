"use client";

import React, { useMemo, useState } from "react";
import Image from "next/image";
import { Check, Clock, FileText, ShieldCheck, X } from "lucide-react";

import { MemberAvatar } from "@/components/cultural/MemberAvatar";
import { isMaskedReference } from "@/lib/banking/referenceMask";
import type { MemberAttire } from "@/lib/memberAvatarStyle";
import { createTranslator, type Locale } from "@/lib/i18n";
import { formatEtbGrouped } from "@/lib/ledger/money";

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
  channel?: "telebirr" | "cbe" | "awash" | "cash";
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
}

const ATTIRE_KEY: Readonly<Record<MemberAttire, string>> = {
  gabi: "shell.feed.attireGabi",
  netela: "shell.feed.attireNetela"
};

const CHANNEL_KEY: Readonly<Record<NonNullable<MemberContribution["channel"]>, string>> = {
  telebirr: "shell.feed.channelTelebirr",
  cbe: "shell.feed.channelCbe",
  awash: "shell.feed.channelAwash",
  cash: "shell.feed.channelCash"
};

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

export function ContributionFeed({
  contributions = [],
  onSelectMember,
  locale = "am"
}: {
  contributions?: MemberContribution[];
  onSelectMember?: (c: MemberContribution) => void;
  locale?: Locale;
}) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [selected, setSelected] = useState<MemberContribution | null>(null);

  const openReceipt = (contribution: MemberContribution) => {
    onSelectMember?.(contribution);
    setSelected(contribution);
  };

  const channelLabel = (contribution: MemberContribution): string =>
    contribution.channel ? t(CHANNEL_KEY[contribution.channel] as never) : t("shell.feed.channelNone");

  return (
    <section className="w-full max-w-md md:max-w-none mx-auto px-4 md:px-0 pt-4 md:pt-2 pb-20 md:pb-8 select-none">
      {/* Section Title */}
      <h3 className="text-[17px] font-bold text-[#140E0A] tracking-tight mb-3.5 px-0.5 font-sans">
        {t("shell.feed.title")}
      </h3>

      {contributions.length === 0 ? (
        // §12.7: an honest empty state. This used to fall back to two fixture
        // rows carrying bank badges nobody verified.
        <div className="rounded-2xl border border-dashed border-[#D9C8B5] bg-[#F3ECE2] px-4 py-8 text-center">
          <p className="text-sm font-semibold text-[#5C4A3D]">{t("shell.feed.empty")}</p>
          <p className="mt-1 text-xs leading-relaxed text-[#8A7A6D]">
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
                onClick={() => openReceipt(c)}
                className="flex items-center justify-between gap-3.5 cursor-pointer group active:scale-[0.99] transition-transform"
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
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#138A4B] text-white text-[11px] font-semibold shadow-xs">
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
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#E8D9BE] text-[#6B5433] text-[11px] font-semibold">
                      <FileText className="w-3 h-3 stroke-[3]" />
                      {t("shell.feed.recorded")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#E8D9BE] text-[#6B5433] text-[11px] font-semibold">
                      <Clock className="w-3 h-3 stroke-[3]" />
                      {t("shell.feed.pending")}
                    </span>
                  )}

                  <h4 className="text-[15px] font-bold text-[#140E0A] leading-snug mt-1 truncate font-sans">
                    {c.name}
                  </h4>

                  {verified && c.memberLabel ? (
                    <p className="text-[12px] font-semibold text-[#4A3B32] mt-0.5 truncate font-sans" data-testid="feed-paid-by">
                      {t("shell.feed.paidBy")}: {c.memberLabel}
                    </p>
                  ) : null}

                  <p className="text-[12px] font-normal text-[#7D6F66] mt-0.5 truncate font-sans">
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
                      alt={`${c.name} — ${t("shell.feed.secondaryAvatarAlt")}`}
                      fill
                      sizes="70px"
                      className="object-cover"
                      priority
                    />
                  </div>
                ) : (
                  <div className="w-[70px] shrink-0" />
                )}
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
              className="absolute top-4 right-4 p-1.5 rounded-full bg-[#EAE0D3] text-[#4A3B32] hover:bg-[#DDCFBF] transition-all"
              aria-label={t("shell.feed.close")}
            >
              <X className="w-4 h-4" />
            </button>

            <div
              className={`flex items-center gap-2 mb-3 ${isVerified(selected) ? "text-[#138A4B]" : "text-[#6B5433]"}`}
            >
              {isVerified(selected) ? (
                <ShieldCheck className="w-5 h-5 stroke-[2.5]" />
              ) : (
                <Clock className="w-5 h-5 stroke-[2.5]" />
              )}
              <span className="text-xs font-bold uppercase tracking-wider">
                {isVerified(selected)
                  ? t("shell.feed.verifiedTitle")
                  : selected.source === "ledger"
                    ? t("shell.feed.ledgerEntryTitle")
                    : t("shell.feed.unverifiedTitle")}
              </span>
            </div>

            <h3 className="text-lg font-bold text-[#1F1714]">{selected.name}</h3>
            <p className="text-2xl font-extrabold text-[#1F1714] mt-1 font-sans">
              {selected.amountWire !== undefined
                ? `${formatEtbGrouped(selected.amountWire)} ${t("shell.debter.currency")}`
                : typeof selected.amount === "number"
                  ? `${selected.amount.toLocaleString(locale === "am" ? "am-ET" : "en-US")} ብር`
                  : "—"}
            </p>

            <div className="mt-4 pt-3 border-t border-[#E5DACD] space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <span className="text-[#7A6B60]">{t("shell.feed.channel")}:</span>
                <span className="font-semibold text-[#1F1714] text-right">
                  {channelLabel(selected)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[#7A6B60]">{t("shell.feed.reference")}:</span>
                <span className="font-mono font-semibold text-[#1F1714] text-right break-all">
                  {shownReference(selected) ?? selected.transactionId ?? "—"}
                </span>
              </div>
              {isVerified(selected) ? (
                <>
                  {selected.memberLabel ? (
                    <div className="flex justify-between gap-4">
                      <span className="text-[#7A6B60]">{t("shell.feed.paidBy")}:</span>
                      <span className="font-semibold text-[#1F1714] text-right break-all">{selected.memberLabel}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-4">
                    <span className="text-[#7A6B60]">{t("shell.feed.verifiedBy")}:</span>
                    <span className="font-semibold text-[#138A4B] text-right break-all">
                      {selected.verifiedBy}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[#7A6B60]">{t("shell.feed.verifiedAt")}:</span>
                    <span className="font-semibold text-[#1F1714] text-right">
                      {selected.verifiedAt ?? "—"}
                    </span>
                  </div>
                  {selected.source === "ledger" ? (
                    <p className="pt-1 leading-relaxed text-[#6B5433]">{t("shell.feed.verifiedLedgerNote")}</p>
                  ) : null}
                </>
              ) : (
                <p className="pt-1 leading-relaxed text-[#6B5433]">
                  {selected.source === "ledger" ? t("shell.feed.ledgerEntryNote") : t("shell.feed.notAContribution")}
                </p>
              )}
            </div>

            <button
              onClick={() => setSelected(null)}
              className="w-full mt-5 py-2.5 rounded-xl bg-[#2A1F1A] text-[#FAF7F2] font-semibold text-sm hover:bg-[#3D2E27] active:scale-[0.98] transition-all"
            >
              {t("shell.feed.close")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
