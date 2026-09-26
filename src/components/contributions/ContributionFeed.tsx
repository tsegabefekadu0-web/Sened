"use client";

import React, { useState } from "react";
import Image from "next/image";
import { Check, ShieldCheck, X } from "lucide-react";

export interface MemberContribution {
  id: string;
  name: string;
  avatar: string;
  secondaryAvatar?: string;
  telebirrVerified: boolean;
  cbeVerified: boolean;
  transactionId: string;
  amount?: number;
}

const defaultContributions: MemberContribution[] = [
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

export function ContributionFeed({
  contributions = defaultContributions,
  onSelectMember,
}: {
  contributions?: MemberContribution[];
  onSelectMember?: (c: MemberContribution) => void;
}) {
  const [selectedReceipt, setSelectedReceipt] = useState<{
    name: string;
    amount: string;
    channel: string;
    txRef: string;
    verifiedBy: string;
    timestamp: string;
  } | null>(null);

  const displayList = contributions.length > 0 ? contributions : defaultContributions;

  return (
    <section className="w-full max-w-md mx-auto px-4 pt-4 pb-20 select-none">
      {/* Section Title */}
      <h3 className="text-[17px] font-bold text-[#140E0A] tracking-tight mb-3.5 px-0.5 font-sans">
        Verified Member Contribution
      </h3>

      {/* List of Member Rows directly on Parchment Canvas */}
      <div className="space-y-4">
        {displayList.map((c) => (
          <div
            key={c.id}
            onClick={() => {
              onSelectMember?.(c);
              setSelectedReceipt({
                name: c.name,
                amount: c.amount ? `${c.amount.toLocaleString()} ETB` : "5,000 ETB",
                channel: c.telebirrVerified && c.cbeVerified ? "Telebirr & CBE Birr" : c.telebirrVerified ? "Telebirr Instant" : "CBE Birr",
                txRef: c.transactionId,
                verifiedBy: "Links.et Core Trust Engine",
                timestamp: "ዛሬ 10:14 ጠዋት (Verified 0.4s)",
              });
            }}
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

            {/* Middle: Badges + Name + Transaction ID */}
            <div className="flex-1 min-w-0 pr-1">
              {/* Badges: ✔ Telebirr & CBE Birr */}
              <div className="flex items-center gap-1.5">
                {c.telebirrVerified && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#138A4B] text-white text-[11px] font-semibold shadow-xs">
                    <Check className="w-3 h-3 stroke-[3]" />
                    Telebirr
                  </span>
                )}
                {c.cbeVerified && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#C8E6C9] text-[#1B5E20] text-[11px] font-semibold">
                    CBE Birr
                  </span>
                )}
              </div>

              {/* Member Name */}
              <h4 className="text-[15px] font-bold text-[#140E0A] leading-snug mt-1 truncate font-sans">
                {c.name}
              </h4>

              {/* Transaction ID */}
              <p className="text-[12px] font-normal text-[#7D6F66] mt-0.5 truncate font-sans">
                Transaction ID: {c.transactionId}
              </p>
            </div>

            {/* Right: Secondary Avatar (as featured in Row 1 of reference) */}
            {c.secondaryAvatar ? (
              <div className="relative w-[70px] h-[76px] rounded-[16px] overflow-hidden shrink-0 shadow-sm border border-[#DECDBB] bg-[#EFE6D9]">
                <Image
                  src={c.secondaryAvatar}
                  alt="Verified Member"
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
        ))}
      </div>

      {/* Live Bank Receipt Verification Modal */}
      {selectedReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-[28px] bg-[#FAF7F2] border border-[#D9C8B5] p-5 shadow-2xl relative select-text">
            <button
              onClick={() => setSelectedReceipt(null)}
              className="absolute top-4 right-4 p-1.5 rounded-full bg-[#EAE0D3] text-[#4A3B32] hover:bg-[#DDCFBF] transition-all"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 text-[#138A4B] mb-3">
              <ShieldCheck className="w-5 h-5 stroke-[2.5]" />
              <span className="text-xs font-bold uppercase tracking-wider">
                የተረጋገጠ የባንክ ክፍያ (Links.et Verified)
              </span>
            </div>

            <h3 className="text-lg font-bold text-[#1F1714]">
              {selectedReceipt.name}
            </h3>
            <p className="text-2xl font-extrabold text-[#1F1714] mt-1 font-sans">
              {selectedReceipt.amount}
            </p>

            <div className="mt-4 pt-3 border-t border-[#E5DACD] space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[#7A6B60]">የክፍያ መስመር:</span>
                <span className="font-semibold text-[#1F1714]">
                  {selectedReceipt.channel}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7A6B60]">የግብይት ቁጥር (Ref):</span>
                <span className="font-mono font-semibold text-[#1F1714]">
                  {selectedReceipt.txRef}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7A6B60]">ማረጋገጫ ሲስተም:</span>
                <span className="font-semibold text-[#138A4B]">
                  {selectedReceipt.verifiedBy}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7A6B60]">የተመዘገበበት ሰዓት:</span>
                <span className="font-semibold text-[#1F1714]">
                  {selectedReceipt.timestamp}
                </span>
              </div>
            </div>

            <button
              onClick={() => setSelectedReceipt(null)}
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
