"use client";

import Link from "next/link";
import React from "react";

import { useT } from "@/lib/ui/useT";
import { AppHeader, LanguageSwitch } from "./AppHeader";
import { Card, Screen } from "./primitives";

/** A plain single-card screen: brand header with the language switch, one card, a way home. */
export function SimpleScreen({
  title,
  subtitle,
  children,
  homeLink = true
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
  readonly homeLink?: boolean;
}) {
  const { t } = useT();
  return (
    <Screen>
      <main className="flex grow flex-col">
        <AppHeader title={title} subtitle={subtitle} bottom={72} ribbon={32} right={<LanguageSwitch />} />
        <Card className="snd-rise flex flex-col gap-4 p-5" style={{ margin: "-34px 16px 0" }}>
          {children}
        </Card>
        {homeLink ? (
          <Link href="/" className="mx-auto mt-4 flex min-h-12 items-center px-4 text-base font-bold text-soft">
            {t("ui.back.home")}
          </Link>
        ) : null}
        <div style={{ height: 28 }} />
      </main>
    </Screen>
  );
}

export const FIELD_CLASS =
  "box-border h-[52px] w-full rounded-2xl border-[1.5px] border-[var(--chipb)] bg-field px-4 text-[17px] text-ink placeholder:text-muted";
