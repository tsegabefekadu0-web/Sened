"use client";

import React, { useEffect, useId, useState } from "react";
import { ArrowLeft, User } from "lucide-react";

import { MemberAvatar } from "@/components/cultural/MemberAvatar";
import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { loadMyGroup, saveMyAttire, type MemberAttire } from "@/lib/ledger/clientInvites";

/**
 * The Profile slot, for a signed-in member: choose the shawl your avatar wears
 * (none, Gabi or Netela). Nothing is chosen for anyone; the default is none and
 * the value is saved to the caller's own membership only (see the route and the
 * SQL function it calls). Signed out or unconfigured, `page.tsx` keeps showing
 * the honest placeholder instead of this panel.
 *
 * Accessible: a native radio group in a fieldset with a legend, each option a
 * label with a text description of what is drawn (not colour), a live status
 * line for saving, and a preview avatar whose name reflects the choice.
 */

type Load =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly groupId: string; readonly userId: string | null }
  | { readonly status: "no-group" | "multiple-groups" | "unauthorized" | "unavailable" | "error" };

type Save = "idle" | "saving" | "saved" | "error";

const OPTIONS: ReadonlyArray<{ readonly value: MemberAttire; readonly label: MessageKey; readonly hint: MessageKey }> = [
  { value: "none", label: "profile.attire.none", hint: "profile.attire.noneHint" },
  { value: "gabi", label: "profile.attire.gabi", hint: "profile.attire.gabiHint" },
  { value: "netela", label: "profile.attire.netela", hint: "profile.attire.netelaHint" }
];

const LOAD_NOTICE: Record<Exclude<Load["status"], "loading" | "ready">, MessageKey> = {
  "no-group": "profile.noGroup",
  "multiple-groups": "profile.multipleGroups",
  unauthorized: "profile.unauthorized",
  unavailable: "profile.unavailable",
  error: "profile.error"
};

export function ProfilePanel({
  onBack,
  locale = "en",
  deps
}: {
  readonly onBack: () => void;
  readonly locale?: Locale;
  readonly deps?: AuthedFetchDeps;
}) {
  const t = createTranslator(locale);
  const name = useId();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attire, setAttire] = useState<MemberAttire>("none");
  const [save, setSave] = useState<Save>("idle");

  useEffect(() => {
    let active = true;
    void loadMyGroup(deps).then((outcome) => {
      if (!active) return;
      if (outcome.status === "ready") {
        setAttire(outcome.attire);
        setLoad({ status: "ready", groupId: outcome.groupId, userId: outcome.userId });
      } else if (outcome.status === "rate-limited" || outcome.status === "forbidden") {
        setLoad({ status: "error" });
      } else {
        setLoad({ status: outcome.status });
      }
    });
    return () => {
      active = false;
    };
    // `deps` is injected by tests only and is stable for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (next: MemberAttire) => {
    if (load.status !== "ready" || save === "saving" || next === attire) return;
    const previous = attire;
    setAttire(next);
    setSave("saving");
    void saveMyAttire({ groupId: load.groupId, attire: next }, deps).then((outcome) => {
      if (outcome.status === "saved") {
        setAttire(outcome.attire);
        setSave("saved");
      } else {
        // The server did not take it: show what is actually stored.
        setAttire(previous);
        setSave("error");
      }
    });
  };

  const attireLabel = attire === "gabi" ? t("shell.feed.attireGabi") : attire === "netela" ? t("shell.feed.attireNetela") : undefined;

  return (
    <section
      aria-label={t("tab.panels.profile")}
      className="absolute inset-x-0 top-[132px] z-40 mx-4 max-w-[364px] rounded-3xl border border-[#DECDBB] bg-[#FAF6F0] p-5 shadow-[0_18px_40px_-12px_rgba(38,30,26,0.45)]"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#F0E6D8] text-[#A3441F]">
          <User className="h-5 w-5 stroke-[2.2]" aria-hidden="true" />
        </span>
        <h2 className="font-ethiopic text-lg font-bold text-[#1F1714]">{t("tab.panels.profile")}</h2>
      </div>

      {load.status === "loading" ? (
        <p role="status" className="mt-3 text-sm text-[#6B5B4E]">
          {t("profile.loading")}
        </p>
      ) : load.status !== "ready" ? (
        <p role={load.status === "error" ? "alert" : "status"} className="mt-3 text-sm leading-relaxed text-[#6B5B4E]">
          {t(LOAD_NOTICE[load.status])}
        </p>
      ) : (
        <div className="mt-4 flex items-start gap-4">
          <MemberAvatar
            memberId={load.userId}
            name={t("profile.preview")}
            attire={attire === "none" ? null : attire}
            attireLabel={attireLabel}
          />
          <fieldset className="min-w-0 flex-1" disabled={save === "saving"}>
            <legend className="text-sm font-bold text-[#1F1714]">{t("profile.attire.legend")}</legend>
            <p className="mt-1 text-xs leading-relaxed text-[#6B5B4E]">{t("profile.attire.hint")}</p>
            <div className="mt-2 space-y-1.5">
              {OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#DECDBB] bg-white/60 px-2.5 py-2 has-[:checked]:border-[#C6532B] has-[:checked]:bg-[#FBEFE6] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#C6532B]"
                >
                  <input
                    type="radio"
                    name={name}
                    value={option.value}
                    checked={attire === option.value}
                    onChange={() => choose(option.value)}
                    className="mt-0.5 h-4 w-4 accent-[#C6532B]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[#1F1714]">{t(option.label)}</span>
                    <span className="block text-xs text-[#6B5B4E]">{t(option.hint)}</span>
                  </span>
                </label>
              ))}
            </div>
            <p role={save === "error" ? "alert" : "status"} className="mt-2 min-h-[1rem] text-xs font-semibold text-[#6B5B4E]">
              {save === "saving" ? t("profile.attire.saving") : save === "saved" ? t("profile.attire.saved") : save === "error" ? t("profile.attire.saveError") : ""}
            </p>
          </fieldset>
        </div>
      )}

      <button
        type="button"
        onClick={onBack}
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#8A7A6D] hover:text-[#3D2E27] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("tab.panels.back")}
      </button>
    </section>
  );
}
