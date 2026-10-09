"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSession } from "@/lib/auth/useSession";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { fetchLedgerBalances, readGroupLedger } from "@/lib/ledger/clientRead";
import { toSummaryEntry } from "@/lib/ledger/clientHome";
import { loadMembers, type MemberRow } from "@/lib/ledger/clientInvites";
import { listCycles, readDrawGroup } from "@/lib/draw/clientDraw";
import { formatEtbGrouped, toEtbMinorUnits } from "@/lib/ledger/money";
import type { SummaryEntry } from "@/lib/ledger/homeSummary";
import { toEthiopic } from "./geez";
import type { PillKind } from "@/components/ui/primitives";

export type MemberRole = "owner" | "treasurer" | "member";

export interface MemberView {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly role: MemberRole;
  readonly isMe: boolean;
  /** Has this member contributed in the current month. */
  readonly status: PillKind;
}

export interface LedgerRowView {
  readonly id: string;
  readonly sequence: number;
  /** Ethiopian month index, 0..12. */
  readonly month: number;
  readonly name: string;
  readonly initial: string;
  readonly amount: number;
  readonly channel: "telebirr" | "cbe" | "awash" | "cash" | "bank" | null;
  readonly ref: string | null;
  readonly kind: PillKind;
  readonly correction: boolean;
}

export interface CycleView {
  readonly cycleId: string;
  readonly name: string;
  readonly round: number;
  readonly totalRounds: number;
  readonly contribution: number | null;
  readonly pot: number;
}

export type CommunityMode = "sample" | "loading" | "live" | "empty" | "no-group" | "choose-group" | "error";

export interface CommunityView {
  readonly mode: CommunityMode;
  readonly groupId: string | null;
  readonly groupName: string;
  readonly role: MemberRole | null;
  readonly members: readonly MemberView[];
  readonly rows: readonly LedgerRowView[];
  /** The pot (ETB), whole birr. */
  readonly pot: number;
  readonly cycle: CycleView | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly accessToken: string | null;
  readonly reload: () => void;
}

const SAMPLE_NAMES: ReadonlyArray<readonly [string, string, MemberRole]> = [
  ["አቶ በቀለ ገ", "በ", "member"],
  ["ወ/ሮ አልማዝ ተ", "አ", "treasurer"],
  ["ወ/ሮ ጽጌ ከ", "ጽ", "member"],
  ["አቶ ታደሰ ወ", "ታ", "owner"],
  ["ወ/ሮ ፋጡማ አ", "ፋ", "member"],
  ["አቶ ዮሐንስ መ", "ዮ", "member"],
  ["ወ/ሮ ሙሉ በ", "ሙ", "member"],
  ["አቶ ከድር ሀ", "ከ", "member"]
];

const SAMPLE_STATUS: readonly PillKind[] = ["due", "paid", "due", "paid", "paid", "paid", "paid", "draft"];

/** The clearly-labelled sample community shown when nobody is signed in. */
export function sampleCommunity(): Omit<CommunityView, "reload" | "userId" | "email" | "accessToken"> {
  const cur = toEthiopic(new Date()).month;
  const members: MemberView[] = SAMPLE_NAMES.map(([name, initial, role], i) => ({
    id: `sample-${i}`,
    name,
    initial,
    role,
    isMe: i === 0,
    status: SAMPLE_STATUS[i]
  }));
  const ref = ["4KD91", "7T20X", "2PW68", "2PW68", "8HM13", "3QZ57", "6RV40"];
  const rows: LedgerRowView[] = [
    { name: SAMPLE_NAMES[1], ch: "telebirr", amt: 5000, kind: "paid", i: 0 },
    { name: SAMPLE_NAMES[3], ch: "cbe", amt: 5000, kind: "paid", i: 1 },
    { name: SAMPLE_NAMES[4], ch: "telebirr", amt: 4500, kind: "void", i: 2 },
    { name: SAMPLE_NAMES[4], ch: "telebirr", amt: 5000, kind: "fixed", i: 3 },
    { name: SAMPLE_NAMES[5], ch: "telebirr", amt: 5000, kind: "paid", i: 4 },
    { name: SAMPLE_NAMES[6], ch: "cbe", amt: 5000, kind: "paid", i: 5 },
    { name: SAMPLE_NAMES[7], ch: "telebirr", amt: 5000, kind: "draft", i: 6 }
  ].map((r) => ({
    id: `sample-row-${r.i}`,
    sequence: r.i + 1,
    month: cur,
    name: r.name[0],
    initial: r.name[1],
    amount: r.amt,
    channel: r.ch as LedgerRowView["channel"],
    ref: ref[r.i],
    kind: r.kind as PillKind,
    correction: r.kind === "fixed"
  }));
  return {
    mode: "sample",
    groupId: null,
    groupName: "የቦሌ ሰፈር እቁብ",
    role: "member",
    members,
    rows,
    pot: 25000,
    cycle: { cycleId: "sample", name: "የቦሌ ሰፈር እቁብ", round: 3, totalRounds: 8, contribution: 5000, pot: 40000 }
  };
}

