"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/ui/AppHeader";
import { Icon } from "@/components/ui/Icon";
import { ProfileAvatar } from "@/components/ui/ProfileAvatar";
import { Button, Card, Screen } from "@/components/ui/primitives";
import { SlideSwitch } from "@/components/ui/SlideSwitch";
import { useSession } from "@/lib/auth/useSession";
import { photoToDataUrl, useProfile } from "@/lib/ui/profile";
import { useT } from "@/lib/ui/useT";

const FIELD =
  "box-border h-[52px] w-full rounded-2xl border-[1.5px] border-[var(--chipb)] bg-field px-4 text-[17px] text-ink placeholder:text-muted";

/** Edit profile. Name, phone and photo are kept on this device; the email is the sign-in address. */
export default function EditProfilePage() {
  const { t, locale, setLocale } = useT();
  const session = useSession();
  const [profile, save] = useProfile();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const email = session.status === "signed-in" ? (session.email ?? "") : "";

  useEffect(() => {
    if (ready) return;
    setName(profile.name);
    setPhone(profile.phone);
    setPhoto(profile.photo);
    if (profile.name || profile.phone || profile.photo) setReady(true);
  }, [profile, ready]);

  const initial = Array.from((name || email || "?").trim())[0]?.toLocaleUpperCase() ?? "?";

  return (
    <Screen>
      <main className="flex grow flex-col">
        <AppHeader back="/account" backLabel={t("ui.back")} title={t("ui.edit.title")} subtitle="Edit profile" bottom={96} ribbon={52} />
        <Card className="snd-rise flex flex-col gap-[18px]" style={{ margin: "-44px 16px 0", padding: "22px 18px" }}>
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 shrink-0">
              <ProfileAvatar initial={initial} photo={photo} size={96} />
              <button
                type="button"
                aria-label={t("ui.account.editPhoto")}
                onClick={() => file.current?.click()}
                className="absolute flex h-11 w-11 items-center justify-center rounded-full bg-prim p-0 text-primt"
                style={{ right: -6, bottom: -4, border: "3px solid var(--card)" }}
              >
                <Icon name="camera" size={20} />
              </button>
              <input
                ref={file}
                type="file"
                accept="image/jpeg,image/png"
                className="sr-only"
                aria-label={t("ui.account.editPhoto")}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const url = await photoToDataUrl(f);
                  if (url) setPhoto(url);
                }}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span lang="am" className="font-serif text-xl font-bold leading-[1.3]">
                {t("ui.account.editPhoto")}
              </span>
              <span lang="am" className="text-sm text-muted">
                JPG · PNG
              </span>
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("ui.edit.fullName")}
            </span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={FIELD} maxLength={80} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("ui.field.phone")}
            </span>
            <span className="flex gap-2">
              <span className="flex h-[52px] items-center rounded-2xl border-[1.5px] border-[var(--chipb)] bg-hair2 px-3.5 font-display text-base font-bold">+251</span>
              <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, ""))} className={FIELD} maxLength={14} />
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("ui.field.email")}
            </span>
            <input type="email" value={email} readOnly aria-readonly="true" className={`${FIELD} opacity-70`} />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("ui.language")}
            </span>
            <SlideSwitch checked={locale === "en"} onChange={(on) => setLocale(on ? "en" : "am")} label={t("ui.language")} left="አማርኛ" right="English" />
          </div>
        </Card>
        <div className="flex flex-col gap-2" style={{ margin: "22px 16px 0" }}>
          <Button
            onPress={() => save({ name: name.trim(), phone: phone.trim(), photo })}
            successLabel={t("ui.status.saved")}
            errorLabel={t("ui.tryAgain")}
          >
            {t("ui.draft.save")}
          </Button>
          <Link href="/account" lang="am" className="flex min-h-12 items-center justify-center text-base font-bold text-soft">
            {t("ui.cancel")}
          </Link>
        </div>
        <p lang="am" className="mx-6 mb-6 mt-2 text-sm leading-[1.5] text-muted">
          {t("ui.edit.localNote")}
        </p>
      </main>
    </Screen>
  );
}
