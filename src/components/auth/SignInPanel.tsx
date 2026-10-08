"use client";

import React, { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { LogIn, LogOut, Mail } from "lucide-react";

import { BODY_TEXT, PRIMARY_BUTTON, SimpleScreen } from "@/components/shell/SimpleScreen";

import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { useSession } from "@/lib/auth/useSession";
import { peekPendingInvite } from "@/lib/ledger/clientInvites";
import { createTranslator, type Locale } from "@/lib/i18n";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = "idle" | "sending" | "sent" | "failed" | "invalid";

/**
 * `/sign-in` — email magic link, with sign-out.
 *
 * Email rather than phone because phone OTP needs an SMS provider configured in
 * the Supabase project and nothing in this repository sets one up. With no
 * Supabase environment the panel says so plainly and offers nothing to submit.
 */
export function SignInPanel({ initialLocale = "am" }: { readonly initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = createTranslator(locale);
  const session = useSession();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [signOutFailed, setSignOutFailed] = useState(false);

  // Signed in with an invite waiting (the person came here from /join): go back.
  useEffect(() => {
    if (session.status === "signed-in" && peekPendingInvite()) {
      window.location.replace("/join");
    }
  }, [session.status]);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setPhase("invalid");
      return;
    }
    const client = getBrowserSupabase();
    if (!client) {
      setPhase("failed");
      return;
    }
    setPhase("sending");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: `${window.location.origin}/sign-in` }
      });
      setPhase(error ? "failed" : "sent");
    } catch {
      setPhase("failed");
    }
  }

  async function signOut() {
    setSignOutFailed(false);
    try {
      const client = getBrowserSupabase();
      const { error } = (await client?.auth.signOut()) ?? { error: null };
      if (error) {
        setSignOutFailed(true);
      }
    } catch {
      setSignOutFailed(true);
    }
  }

  const toggleLocale = () => setLocale(locale === "am" ? "en" : "am");

  return (
    <SimpleScreen
      locale={locale}
      onToggleLocale={toggleLocale}
      icon={<LogIn className="h-9 w-9" aria-hidden="true" />}
      title={session.status === "signed-in" ? t("auth.linkSignedIn") : t("auth.title")}
    >
      {session.status === "loading" && (
        <p role="status" className={BODY_TEXT}>
          {t("auth.loading")}
        </p>
      )}

      {session.status === "unconfigured" && (
        <div role="alert" className="space-y-5">
          <h2 className="font-ethiopic text-[22px] font-bold leading-snug text-[#2A1D17]">{t("auth.notConfiguredTitle")}</h2>
          <p className={BODY_TEXT}>{t("auth.notConfiguredBody")}</p>
          <Link href="/" className={PRIMARY_BUTTON}>
            {t("auth.notConfiguredAction")}
          </Link>
        </div>
      )}

      {session.status === "signed-in" && (
        <div className="space-y-5">
          <p className="font-ethiopic text-[20px] font-semibold text-[#2A1D17]" data-testid="signed-in-as">
            {session.email ? t("auth.signedInAs", { email: session.email }) : t("auth.signedInAnonymous")}
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex min-h-[60px] w-full items-center justify-center gap-2 rounded-2xl border-2 border-[#A9411D] font-ethiopic text-[20px] font-bold text-[#8F2D12] active:scale-[0.98] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
          >
            <LogOut className="h-5 w-5" aria-hidden="true" />
            {t("auth.signOut")}
          </button>
          {signOutFailed && (
            <p role="alert" className="font-ethiopic text-[18px] font-semibold text-[#8F2D12]">
              {t("auth.signOutFailed")}
            </p>
          )}
        </div>
      )}

      {session.status === "signed-out" && (
        <form onSubmit={(event) => void sendLink(event)} noValidate className="space-y-5 text-left">
          <p className={`${BODY_TEXT} text-center`}>{t("auth.page.intro")}</p>
          <div>
            <label htmlFor="sign-in-email" className="font-ethiopic text-[18px] font-bold text-[#2A1D17]">
              {t("auth.emailLabel")}
            </label>
            <input
              id="sign-in-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setPhase("idle");
              }}
              placeholder={t("auth.emailPlaceholder")}
              aria-invalid={phase === "invalid"}
              className="mt-2 min-h-[56px] w-full rounded-xl border-2 border-[#8B7566] bg-white px-4 text-[18px] text-[#2A1D17] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#F3C769]"
            />
          </div>
          <button type="submit" disabled={phase === "sending"} className={PRIMARY_BUTTON}>
            <Mail className="h-5 w-5" aria-hidden="true" />
            {phase === "sending" ? t("auth.sending") : t("auth.sendLink")}
          </button>
          {phase === "sent" && (
            <p role="status" className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#2A1D17]">
              {t("auth.linkSent")}
            </p>
          )}
          {phase === "failed" && (
            <p role="alert" className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#8F2D12]">
              {t("auth.sendFailed")}
            </p>
          )}
          {phase === "invalid" && (
            <p role="alert" className="font-ethiopic text-[18px] font-semibold leading-[1.6] text-[#8F2D12]">
              {t("auth.invalidEmail")}
            </p>
          )}
        </form>
      )}
    </SimpleScreen>
  );
}
