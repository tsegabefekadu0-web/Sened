"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CircleAlert, CircleCheck, UsersRound } from "lucide-react";

import { useSession } from "@/lib/auth/useSession";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import {
  clearPendingInvite,
  parseTokenFromHash,
  peekPendingInvite,
  redeemInviteToken,
  stashPendingInvite,
  type RedeemOutcome
} from "@/lib/ledger/clientInvites";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";

type Phase =
  | { readonly kind: "reading" }
  | { readonly kind: "missing" }
  | { readonly kind: "joining" }
  | { readonly kind: "done"; readonly outcome: RedeemOutcome };

const OUTCOME_COPY: Record<RedeemOutcome["status"], MessageKey> = {
  joined: "join.joined",
  already_member: "join.alreadyMember",
  expired: "join.expired",
  exhausted: "join.exhausted",
  revoked: "join.revoked",
  invalid: "join.invalid",
  unauthorized: "join.signInRequired",
  "rate-limited": "join.rateLimited",
  error: "join.error"
};

const SUCCESS = new Set<RedeemOutcome["status"]>(["joined", "already_member"]);
const RETRYABLE = new Set<RedeemOutcome["status"]>(["rate-limited", "error"]);

/**
 * `/join` — redeem an invite link.
 *
 * The token comes from the URL fragment (`#token=...`), which a browser never
 * sends to a server, so it cannot appear in access logs. It is removed from the
 * address bar as soon as it is read. Signed out, it is parked in localStorage
 * for the round trip through `/sign-in` and cleared once redeemed or rejected.
 */
export function JoinPanel({ initialLocale = "am" }: { readonly initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = createTranslator(locale);
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });
  const tokenRef = useRef<string | null>(null);
  const redeeming = useRef(false);
  const signedIn = session.status === "signed-in";
  // Joining adds a group: re-read the user's groups and make the one just joined the active one.
  const { reload: reloadGroups } = useActiveGroup();

  // Read the token once: fragment first, then whatever a sign-in round trip parked.
  useEffect(() => {
    const fromHash = parseTokenFromHash(window.location.hash);
    if (fromHash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    const token = fromHash ?? peekPendingInvite();
    tokenRef.current = token;
    setPhase(token ? { kind: "joining" } : { kind: "missing" });
  }, []);

  // Signed out: park the token so it survives sign-in.
  useEffect(() => {
    if (session.status === "signed-out" && tokenRef.current) {
      stashPendingInvite(tokenRef.current);
    }
  }, [session.status, phase.kind]);

  const redeem = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || redeeming.current) {
      return;
    }
    redeeming.current = true;
    setPhase({ kind: "joining" });
    const outcome = await redeemInviteToken(token);
    redeeming.current = false;
    if (!RETRYABLE.has(outcome.status) && outcome.status !== "unauthorized") {
      clearPendingInvite();
    }
    if (outcome.status === "joined" || outcome.status === "already_member") {
      reloadGroups(outcome.groupId);
    }
    setPhase({ kind: "done", outcome });
  }, [reloadGroups]);

  useEffect(() => {
    if (signedIn && phase.kind === "joining") {
      void redeem();
    }
  }, [signedIn, phase.kind, redeem]);

  const outcome = phase.kind === "done" ? phase.outcome : null;
  const success = outcome ? SUCCESS.has(outcome.status) : false;
  const signedOut = session.status === "signed-out" && phase.kind === "joining";

  return (
    <main className="min-h-screen w-full bg-[#120D0A] flex items-center justify-center sm:py-6 antialiased">
      <div className="w-full max-w-md bg-[#FAF6F0] min-h-[100dvh] sm:min-h-0 sm:rounded-3xl sm:border sm:border-[#382B24]/50 sm:shadow-[0_25px_80px_rgba(0,0,0,0.85)] overflow-hidden">
        <div className="bg-[#2A1D17] text-[#F3E6D3] px-6 py-5 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 min-h-11 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            {t("auth.backHome")}
          </Link>
          <button
            type="button"
            onClick={() => setLocale(locale === "am" ? "en" : "am")}
            className="min-h-11 px-3 text-sm font-semibold rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
          >
            {locale === "am" ? t("shell.english") : t("shell.amharic")}
          </button>
        </div>

        <div className="px-6 py-8 space-y-6">
          <h1 className="flex items-center gap-3 text-2xl font-extrabold text-[#2A1D17]">
            <UsersRound className="w-6 h-6 text-[#C6532B]" aria-hidden="true" />
            {t("join.title")}
          </h1>

          {(session.status === "loading" || phase.kind === "reading") && (
            <p role="status" className="text-sm text-[#6B5648]">
              {t("join.loading")}
            </p>
          )}

          {session.status === "unconfigured" && (
            <p role="alert" className="text-sm font-semibold text-[#A6401F]" data-testid="join-outcome">
              {t("join.notConfigured")}
            </p>
          )}

          {phase.kind === "missing" && session.status !== "unconfigured" && (
            <p role="alert" className="text-sm font-semibold text-[#A6401F]" data-testid="join-outcome">
              {t("join.missingToken")}
            </p>
          )}

          {signedOut && (
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[#6B5648]" data-testid="join-outcome">
                {t("join.signInRequired")}
              </p>
              <Link
                href="/sign-in"
                className="w-full min-h-12 rounded-2xl bg-gradient-to-r from-[#C6532B] to-[#D9A441] text-[#1E130D] font-bold flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                {t("join.signIn")}
              </Link>
            </div>
          )}

          {signedIn && phase.kind === "joining" && (
            <p role="status" className="text-sm text-[#6B5648]">
              {t("join.joining")}
            </p>
          )}

          {outcome && (
            <div className="space-y-4">
              <p
                role={success ? "status" : "alert"}
                data-testid="join-outcome"
                data-outcome={outcome.status}
                className={`flex items-start gap-3 text-sm font-semibold ${success ? "text-[#2A1D17]" : "text-[#A6401F]"}`}
              >
                {success ? (
                  <CircleCheck className="w-5 h-5 shrink-0 text-[#4F7A3A]" aria-hidden="true" />
                ) : (
                  <CircleAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
                )}
                <span>{t(OUTCOME_COPY[outcome.status])}</span>
              </p>
              {RETRYABLE.has(outcome.status) && (
                <button
                  type="button"
                  onClick={() => void redeem()}
                  className="w-full min-h-12 rounded-2xl border border-[#C6532B] text-[#C6532B] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
                >
                  {t("join.retry")}
                </button>
              )}
              <Link
                href="/ledger"
                className="w-full min-h-12 rounded-2xl bg-gradient-to-r from-[#C6532B] to-[#D9A441] text-[#1E130D] font-bold flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                {t("join.openLedger")}
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
