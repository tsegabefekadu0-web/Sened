"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState, type FormEvent } from "react";

import { FIELD_CLASS, SimpleScreen } from "@/components/ui/SimpleScreen";
import { Button } from "@/components/ui/primitives";
import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { completeProfileFromSignUp, postSignInPath } from "@/lib/auth/finishSignIn";
import { isEmailRateLimitError, isNoAccountError, RESEND_COOLDOWN_SECONDS } from "@/lib/auth/rateLimit";
import { clearSignUpDetails, formatPhone, stashSignUpDetails } from "@/lib/auth/signUpDetails";
import { useSession } from "@/lib/auth/useSession";
import { useT } from "@/lib/ui/useT";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Phase = "idle" | "sent" | "failed" | "invalid" | "limited" | "noAccount" | "nameMissing";

const ERROR_STYLE = { color: "var(--dng)" } as const;

/**
 * The sign-in and sign-up card. Both send an email with a link and a 6-digit
 * code; the code works when the link opens in a different browser than the app.
 * Sign-in never creates an account; sign-up does, and carries name and phone.
 */
export function AuthCard({ mode }: { readonly mode: "sign-in" | "sign-up" }) {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const signUp = mode === "sign-up";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [cooldown, setCooldown] = useState(0);
  const [code, setCode] = useState("");
  const [codeWrong, setCodeWrong] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const finishing = useRef(false);

  // Signed in (by the link or by the code): fill the profile if needed, then go on.
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    await completeProfileFromSignUp();
    router.replace(postSignInPath());
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (session.status === "signed-in") void finishRef.current();
  }, [session.status]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  const sendLink = async (): Promise<boolean> => {
    const address = email.trim();
    const fullName = name.trim();
    if (signUp && !fullName) {
      setPhase("nameMissing");
      return false;
    }
    if (!EMAIL_PATTERN.test(address)) {
      setPhase("invalid");
      return false;
    }
    const client = getBrowserSupabase();
    if (!client) {
      setPhase("failed");
      return false;
    }
    try {
      const phoneValue = formatPhone(phone);
      const { error } = await client.auth.signInWithOtp({
        email: address,
        options: {
          shouldCreateUser: signUp,
          emailRedirectTo: `${window.location.origin}/sign-in`,
          ...(signUp ? { data: { name: fullName, ...(phoneValue ? { phone: phoneValue } : {}) } } : {})
        }
      });
      if (error) {
        if (isNoAccountError(error)) {
          setPhase("noAccount");
          return false;
        }
        const limited = isEmailRateLimitError(error);
        setPhase(limited ? "limited" : "failed");
        if (limited) setCooldown(RESEND_COOLDOWN_SECONDS);
        return false;
      }
      if (signUp) stashSignUpDetails({ name: fullName, phone: phoneValue });
      else clearSignUpDetails();
      setCode("");
      setCodeWrong(false);
      setPhase("sent");
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch {
      setPhase("failed");
      return false;
    }
  };

  const verifyCode = async (): Promise<boolean> => {
    const client = getBrowserSupabase();
    if (code.length !== 6 || !client) {
      setCodeWrong(true);
      return false;
    }
    try {
      const { error } = await client.auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
      if (error) {
        setCodeWrong(true);
        return false;
      }
      await finish();
      return true;
    } catch {
      setCodeWrong(true);
      return false;
    }
  };

  const signOut = async () => {
    setSignOutFailed(false);
    try {
      const { error } = (await getBrowserSupabase()?.auth.signOut()) ?? { error: null };
      if (error) setSignOutFailed(true);
    } catch {
      setSignOutFailed(true);
    }
  };

  const differentEmail = () => {
    setPhase("idle");
    setCode("");
    setCodeWrong(false);
    setCooldown(0);
  };

  // The code step shows after a send, until the person chooses another email.
  const codeStep = phase === "sent";
  const title = session.status === "signed-in" ? t("auth.linkSignedIn") : signUp ? t("auth.signUp.title") : t("auth.title");
  const errorText: Partial<Record<Phase, string>> = {
    failed: t("auth.sendFailed"),
    limited: t("auth.rateLimited"),
    invalid: t("auth.invalidEmail"),
    nameMissing: t("auth.signUp.nameRequired")
  };
  const shownError = errorText[phase];

  return (
    <SimpleScreen title={title} subtitle={signUp ? "Sign up" : "Sign in"}>
      {session.status === "loading" ? (
        <p role="status" className="m-0 text-base text-soft">
          {t("auth.loading")}
        </p>
      ) : null}

      {session.status === "unconfigured" ? (
        <div role="alert" className="flex flex-col gap-3">
          <h2 lang="am" className="m-0 font-serif text-xl font-bold">
            {t("auth.notConfiguredTitle")}
          </h2>
          <p lang="am" className="m-0 text-base leading-[1.5] text-soft">
            {t("auth.notConfiguredBody")}
          </p>
          <Link href="/home" className="flex h-[54px] items-center justify-center rounded-[27px] bg-prim text-[17px] font-bold text-primt">
            {t("auth.notConfiguredAction")}
          </Link>
        </div>
      ) : null}

      {session.status === "signed-in" ? (
        <div className="flex flex-col gap-4">
          <p lang="am" data-testid="signed-in-as" className="m-0 text-lg font-bold">
            {session.email ? t("auth.signedInAs", { email: session.email }) : t("auth.signedInAnonymous")}
          </p>
          <button type="button" onClick={() => void signOut()} className="flex h-[54px] items-center justify-center gap-2 rounded-[27px] border-[1.5px] bg-card text-[17px] font-bold" style={{ borderColor: "var(--dng)", color: "var(--dng)" }}>
            {t("auth.signOut")}
          </button>
          {signOutFailed ? (
            <p role="alert" lang="am" className="m-0 text-sm font-bold" style={ERROR_STYLE}>
              {t("auth.signOutFailed")}
            </p>
          ) : null}
        </div>
      ) : null}

      {session.status === "signed-out" ? (
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-4">
          {codeStep ? (
            <form onSubmit={(e: FormEvent) => e.preventDefault()} noValidate className="flex flex-col gap-4">
              <p role="status" lang="am" className="m-0 text-base font-bold leading-[1.5]">
                {t("auth.sentTo", { email: email.trim() })}
              </p>
              <p lang="am" className="m-0 text-base leading-[1.5] text-soft">
                {t("auth.codeHint")}
              </p>
              <label htmlFor="auth-code" className="flex flex-col gap-1.5">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("auth.codeLabel")}
                </span>
                <input
                  id="auth-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setCodeWrong(false);
                  }}
                  aria-invalid={codeWrong}
                  className={`${FIELD_CLASS} text-center font-display tracking-[0.4em]`}
                />
              </label>
              {codeWrong ? (
                <p role="alert" lang="am" className="m-0 text-base font-bold leading-[1.5]" style={ERROR_STYLE}>
                  {t("auth.codeWrong")}
                </p>
              ) : null}
              <Button type="submit" onPress={verifyCode} disabled={code.length !== 6} errorLabel={t("ui.tryAgain")}>
                {t("auth.codeConfirm")}
              </Button>
              <Button variant="ghost" onPress={sendLink} disabled={cooldown > 0}>
                {cooldown > 0 ? t("auth.resendIn", { seconds: cooldown }) : t("auth.sendLink")}
              </Button>
              <button type="button" onClick={differentEmail} lang="am" className="flex min-h-12 items-center justify-center bg-transparent text-base font-bold text-soft underline">
                {t("auth.differentEmail")}
              </button>
            </form>
          ) : (
            <form onSubmit={(e: FormEvent) => e.preventDefault()} noValidate className="flex flex-col gap-4">
              <p lang="am" className="m-0 text-base leading-[1.5] text-soft">
                {signUp ? t("auth.signUp.intro") : t("auth.page.intro")}
              </p>
              {signUp ? (
                <label htmlFor="auth-name" className="flex flex-col gap-1.5">
                  <span lang="am" className="text-sm font-bold text-soft">
                    {t("auth.signUp.nameLabel")}
                  </span>
                  <input
                    id="auth-name"
                    type="text"
                    autoComplete="name"
                    maxLength={80}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setPhase("idle");
                    }}
                    aria-invalid={phase === "nameMissing"}
                    className={FIELD_CLASS}
                  />
                </label>
              ) : null}
              <label htmlFor="auth-email" className="flex flex-col gap-1.5">
                <span lang="am" className="text-sm font-bold text-soft">
                  {t("auth.emailLabel")}
                </span>
                <input
                  id="auth-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setPhase("idle");
                  }}
                  placeholder={t("auth.emailPlaceholder")}
                  aria-invalid={phase === "invalid" || phase === "noAccount"}
                  className={FIELD_CLASS}
                />
              </label>
              {signUp ? (
                <label htmlFor="auth-phone" className="flex flex-col gap-1.5">
                  <span lang="am" className="text-sm font-bold text-soft">
                    {t("auth.signUp.phoneLabel")}
                  </span>
                  <span className="flex gap-2">
                    <span className="flex h-[52px] items-center rounded-2xl border-[1.5px] border-[var(--chipb)] bg-hair2 px-3.5 font-display text-base font-bold">+251</span>
                    <input
                      id="auth-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      maxLength={14}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, ""))}
                      className={FIELD_CLASS}
                    />
                  </span>
                </label>
              ) : null}
              <Button type="submit" onPress={sendLink} disabled={cooldown > 0} successLabel={t("ui.signIn.sent")} errorLabel={t("ui.tryAgain")} icon="send">
                {cooldown > 0 ? t("auth.resendIn", { seconds: cooldown }) : signUp ? t("auth.signUp.cta") : t("auth.sendLink")}
              </Button>
              {shownError ? (
                <p role="alert" lang="am" className="m-0 text-base font-bold leading-[1.5]" style={ERROR_STYLE}>
                  {shownError}
                </p>
              ) : null}
              {phase === "noAccount" ? (
                <div role="alert" className="flex flex-col gap-1">
                  <p lang="am" className="m-0 text-base font-bold leading-[1.5]" style={ERROR_STYLE}>
                    {t("auth.noAccount")}
                  </p>
                  <Link href="/sign-up" lang="am" className="flex min-h-12 items-center text-base font-bold underline">
                    {t("auth.noAccountAction")}
                  </Link>
                </div>
              ) : null}
            </form>
          )}
          {!codeStep ? (
            <p lang="am" className="m-0 flex flex-wrap items-center justify-center gap-x-2 text-base text-soft">
              {signUp ? t("auth.signUp.haveAccount") : t("auth.signIn.newHere")}
              <Link href={signUp ? "/sign-in" : "/sign-up"} className="flex min-h-12 items-center font-bold text-ink underline">
                {signUp ? t("auth.title") : t("auth.signIn.createLink")}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </SimpleScreen>
  );
}
