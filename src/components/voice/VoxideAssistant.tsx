"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { VoxideClient, VoxideWidget, type VoxideActionConfig, type VoxideParams } from "@voxide/react";

import { setLocaleOverride, useAppLocale } from "@/lib/appLocale";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { createTranslator } from "@/lib/i18n";
import { createCapabilities, type Capability } from "@/lib/voice/capabilities";

/**
 * The Voxide voice assistant (https://voxide.app): a widget backed by a live
 * model that calls the capabilities in `src/lib/voice/capabilities.ts`.
 *
 * It answers in English. Amharic speech goes through the app's own Amharic
 * voice button; the assistant tells people so when they ask for Amharic.
 *
 * Mounted once, from the root layout (through `VoxideAssistantLazy`), because
 * a widget that remounts on navigation cuts a call in progress. With no
 * `NEXT_PUBLIC_VOXIDE_KEY` it renders nothing and makes no request, so the app
 * builds and runs exactly as before. The key is a publishable one
 * (`vox_pub_...`); it is safe in the browser and is bound to the domains
 * whitelisted in the Voxide dashboard.
 */

const ACCENT = "#C6532B";

/** Voxide's registration shape for one capability. */
export function toVoxideAction(capability: Capability): VoxideActionConfig {
  const params: VoxideParams = {};
  for (const [name, rule] of Object.entries(capability.params)) {
    params[name] = {
      type: rule.type,
      ...(rule.required ? { required: true } : {}),
      ...(rule.description ? { description: rule.description } : {}),
      ...(rule.enum ? { enum: [...rule.enum] } : {}),
      ...(rule.sensitive ? { sensitive: true } : {})
    };
  }
  return {
    description: capability.description,
    params,
    dangerous: capability.dangerous,
    handler: (args) => capability.handler(args)
  };
}

export function VoxideAssistant({ publicKey }: { readonly publicKey?: string }) {
  const key = (publicKey ?? process.env.NEXT_PUBLIC_VOXIDE_KEY ?? "").trim();
  if (key === "") {
    return null;
  }
  return <VoxideAssistantMounted publicKey={key} />;
}

function VoxideAssistantMounted({ publicKey }: { readonly publicKey: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [locale] = useAppLocale("am");
  const group = useActiveGroup();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [client, setClient] = useState<VoxideClient | null>(null);

  // The handlers are registered once; they read the latest values from here.
  const live = useRef({ pathname, locale, groupId: group.activeGroupId, groupName: group.active?.name ?? "" });
  live.current = { pathname, locale, groupId: group.activeGroupId, groupName: group.active?.name ?? "" };
  const routerRef = useRef(router);
  routerRef.current = router;
  const confirmText = useRef("");
  confirmText.current = t("assistant.confirmDraft");

  useEffect(() => {
    let created: VoxideClient | null = null;
    try {
      created = new VoxideClient({ publicKey, language: "en-US" });
      const capabilities = createCapabilities({
        getActiveGroupId: () => live.current.groupId,
        getRoute: () => live.current.pathname ?? "/",
        getLocale: () => live.current.locale,
        setLocale: setLocaleOverride,
        navigate: (path) => routerRef.current.push(path)
      });
      created.register(Object.fromEntries(capabilities.map((capability) => [capability.name, toVoxideAction(capability)])));
      // Only what is on screen and harmless: never a token, an id or an amount.
      created.bindState(() => ({
        route: live.current.pathname ?? "/",
        uiLanguage: live.current.locale,
        activeGroupName: live.current.groupName
      }));
      // The dangerous draft capability asks first, in the person's own language.
      created.onConfirmation(async () => window.confirm(confirmText.current));
      setClient(created);
    } catch {
      // A broken or unreachable assistant must never break the app.
      setClient(null);
    }
    return () => {
      try {
        created?.destroy();
      } catch {
        // Nothing to clean up.
      }
      setClient(null);
    };
  }, [publicKey]);

  useEffect(() => {
    client?.configureUI({
      accentColor: ACCENT,
      title: t("assistant.title"),
      subtitle: t("assistant.subtitle"),
      greeting: t("assistant.greeting"),
      placeholder: t("assistant.placeholder"),
      launcherLabel: t("assistant.launcherLabel"),
      launcherSize: "md",
      starters: [t("assistant.starter.status"), t("assistant.starter.next"), t("assistant.starter.pending")]
    });
  }, [client, t]);

  if (client === null) {
    return null;
  }
  return <VoxideWidget client={client} accentColor={ACCENT} theme="light" position="bottom-right" title={t("assistant.title")} />;
}

export default VoxideAssistant;