function labelFor(userId: string, email: string | null): string {
  if (email) return email.split("@")[0];
  return `${userId.slice(0, 6)}`;
}

function initialOf(label: string): string {
  const ch = Array.from(label.trim())[0];
  return ch ? ch.toLocaleUpperCase() : "?";
}

function toNumber(minor: bigint): number {
  return Number(minor / 100n);
}

function netPot(entry: SummaryEntry, potId: string | null): bigint {
  let net = 0n;
  for (const p of entry.postings) {
    if (potId !== null && p.accountId !== potId) continue;
    const units = toEtbMinorUnits(p.amount);
    net += p.direction === "debit" ? units : -units;
  }
  return net;
}

/**
 * One read model for the whole app: the active community (name, role, members),
 * its ledger rows (append-only: a corrected row stays, struck through, beside
 * the correction that replaced it) and the pot. Signed out, it is the labelled
 * sample; signed in, it is read through the existing ledger, members and draw
 * client libraries.
 */
export function useCommunity(): CommunityView {
  const session = useSession();
  const group = useActiveGroup();
  const [state, setState] = useState<Omit<CommunityView, "reload" | "userId" | "email" | "accessToken"> | null>(null);
  const [round, setRound] = useState(0);
  const loadedFor = useRef<string | null>(null);
  const reload = useCallback(() => setRound((v) => v + 1), []);
  const sample = useMemo(() => sampleCommunity(), []);

  const signedIn = session.status === "signed-in";
  const groupReady = !group.provided || group.status !== "loading";
  const groupId = group.activeGroupId;
  const userId = session.status === "signed-in" ? (session.userId ?? null) : null;
  const email = session.status === "signed-in" ? session.email : null;
  const token = session.status === "signed-in" ? session.accessToken : null;

  useEffect(() => {
    if (!signedIn || !groupReady) {
      setState(null);
      loadedFor.current = null;
      return;
    }
    let active = true;
    const key = groupId ?? "";
    if (loadedFor.current !== key) setState(null);
    loadedFor.current = key;
    void (async () => {
      const ledger = await readGroupLedger({}, { groupId });
      if (!active) return;
      if (ledger.status !== "ok") {
        const mode: CommunityMode =
          ledger.status === "no-group" ? "no-group" : ledger.status === "choose-group" ? "choose-group" : "error";
        setState({ mode, groupId: null, groupName: "", role: null, members: [], rows: [], pot: 0, cycle: null });
        return;
      }
      const gid = ledger.groupId;
      const [membersRes, balances, drawGroup] = await Promise.all([
        loadMembers(gid),
        fetchLedgerBalances(gid),
        readDrawGroup({}, { groupId: gid }).catch(() => null)
      ]);
      if (!active) return;
      const memberRows: readonly MemberRow[] = membersRes.status === "ready" ? membersRes.members : [];
      const labels = new Map<string, string>();
      for (const m of memberRows) labels.set(m.userId, labelFor(m.userId, m.email));
      const potAccount = ledger.accounts.find((a) => a.code === "POT_CASH")?.id ?? null;

      const entries: SummaryEntry[] = [];
      for (const wire of ledger.entries) {
        const e = toSummaryEntry(wire);
        if (e) entries.push(e);
      }
      const corrected = new Set(entries.map((e) => e.correctsEntryId).filter((v): v is string => v !== null));
      const rows: LedgerRowView[] = [];
      for (const e of entries) {
        const isContribution = e.entryType === "contribution";
        const isCorrection = e.entryType === "correction";
        if (!isContribution && !isCorrection) continue;
        const net = netPot(e, potAccount);
        if (isContribution && net <= 0n && !corrected.has(e.id)) continue;
        if (isCorrection && net === 0n) continue;
        // A correction entry reverses (negative) or restates (positive) a payment; show the restatement.
        if (isCorrection && net < 0n) continue;
        const payer = e.attribution?.memberUserId ?? e.provenance?.memberUserId ?? null;
        const name = payer ? (labels.get(payer) ?? labelFor(payer, null)) : "—";
        const provider = e.provenance?.provider ?? null;
        const ch = e.attribution?.channel ?? null;
        const channel: LedgerRowView["channel"] = provider ?? (ch === "cash" ? "cash" : ch ? "bank" : null);
        const date = new Date(e.occurredAt);
        const kind: PillKind = corrected.has(e.id) ? "void" : isCorrection ? "fixed" : e.provenance ? "paid" : "saved";
        rows.push({
          id: e.id,
          sequence: Number(e.sequence),
          month: toEthiopic(Number.isNaN(date.getTime()) ? new Date() : date).month,
          name,
          initial: initialOf(name),
          amount: toNumber(net < 0n ? -net : net),
          channel,
          ref: e.provenance?.referenceMasked ?? null,
          kind,
          correction: isCorrection
        });
      }
      rows.sort((a, b) => a.sequence - b.sequence);

      const curMonth = toEthiopic(new Date()).month;
      const paidNow = new Set<string>();
      for (const e of entries) {
        const payer = e.attribution?.memberUserId ?? e.provenance?.memberUserId;
        if (payer && e.entryType === "contribution" && !corrected.has(e.id) && toEthiopic(new Date(e.occurredAt)).month === curMonth) {
          paidNow.add(payer);
        }
      }
      const members: MemberView[] = memberRows.map((m) => {
        const label = labelFor(m.userId, m.email);
        return {
          id: m.userId,
          name: label,
          initial: initialOf(label),
          role: m.role,
          isMe: userId !== null && m.userId === userId,
          status: paidNow.has(m.userId) ? "paid" : "due"
        };
      });

      let pot = 0;
      if (balances.status === "ok") {
        const p = balances.balances.find((b) => b.code === "POT_CASH");
        if (p) {
          try {
            pot = toNumber(toEtbMinorUnits(p.balance.replace("-", "")));
          } catch {
            pot = 0;
          }
        }
      }

      let cycle: CycleView | null = null;
      try {
        const cycles = await listCycles(gid);
        if (cycles.ok) {
          const open = cycles.data.find((c) => c.closedAt === null) ?? cycles.data[0];
          if (open) {
            cycle = {
              cycleId: open.cycleId,
              name: open.name,
              round: open.nextRound ?? open.totalRounds,
              totalRounds: open.totalRounds,
              contribution: open.contributionAmount ? Number(open.contributionAmount) : null,
              pot: Number(open.potAmount)
            };
          }
        }
      } catch {
        cycle = null;
      }
      if (!active) return;
      const info = group.groups.find((g) => g.groupId === gid);
      setState({
        mode: entries.length === 0 && members.length === 0 ? "empty" : "live",
        groupId: gid,
        groupName: info?.name ?? "",
        role: (drawGroup && drawGroup.status === "ok" ? (drawGroup.group.role as MemberRole | null) : (info?.role ?? null)) ?? null,
        members,
        rows,
        pot,
        cycle
      });
    })();
    return () => {
      active = false;
    };
    // `group.groups` only supplies the display name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, groupReady, groupId, round, userId]);

  if (session.status === "loading") {
    return { ...sample, mode: "loading", userId, email, accessToken: token, reload };
  }
  if (!signedIn) {
    return { ...sample, userId: null, email: null, accessToken: null, reload };
  }
  if (state === null) {
    return { ...sample, mode: "loading", userId, email, accessToken: token, reload };
  }
  return { ...state, userId, email, accessToken: token, reload };
}

export function formatBirr(n: number): string {
  return formatEtbGrouped(`${Math.round(n)}.00`).replace(/\.00$/, "");
}
