"use client";

import { BODY_TEXT, PRIMARY_BUTTON, SimpleScreen } from "@/components/shell/SimpleScreen";
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

  const toggleLocale = () => setLocale(locale === "am" ? "en" : "am");

  return (
    <SimpleScreen
      locale={locale}
      onToggleLocale={toggleLocale}
      icon={<UsersRound className="h-9 w-9" aria-hidden="true" />}
      title={t("join.title")}
    >
      {(session.status === "loading" || phase.kind === "reading") && (
        <p role="status" className={BODY_TEXT}>
          {t("join.loading")}
        </p>
      )}

      {session.status === "unconfigured" && (
        <div className="space-y-5">
          <p role="alert" className={BODY_TEXT} data-testid="join-outcome">
            {t("join.notConfigured")}
          </p>
          <Link href="/" className={PRIMARY_BUTTON}>
            {t("auth.notConfiguredAction")}
          </Link>
        </div>
      )}

      {phase.kind === "missing" && session.status !== "unconfigured" && (
        <p role="alert" className={`${BODY_TEXT} font-semibold`} data-testid="join-outcome">
          {t("join.missingToken")}
        </p>
      )}

      {signedOut && (
        <div className="space-y-5">
          <p className={BODY_TEXT} data-testid="join-outcome">
            {t("join.signInRequired")}
          </p>
          <Link href="/sign-in" className={PRIMARY_BUTTON}>
            {t("join.signIn")}
          </Link>
        </div>
      )}

      {signedIn && phase.kind === "joining" && (
        <p role="status" className={BODY_TEXT}>
          {t("join.joining")}
        </p>
      )}

      {outcome && (
        <div className="space-y-5">
          <p
            role={success ? "status" : "alert"}
            data-testid="join-outcome"
            data-outcome={outcome.status}
            className={`flex items-start gap-3 text-left font-ethiopic text-[18px] font-semibold leading-[1.6] ${success ? "text-[#2A1D17]" : "text-[#8F2D12]"}`}
          >
            {success ? (
              <CircleCheck className="h-6 w-6 shrink-0 text-[#2F6B2A]" aria-hidden="true" />
            ) : (
              <CircleAlert className="h-6 w-6 shrink-0" aria-hidden="true" />
            )}
            <span>{t(OUTCOME_COPY[outcome.status])}</span>
          </p>
          {RETRYABLE.has(outcome.status) && (
            <button
              type="button"
              onClick={() => void redeem()}
              className="flex min-h-[60px] w-full items-center justify-center rounded-2xl border-2 border-[#A9411D] font-ethiopic text-[20px] font-bold text-[#8F2D12] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
            >
              {t("join.retry")}
            </button>
          )}
          <Link href="/ledger" className={PRIMARY_BUTTON}>
            {t("join.openLedger")}
          </Link>
        </div>
      )}
    </SimpleScreen>
  );
}
