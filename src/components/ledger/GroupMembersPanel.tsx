"use client";

import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Link2, UserCog, UsersRound } from "lucide-react";

import { useSession } from "@/lib/auth/useSession";
import {
  buildJoinUrl,
  createInviteLink,
  loadInvites,
  loadMembers,
  loadMyGroup,
  revokeInviteLink,
  setTreasurer,
  type CreatedInvite,
  type InviteRow,
  type MemberRow
} from "@/lib/ledger/clientInvites";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";

type Group = { readonly groupId: string; readonly role: "owner" | "treasurer" | "member" };
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "message"; readonly key: MessageKey }
  | { readonly kind: "ready"; readonly group: Group; readonly members: readonly MemberRow[] };

const EXPIRY_OPTIONS: ReadonlyArray<{ readonly hours: number; readonly label: MessageKey }> = [
  { hours: 24, label: "invites.expiry.day" },
  { hours: 168, label: "invites.expiry.week" },
  { hours: 720, label: "invites.expiry.month" }
];

const ROLE_LABEL: Record<MemberRow["role"], MessageKey> = {
  owner: "members.role.owner",
  treasurer: "members.role.treasurer",
  member: "members.role.member"
};

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale === "am" ? "am-ET" : "en-GB", { dateStyle: "medium" }).format(date);
}

/**
 * "Group members" on `/ledger`. Everyone sees the member list and roles. The
 * owner also creates and revokes invite links and toggles the treasurer role.
 * The page only presents what the API allows; every decision is made in SQL.
 */
