"use client";

import React, { useState } from "react";
import Image from "next/image";
import { Check, Clock, ShieldCheck, X } from "lucide-react";

/**
 * A contribution's trust state.
 *
 * `VERIFIED` is a claim about a *bank*, not about a sentence somebody spoke.
 * AGENTWORK.md §12.3: a "Verified" badge must correspond to a real verification
 * result. So a row carries the state explicitly, and `VERIFIED` additionally
 * requires `verifiedBy` — the provider that actually answered. A row that says
 * `VERIFIED` with no provenance renders as provisional anyway; see
 * `isVerified` below.
 *
 * `channel` and `transactionId` are what a member *said*. They are never
 * evidence. Deriving a badge from them is what this component used to do.
 */
export type ContributionStatus = "PROVISIONAL" | "VERIFIED";

export interface MemberContribution {
  id: string;
  name: string;
  avatar: string;
  secondaryAvatar?: string;
  amount?: number;
  /** The rail the member named. A claim, not a confirmation. */
  channel?: "telebirr" | "cbe" | "awash" | "cash";
  /** A bank reference, when one was read out. A claim, not a confirmation. */
  transactionId?: string;
  status: ContributionStatus;
  /** Required for `VERIFIED`: the provider that actually returned the result. */
  verifiedBy?: string;
  /** Required for `VERIFIED`: when that provider answered. */
  verifiedAt?: string;
}

const CHANNEL_LABEL: Readonly<Record<NonNullable<MemberContribution["channel"]>, string>> = {
  telebirr: "ቴሌብር",
  cbe: "ሲቢኤ ብር",
  awash: "አዋሽ ባንክ",
  cash: "ጥሬ ገንዘብ"
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

export function ContributionFeed({
  contributions = [],
  onSelectMember,
}: {
  contributions?: MemberContribution[];
  onSelectMember?: (c: MemberContribution) => void;
}) {
  const [selected, setSelected] = useState<MemberContribution | null>(null);

  const openReceipt = (contribution: MemberContribution) => {
    onSelectMember?.(contribution);
    setSelected(contribution);
  };

  return (
    <section className="w-full max-w-md mx-auto px-4 pt-4 pb-20 select-none">
      {/* Section Title */}
      <h3 className="text-[17px] font-bold text-[#140E0A] tracking-tight mb-3.5 px-0.5 font-sans">
        የአባላት ልይሎች
      </h3>

      {contributions.length === 0 ? (
        // §12.7: an honest empty state. This used to fall back to two fixture
        // rows carrying bank badges nobody verified.
        <div className="rounded-2xl border border-dashed border-[#D9C8B5] bg-[#F3ECE2] px-4 py-8 text-center">
          <p className="text-sm font-semibold text-[#5C4A3D]">እስካሁል ምንም ልይል የለም</p>
          <p className="mt-1 text-xs leading-relaxed text-[#8A7A6D]">
            በዝርዝር ውርይት የተመዘገበ ልይል እዚህኛ ይታያል።
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
                {/* Left: Authentic Portrait Photo */}
                <div className="relative w-[70px] h-[76px] rounded-[16px] overflow-hidden shrink-0 shadow-sm border border-[#DECDBB] bg-[#EFE6D9]">
                  <Image
                    src={c.avatar}
                    alt={c.name}
                    fill
                    sizes="70px"
                    className="object-cover"
                    priority
                  />
                </div>

                {/* Middle: Trust badge + Name + Reference */}
                <div className="flex-1 min-w-0 pr-1">
                  {verified ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#138A4B] text-white text-[11px] font-semibold shadow-xs">
                      <Check className="w-3 h-3 stroke-[3]" />
                      {c.channel ? CHANNEL_LABEL[c.channel] : "የተረጋገጠ"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#E8D9BE] text-[#6B5433] text-[11px] font-semibold">
                      <Clock className="w-3 h-3 stroke-[3]" />
                      በመጠባበቅ ላይ
                    </span>
                  )}

                  <h4 className="text-[15px] font-bold text-[#140E0A] leading-snug mt-1 truncate font-sans">
                    {c.name}
                  </h4>

                  {c.transactionId ? (
                    <p className="text-[12px] font-normal text-[#7D6F66] mt-0.5 truncate font-sans">
                      ቁጥር: {c.transactionId}
                    </p>
                  ) : (
                    <p className="text-[12px] font-normal text-[#A2938A] mt-0.5 truncate font-sans">
                      የግብይት ቁጥር አልተመዘገበም
                    </p>
                  )}
                </div>

                {/* Right: Secondary Avatar (as featured in Row 1 of reference) */}
                {c.secondaryAvatar ? (
                  <div className="relative w-[70px] h-[76px] rounded-[16px] overflow-hidden shrink-0 shadow-sm border border-[#DECDBB] bg-[#EFE6D9]">
                    <Image
                      src={c.secondaryAvatar}
                      alt={`${c.name} — ሌላ አባል`}
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
              aria-label="Close"
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
                  ? "የተረጋገጠ የባንክ ክፍያ"
                  : "በመጠባበቅ ላይ — አልተረጋገጠም"}
              </span>
            </div>

            <h3 className="text-lg font-bold text-[#1F1714]">{selected.name}</h3>
            <p className="text-2xl font-extrabold text-[#1F1714] mt-1 font-sans">
              {typeof selected.amount === "number"
                ? `${selected.amount.toLocaleString("en-US")} ብር`
                : "—"}
            </p>

            <div className="mt-4 pt-3 border-t border-[#E5DACD] space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <span className="text-[#7A6B60]">የክፍያ መስመር:</span>
                <span className="font-semibold text-[#1F1714] text-right">
                  {selected.channel ? CHANNEL_LABEL[selected.channel] : "አልተለበረም"}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[#7A6B60]">የግብይት ቁጥር (Ref):</span>
                <span className="font-mono font-semibold text-[#1F1714] text-right break-all">
                  {selected.transactionId ?? "—"}
                </span>
              </div>
              {isVerified(selected) ? (
                <>
                  <div className="flex justify-between gap-4">
                    <span className="text-[#7A6B60]">ያረጋገጠው:</span>
                    <span className="font-semibold text-[#138A4B] text-right break-all">
                      {selected.verifiedBy}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[#7A6B60]">የተመለሰበት ሰዓት:</span>
                    <span className="font-semibold text-[#1F1714] text-right">
                      {selected.verifiedAt ?? "—"}
                    </span>
                  </div>
                </>
              ) : (
                <p className="pt-1 leading-relaxed text-[#6B5433]">
                  ይህ ልይል ከተናገረ ስለሆነ ነው። በባንክ ማረጋገጫ ካልፈጸም ወደ ሒሳብ አይገባም።
                </p>
              )}
            </div>

            <button
              onClick={() => setSelected(null)}
              className="w-full mt-5 py-2.5 rounded-xl bg-[#2A1F1A] text-[#FAF7F2] font-semibold text-sm hover:bg-[#3D2E27] active:scale-[0.98] transition-all"
            >
              ተመለስ
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
