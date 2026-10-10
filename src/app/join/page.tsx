"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { SimpleScreen } from "@/components/ui/SimpleScreen";
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
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/ui/useT";

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

const PRIMARY = "flex h-[54px] items-center justify-center rounded-[27px] bg-prim text-[17px] font-bold text-primt";

/**
 * `/join`: redeem an invite link. The token is in the URL fragment (`#token=...`),
 * which a browser never sends to a server; it is removed from the address bar as
 * soon as it is read. Signed out, it is parked for the round trip through
 * `/sign-in` and cleared once redeemed or rejected.
 */
export default function JoinPage() {
  const { t } = useT();
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });
  const tokenRef = useRef<string | null>(null);
  const redeeming = useRef(false);
  const signedIn = session.status === "signed-in";
  const { reload: reloadGroups } = useActiveGroup();

  useEffect(() => {
    // Strict mode re-runs this effect after the fragment is already cleared.
    if (tokenRef.current) return;
    const fromHash = parseTokenFromHash(window.location.hash);
    if (fromHash) window.history.replaceState(null, "", window.location.pathname);
    const token = fromHash ?? peekPendingInvite();
    tokenRef.current = token;
    setPhase(token ? { kind: "joining" } : { kind: "missing" });
  }, []);

  useEffect(() => {
    if (session.status === "signed-out" && tokenRef.current) stashPendingInvite(tokenRef.current);
  }, [session.status, phase.kind]);

  const redeem = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || redeeming.current) return;
    redeeming.current = true;
    setPhase({ kind: "joining" });
    const outcome = await redeemInviteToken(token);
    redeeming.current = false;
    if (!RETRYABLE.has(outcome.status) && outcome.status !== "unauthorized") clearPendingInvite();
    if (outcome.status === "joined" || outcome.status === "already_member") reloadGroups(outcome.groupId);
    setPhase({ kind: "done", outcome });
  }, [reloadGroups]);

  useEffect(() => {
    if (signedIn && phase.kind === "joining") void redeem();
  }, [signedIn, phase.kind, redeem]);

  const outcome = phase.kind === "done" ? phase.outcome : null;
  const success = outcome ? SUCCESS.has(outcome.status) : false;
  const signedOut = session.status === "signed-out" && phase.kind === "joining";

  return (
    <SimpleScreen title={t("join.title")} subtitle="Join" rail={session.status === "signed-in"}>
      {session.status === "loading" || phase.kind === "reading" ? (
        <p role="status" lang="am" className="m-0 text-base text-soft">
          {t("join.loading")}
        </p>
      ) : null}

      {session.status === "unconfigured" ? (
        <>
          <p role="alert" lang="am" className="m-0 text-base leading-[1.5]" data-testid="join-outcome">
            {t("join.notConfigured")}
          </p>
          <Link href="/home" className={PRIMARY}>
            {t("auth.notConfiguredAction")}
          </Link>
        </>
      ) : null}

      {phase.kind === "missing" && session.status !== "unconfigured" ? (
        <p role="alert" lang="am" className="m-0 text-base font-bold leading-[1.5]" data-testid="join-outcome">
          {t("join.missingToken")}
        </p>
      ) : null}

      {signedOut ? (
        <>
          <p lang="am" className="m-0 text-base leading-[1.5]" data-testid="join-outcome">
            {t("join.signInRequired")}
          </p>
          <Link href="/sign-in" className={PRIMARY}>
            {t("join.signIn")}
          </Link>
        </>
      ) : null}

      {signedIn && phase.kind === "joining" ? (
        <p role="status" lang="am" className="m-0 text-base text-soft">
          {t("join.joining")}
        </p>
      ) : null}

      {outcome ? (
        <>
          <p
            role={success ? "status" : "alert"}
            data-testid="join-outcome"
            data-outcome={outcome.status}
            lang="am"
            className="m-0 flex items-start gap-3 text-base font-bold leading-[1.6]"
            style={{ color: success ? "var(--ink)" : "var(--dng)" }}
          >
            <span className="mt-0.5 flex shrink-0" style={{ color: success ? "var(--shop)" : "var(--dng)" }}>
              <Icon name={success ? "check" : "close"} size={22} />
            </span>
            <span>{t(OUTCOME_COPY[outcome.status])}</span>
          </p>
          {RETRYABLE.has(outcome.status) ? (
            <button type="button" onClick={() => void redeem()} className="h-[54px] rounded-[27px] border-[1.5px] border-prim bg-card text-[17px] font-bold text-ink">
              {t("join.retry")}
            </button>
          ) : null}
          <Link href="/ledger" className={PRIMARY}>
            {t("join.openLedger")}
          </Link>
        </>
      ) : null}
    </SimpleScreen>
  );
}
