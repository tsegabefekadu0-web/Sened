import React from "react";

import { BasketRing, type RingKind } from "@/components/ui/BasketRing";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/primitives";
import { TibebRibbon } from "@/components/ui/Weave";

const ORDER: RingKind[] = ["paid", "paid", "paid", "paid", "paid", "draft", "due", "due"];

/**
 * A phone showing the Home screen, drawn from the same pieces as the app (sample
 * numbers). It is decorative: hidden from assistive tech and not focusable.
 */
export function PhoneMockup({ labels }: { readonly labels: { readonly name: string; readonly share: string; readonly record: string; readonly progress: string; readonly paid: string; readonly draft: string; readonly due: string; readonly status: string } }) {
  const W = 390;
  const scale = 0.74;
  return (
    <div
      aria-hidden="true"
      data-testid="phone-mockup"
      className="relative mx-auto"
      style={{ width: W * scale + 20, height: 760 * scale + 20, borderRadius: 40, padding: 10, background: "linear-gradient(160deg, #2A2621, #0F0D0B)", boxShadow: "0 40px 60px -30px rgba(0,0,0,0.55), 0 0 0 2px #3A352E inset" }}
    >
      <div className="relative overflow-hidden" style={{ width: W * scale, height: 760 * scale, borderRadius: 30, background: "#F6F5F2" }}>
        <div className="pointer-events-none select-none" style={{ width: W, height: 760, transform: `scale(${scale})`, transformOrigin: "top left", color: "#1C1A17", fontFamily: "var(--font-atkinson), var(--font-noto-sans-ethiopic), sans-serif" }} inert>
          <header className="relative flex flex-col gap-5 overflow-hidden text-white" style={{ background: "#1F6B4A", padding: "18px 20px 84px", borderRadius: "0 0 28px 28px" }}>
            <div className="flex items-center gap-3.5">
              <span lang="am" className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-[18px] bg-white font-serif text-[30px] font-bold" style={{ color: "#1F6B4A" }}>
                በ
              </span>
              <h1 lang="am" className="m-0 font-serif text-[28px] font-bold leading-[1.2]">
                {labels.name}
              </h1>
            </div>
            <TibebRibbon animate={false} style={{ bottom: 40 }} />
          </header>
          <div className="flex flex-col gap-4 rounded-[22px] border bg-white p-5" style={{ margin: "-30px 16px 0", borderColor: "#E2DED6", boxShadow: "0 12px 28px -14px rgba(28,26,23,0.45)", position: "relative" }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span lang="am" className="text-base font-semibold" style={{ color: "#4A443C" }}>
                  {labels.share}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="font-display text-[32px] font-extrabold leading-[1.1]">5,000</span>
                  <span lang="am" className="font-serif text-xl font-bold">
                    ብር
                  </span>
                </span>
              </div>
              <StatusPill kind="due" label={labels.status} />
            </div>
            <div className="flex h-[54px] items-center justify-center gap-2.5 rounded-[27px] text-[17px] font-bold text-white" style={{ background: "#1C1A17" }}>
              <Icon name="mic" size={22} />
              {labels.record}
            </div>
          </div>
          <div style={{ margin: "30px 16px 0" }}>
            <h2 lang="am" className="mx-1 mb-3 mt-0 font-serif text-[25px] font-bold">
              {labels.progress}
            </h2>
            <div className="flex items-center gap-4 rounded-[22px] border bg-white" style={{ padding: "22px 18px", borderColor: "#E2DED6" }}>
              <BasketRing order={ORDER} label="" centerTop="25,000" centerBottom="ከ 40,000" size={150} />
              <ul className="m-0 flex grow list-none flex-col gap-3 p-0">
                {(
                  [
                    [labels.paid, 5, "#2A6B47"],
                    [labels.draft, 1, "#E7AE3A"],
                    [labels.due, 2, "#D8BC88"]
                  ] as const
                ).map(([l, n, c]) => (
                  <li key={l} className="flex items-center gap-2 text-[15px]">
                    <span className="h-3 w-3 rounded-full" style={{ background: c }} />
                    <span lang="am" className="grow">
                      {l}
                    </span>
                    <span className="font-display text-[17px] font-extrabold">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