export function GroupMembersPanel({ locale }: { readonly locale: Locale }) {
  const t = createTranslator(locale);
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [invites, setInvites] = useState<readonly InviteRow[]>([]);
  const [invitesFailed, setInvitesFailed] = useState(false);
  const [expiryHours, setExpiryHours] = useState(168);
  const [maxUses, setMaxUses] = useState("1");
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [created, setCreated] = useState<(CreatedInvite & { readonly url: string }) | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [actionFailed, setActionFailed] = useState<"role" | "revoke" | null>(null);

  const refresh = useCallback(async () => {
    const mine = await loadMyGroup();
    if (mine.status === "no-group") return setLoad({ kind: "message", key: "members.noGroup" });
    if (mine.status === "multiple-groups") return setLoad({ kind: "message", key: "members.multipleGroups" });
    if (mine.status !== "ready") return setLoad({ kind: "message", key: "members.error" });
    const list = await loadMembers(mine.groupId);
    if (list.status !== "ready") return setLoad({ kind: "message", key: "members.error" });
    setLoad({ kind: "ready", group: { groupId: mine.groupId, role: mine.role }, members: list.members });
    if (mine.role === "owner") {
      const result = await loadInvites(mine.groupId);
      setInvitesFailed(result.status !== "ready");
      setInvites(result.status === "ready" ? result.invites.filter((invite) => invite.status === "active") : []);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    setLoad({ kind: "loading" });
    void refresh();
  }, [signedIn, refresh]);

  if (!signedIn) {
    return (
      <PanelShell t={t}>
        <p className="text-sm text-inkMuted" role={session.status === "loading" ? "status" : undefined}>
          {session.status === "loading" ? t("members.loading") : t("members.signedOut")}
        </p>
      </PanelShell>
    );
  }
  if (load.kind === "loading") {
    return (
      <PanelShell t={t}>
        <p role="status" className="text-sm text-inkMuted">{t("members.loading")}</p>
      </PanelShell>
    );
  }
  if (load.kind === "message") {
    return (
      <PanelShell t={t}>
        <p role="status" className="text-sm text-inkMuted">{t(load.key)}</p>
      </PanelShell>
    );
  }

  const { group, members } = load;
  const isOwner = group.role === "owner";

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1 || uses > 50) {
      setCreateFailed(true);
      return;
    }
    setCreating(true);
    setCreateFailed(false);
    setCopyState("idle");
    const result = await createInviteLink({ groupId: group.groupId, expiresInHours: expiryHours, maxUses: uses });
    setCreating(false);
    if (result.status !== "created") {
      setCreateFailed(true);
      return;
    }
    setCreated({ ...result, url: buildJoinUrl(window.location.origin, result.token) });
    void refresh();
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function revoke(inviteId: string) {
    setActionFailed(null);
    const result = await revokeInviteLink(inviteId);
    if (result.status !== "ok") {
      setActionFailed("revoke");
      return;
    }
    setInvites((current) => current.filter((invite) => invite.inviteId !== inviteId));
  }

  async function toggleTreasurer(member: MemberRow) {
    setActionFailed(null);
    const role = member.role === "treasurer" ? "member" : "treasurer";
    const result = await setTreasurer({ groupId: group.groupId, userId: member.userId, role });
    if (result.status !== "ok") {
      setActionFailed("role");
      return;
    }
    void refresh();
  }

  return (
    <PanelShell t={t}>
      <ul className="divide-y divide-coffee-900/10 rounded-2xl border border-coffee-900/15 bg-parchment-50" data-testid="member-list">
        {members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-coffee-900">
                {member.email ?? t("members.anonymous", { id: member.userId.slice(0, 8) })}
              </p>
              <p className="text-xs text-inkMuted">
                {t(ROLE_LABEL[member.role])} · {t("members.joined", { date: formatDate(member.joinedAt, locale) })}
              </p>
            </div>
            {isOwner && member.role !== "owner" && (
              <button
                type="button"
                onClick={() => void toggleTreasurer(member)}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-coffee-900/15 px-3 text-sm font-semibold text-coffee-900 transition-colors hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
              >
                <UserCog aria-hidden="true" className="h-4 w-4" />
                {member.role === "treasurer" ? t("members.removeTreasurer") : t("members.makeTreasurer")}
              </button>
            )}
          </li>
        ))}
      </ul>

      {actionFailed && (
        <p role="alert" className="mt-3 text-sm font-semibold text-terracotta-700">
          {actionFailed === "role" ? t("members.roleFailed") : t("invites.revokeFailed")}
        </p>
      )}

      {isOwner && (
        <div className="mt-8 space-y-6">
          <form onSubmit={(event) => void create(event)} noValidate aria-label={t("invites.create")} className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="invite-expiry" className="block text-sm font-bold text-coffee-900">{t("invites.expiryLabel")}</label>
              <select
                id="invite-expiry"
                value={expiryHours}
                onChange={(event) => setExpiryHours(Number(event.target.value))}
                className="mt-2 min-h-11 rounded-xl border border-coffee-900/15 bg-white px-3 text-coffee-900"
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.hours} value={option.hours}>{t(option.label)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="invite-uses" className="block text-sm font-bold text-coffee-900">{t("invites.usesLabel")}</label>
              <input
                id="invite-uses"
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
                className="mt-2 min-h-11 w-24 rounded-xl border border-coffee-900/15 bg-white px-3 text-coffee-900"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-terracotta-600 px-4 text-sm font-bold text-white transition-colors hover:bg-terracotta-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2"
            >
              <Link2 aria-hidden="true" className="h-4 w-4" />
              {creating ? t("invites.creating") : t("invites.create")}
            </button>
          </form>

          {createFailed && (
            <p role="alert" className="text-sm font-semibold text-terracotta-700">{t("invites.createFailed")}</p>
          )}

          {created && (
            <div className="rounded-2xl border border-coffee-900/15 bg-parchment-50 p-4" data-testid="created-invite">
              <p role="status" className="text-sm font-semibold text-coffee-900">{t("invites.created")}</p>
              <label htmlFor="invite-link" className="mt-3 block text-xs font-bold text-inkMuted">{t("invites.linkLabel")}</label>
              <div className="mt-1 flex flex-wrap gap-2">
                <input
                  id="invite-link"
                  readOnly
                  value={created.url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-coffee-900/15 bg-white px-3 text-xs text-coffee-900"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-coffee-900/15 px-3 text-sm font-semibold text-coffee-900 hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
                >
                  <Copy aria-hidden="true" className="h-4 w-4" />
                  {copyState === "copied" ? t("invites.copied") : t("invites.copy")}
                </button>
              </div>
              {copyState === "failed" && (
                <p role="alert" className="mt-2 text-xs font-semibold text-terracotta-700">{t("invites.copyFailed")}</p>
              )}
              <p className="mt-2 text-xs text-inkMuted">
                {t("invites.expiresOn", { date: formatDate(created.expiresAt, locale) })} · {t("invites.uses", { used: 0, max: created.maxUses })}
              </p>
            </div>
          )}

          <div>
            <h3 className="text-base font-bold text-coffee-950">{t("invites.activeTitle")}</h3>
            {invitesFailed && <p role="alert" className="mt-2 text-sm text-terracotta-700">{t("invites.listFailed")}</p>}
            {invites.length === 0 && !invitesFailed ? (
              <p className="mt-2 text-sm text-inkMuted">{t("invites.none")}</p>
            ) : (
              <ul className="mt-3 space-y-2" data-testid="invite-list">
                {invites.map((invite) => (
                  <li key={invite.inviteId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coffee-900/15 bg-parchment-50 px-4 py-3">
                    <p className="text-xs text-inkMuted">
                      {t("invites.expiresOn", { date: formatDate(invite.expiresAt, locale) })} · {t("invites.uses", { used: invite.useCount, max: invite.maxUses })}
                    </p>
                    <button
                      type="button"
                      onClick={() => void revoke(invite.inviteId)}
                      className="min-h-11 rounded-xl border border-terracotta px-3 text-sm font-semibold text-terracotta-700 hover:bg-terracotta-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
                    >
                      {t("invites.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </PanelShell>
  );
}

function PanelShell({ t, children }: { readonly t: ReturnType<typeof createTranslator>; readonly children: React.ReactNode }) {
  return (
    <section id="members" aria-labelledby="members-heading" className="scroll-mt-8 border-t border-coffee-900/10 py-12 sm:py-16">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-coffee-900 text-gold-300">
          <UsersRound aria-hidden="true" className="h-5 w-5" />
        </span>
        <h2 id="members-heading" className="text-3xl font-bold tracking-tight text-coffee-950">{t("members.title")}</h2>
      </div>
      <p className="mt-5 mb-6 max-w-xl text-base leading-7 text-inkMuted">{t("members.description")}</p>
      {children}
    </section>
  );
}
