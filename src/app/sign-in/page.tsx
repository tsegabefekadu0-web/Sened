"use client";

import Link from "next/link";
import React, { useEffect, useState, type FormEvent } from "react";

import { FIELD_CLASS, SimpleScreen } from "@/components/ui/SimpleScreen";
import { Button } from "@/components/ui/primitives";
import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { useSession } from "@/lib/auth/useSession";
import { peekPendingInvite } from "@/lib/ledger/clientInvites";
import { useT } from "@/lib/ui/useT";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Phase = "idle" | "sent" | "failed" | "invalid";

/** `/sign-in`: email magic link, with sign-out. Phone sign-in needs an SMS provider this project does not have. */
export default function SignInPage() {
  const { t } = useT();
  const session = useSession();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [signOutFailed, setSignOutFailed] = useState(false);

  // Signed in with an invite waiting (the person came here from /join): go back.
  useEffect(() => {
    if (session.status === "signed-in" && peekPendingInvite()) window.location.replace("/join");
  }, [session.status]);

  const sendLink = async (): Promise<boolean> => {
    const address = email.trim();
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
      const { error } = await client.auth.signInWithOtp({ email: address, options: { emailRedirectTo: `${window.location.origin}/sign-in` } });
      setPhase(error ? "failed" : "sent");
      return !error;
    } catch {
      setPhase("failed");
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

  return (
    <SimpleScreen title={session.status === "signed-in" ? t("auth.linkSignedIn") : t("auth.title")} subtitle="Sign in">
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
          <Link href="/" className="flex h-[54px] items-center justify-center rounded-[27px] bg-prim text-[17px] font-bold text-primt">
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
            <p role="alert" lang="am" className="m-0 text-sm font-bold" style={{ color: "var(--dng)" }}>
              {t("auth.signOutFailed")}
            </p>
          ) : null}
        </div>
      ) : null}

      {session.status === "signed-out" ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <p lang="am" className="m-0 text-base leading-[1.5] text-soft">
            {t("auth.page.intro")}
          </p>
          <label htmlFor="sign-in-email" className="flex flex-col gap-1.5">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("auth.emailLabel")}
            </span>
            <input
              id="sign-in-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setPhase("idle");
              }}
              placeholder={t("auth.emailPlaceholder")}
              aria-invalid={phase === "invalid"}
              className={FIELD_CLASS}
            />
          </label>
          <Button onPress={sendLink} successLabel={t("ui.signIn.sent")} errorLabel={t("ui.tryAgain")} icon="send">
            {t("auth.sendLink")}
          </Button>
          {phase === "sent" ? (
            <p role="status" lang="am" className="m-0 text-base font-bold leading-[1.5]">
              {t("auth.linkSent")}
            </p>
          ) : null}
          {phase === "failed" ? (
            <p role="alert" lang="am" className="m-0 text-base font-bold leading-[1.5]" style={{ color: "var(--dng)" }}>
              {t("auth.sendFailed")}
            </p>
          ) : null}
          {phase === "invalid" ? (
            <p role="alert" lang="am" className="m-0 text-base font-bold leading-[1.5]" style={{ color: "var(--dng)" }}>
              {t("auth.invalidEmail")}
            </p>
          ) : null}
        </form>
      ) : null}
    </SimpleScreen>
  );
}
