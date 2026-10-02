"use client";

import React, { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, LogOut, Mail, ShieldAlert } from "lucide-react";

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
          <h1 className="text-2xl font-extrabold text-[#2A1D17]">
            {session.status === "signed-in" ? t("auth.linkSignedIn") : t("auth.title")}
          </h1>

          {session.status === "loading" && (
            <p role="status" className="text-sm text-[#6B5648]">
              {t("auth.loading")}
            </p>
          )}

          {session.status === "unconfigured" && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-2xl border border-[#E0D2C4] bg-[#F3E9DB] p-4 text-sm text-[#2A1D17]"
            >
              <ShieldAlert className="w-5 h-5 shrink-0 text-[#C6532B]" aria-hidden="true" />
              <span>
                <strong className="block">{t("auth.notConfiguredTitle")}</strong>
                {t("auth.notConfiguredBody")}
              </span>
            </div>
          )}

          {session.status === "signed-in" && (
            <div className="space-y-4">
              <p className="text-sm font-semibold text-[#2A1D17]" data-testid="signed-in-as">
                {session.email
                  ? t("auth.signedInAs", { email: session.email })
                  : t("auth.signedInAnonymous")}
              </p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="w-full min-h-12 rounded-2xl border border-[#C6532B] text-[#C6532B] font-bold flex items-center justify-center gap-2 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
                {t("auth.signOut")}
              </button>
              {signOutFailed && (
                <p role="alert" className="text-xs font-semibold text-[#A6401F]">
                  {t("auth.signOutFailed")}
                </p>
              )}
            </div>
          )}

          {session.status === "signed-out" && (
            <form onSubmit={(event) => void sendLink(event)} noValidate className="space-y-4">
              <p className="text-sm leading-6 text-[#6B5648]">{t("auth.description")}</p>
              <div>
                <label htmlFor="sign-in-email" className="text-sm font-bold text-[#2A1D17]">
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
                  className="mt-2 w-full min-h-12 rounded-xl border border-[#D9C9B8] bg-white px-4 text-[#2A1D17] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
                />
              </div>
              <button
                type="submit"
                disabled={phase === "sending"}
                className="w-full min-h-12 rounded-2xl bg-gradient-to-r from-[#C6532B] to-[#D9A441] text-[#1E130D] font-bold flex items-center justify-center gap-2 active:scale-95 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C6532B]"
              >
                <Mail className="w-4 h-4" aria-hidden="true" />
                {phase === "sending" ? t("auth.sending") : t("auth.sendLink")}
              </button>
              {phase === "sent" && (
                <p role="status" className="text-sm font-semibold text-[#2A1D17]">
                  {t("auth.linkSent")}
                </p>
              )}
              {phase === "failed" && (
                <p role="alert" className="text-sm font-semibold text-[#A6401F]">
                  {t("auth.sendFailed")}
                </p>
              )}
              {phase === "invalid" && (
                <p role="alert" className="text-sm font-semibold text-[#A6401F]">
                  {t("auth.invalidEmail")}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
