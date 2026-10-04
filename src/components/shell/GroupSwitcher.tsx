"use client";

import React, { useId } from "react";

import { shortGroupId, type GroupOption } from "@/lib/groups/activeGroup";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";

const ROLE_KEYS: Record<NonNullable<GroupOption["role"]>, MessageKey> = {
  owner: "groups.role.owner",
  treasurer: "groups.role.treasurer",
  member: "groups.role.member"
};

type Tone = "dark" | "light";

const TONES: Record<Tone, { readonly label: string; readonly control: string; readonly hint: string }> = {
  dark: {
    label: "text-[#D4A244]",
    control: "border-[#5A463C] bg-[#2A1D17] text-[#F7F2EB] focus-visible:ring-[#D4A244]",
    hint: "text-[#E7C978]"
  },
  light: {
    label: "text-[#8A4B2A]",
    control: "border-[#DECDBB] bg-white text-[#1F1714] focus-visible:ring-[#C6532B]",
    hint: "text-[#8A4B2A]"
  }
};

/**
 * Which of the signed-in user's groups the whole app is acting on.
 *
 * Shows the active group's name and the user's role there. With one group it is
 * a plain line of text (nothing to choose); with several it is a native
 * `<select>`, so the keyboard, screen-reader and phone-picker behaviour is the
 * platform's own. Until the user has chosen, the select shows a placeholder and
 * a status line says why every group-bound screen is waiting.
 *
 * Renders nothing when nobody is signed in, while the groups load, or when the
 * user has no group (each screen already says so in its own words).
 */
export function GroupSwitcher({
  locale,
  tone = "light",
  className = ""
}: {
  readonly locale: Locale;
  readonly tone?: Tone;
  readonly className?: string;
}) {
  const t = createTranslator(locale);
  const id = useId();
  const { provided, status, groups, activeGroupId, needsChoice, stale, select } = useActiveGroup();
  if (!provided || status !== "ready" || groups.length === 0) {
    return null;
  }
  const colors = TONES[tone];

  const nameCounts = new Map<string, number>();
  for (const group of groups) {
    nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  }
  const roleLabel = (group: GroupOption) => (group.role === null ? "" : t(ROLE_KEYS[group.role]));
  const nameLabel = (group: GroupOption) => {
    const base = group.name === "" ? t("groups.unnamed", { id: shortGroupId(group.groupId) }) : group.name;
    // Two groups with the same name stay distinguishable by a piece of the id.
    return group.name !== "" && (nameCounts.get(group.name) ?? 0) > 1 ? `${base} (${shortGroupId(group.groupId)})` : base;
  };
  const optionLabel = (group: GroupOption) => {
    const role = roleLabel(group);
    return role === "" ? nameLabel(group) : `${nameLabel(group)} · ${role}`;
  };

  if (groups.length === 1) {
    const only = groups[0];
    return (
      <p
        data-testid="group-switcher"
        className={`min-w-0 truncate text-xs font-semibold ${colors.label} ${className}`}
        title={optionLabel(only)}
      >
        {t("groups.switcher.single", { name: nameLabel(only), role: roleLabel(only) })}
      </p>
    );
  }

  return (
    <div data-testid="group-switcher" className={`min-w-0 ${className}`}>
      <label htmlFor={id} className={`block text-[11px] font-bold uppercase tracking-wide ${colors.label}`}>
        {t("groups.switcher.label")}
      </label>
      <select
        id={id}
        value={needsChoice || activeGroupId === null ? "" : activeGroupId}
        onChange={(event) => select(event.target.value)}
        aria-describedby={needsChoice ? `${id}-hint` : undefined}
        className={`mt-1 block min-h-11 w-full min-w-0 max-w-full rounded-xl border px-3 text-sm font-semibold focus:outline-none focus-visible:ring-2 ${colors.control}`}
      >
        {(needsChoice || activeGroupId === null) && (
          <option value="" disabled>
            {t("groups.switcher.choose")}
          </option>
        )}
        {groups.map((group) => (
          <option key={group.groupId} value={group.groupId}>
            {optionLabel(group)}
          </option>
        ))}
      </select>
      {needsChoice && (
        <p id={`${id}-hint`} role="status" className={`mt-1 text-xs font-semibold ${colors.hint}`}>
          {t("groups.switcher.chooseHint")}
        </p>
      )}
      {stale && <p className={`mt-1 text-[11px] ${colors.hint}`}>{t("groups.switcher.stale")}</p>}
    </div>
  );
}
