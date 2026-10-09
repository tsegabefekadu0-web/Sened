"use client";

import Link from "next/link";
import React from "react";

import type { CommunityMode } from "@/lib/ui/useCommunity";
import { useT } from "@/lib/ui/useT";
import { Card } from "./primitives";

/** A small chip on the brand header that says the numbers below are a sample. */
export function SampleChip({ mode }: { readonly mode: CommunityMode }) {
  const { t } = useT();
  if (mode !== "sample") return null;
  return (
    <Link
      href="/sign-in"
      data-testid="sample-chip"
      className="inline-flex min-h-[32px] w-fit items-center gap-2 rounded-2xl bg-white/20 px-3 text-[13px] font-bold text-white"
    >
      <span lang="am">{t("ui.sample.chip")}</span>
    </Link>
  );
}

/** What to do when the signed-in person has no community, has several, or the read failed. */
export function CommunityNotice({ mode, className = "" }: { readonly mode: CommunityMode; readonly className?: string }) {
  const { t } = useT();
  if (mode !== "no-group" && mode !== "choose-group" && mode !== "error") return null;
  const text = mode === "no-group" ? t("ui.notice.noGroup") : mode === "choose-group" ? t("ui.notice.chooseGroup") : t("ui.notice.error");
  const href = mode === "no-group" ? "/community/new" : "/account";
  const cta = mode === "no-group" ? t("ui.notice.noGroupCta") : mode === "choose-group" ? t("ui.notice.chooseGroupCta") : t("ui.notice.retry");
  return (
    <Card className={`flex flex-col gap-3 p-5 ${className}`} role="status" data-testid="community-notice" style={{ margin: "-30px 16px 0" }}>
      <p lang="am" className="m-0 text-base leading-[1.5] text-soft">
        {text}
      </p>
      {mode === "error" ? (
        <button type="button" onClick={() => window.location.reload()} className="h-12 rounded-3xl border-[1.5px] border-prim bg-card text-base font-bold text-ink">
          {cta}
        </button>
      ) : (
        <Link href={href} className="flex h-12 items-center justify-center rounded-3xl bg-prim text-base font-bold text-primt">
          {cta}
        </Link>
      )}
    </Card>
  );
}
