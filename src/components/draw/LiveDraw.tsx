"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import {
  canRunTreasurerSteps,
  clearSeal,
  commitDraw,
  createCycle,
  drawErrorKey,
  fetchVerification,
  listCycles,
  normaliseAmount,
  openDraw,
  postPayout,
  randomHex,
  readCollateral,
  readContributions,
  readCycle,
  readDraft,
  readDrawGroup,
  readSeal,
  readSession,
  revealDraw,
  sealForDraw,
  sealStanding,
  sendGuarantee,
  setContributionGate,
  submitNonce,
  submitSeal,
  userIdFromAccessToken,
  verifyInBrowser,
  writeDraft,
  writeSeal,
  type BrowserCheck,
  type DisagreementKind,
  type DrawDraft,
  type DrawFailure,
  type DrawGroup,
  type GuaranteeCommand,
  type MySeal,
  type PayoutReceipt,
  type WireVerify
} from "@/lib/draw/clientDraw";
import { loadCycleLedgerFigures, type LedgerFiguresResult } from "@/lib/draw/ledgerFigures";
import { triggerHaptic } from "@/lib/draw/haptics";
import { useActiveGroupPreference } from "@/lib/groups/useActiveGroup";
import { previewGate } from "@/lib/draw/contributions";
import { DRAW_CONTRIBUTION_GATES } from "@/lib/draw/types";
import type { DrawContributionGate, DrawCycleRecord, DrawGateFlag, DrawListEntry, DrawSessionView } from "@/lib/draw/types";
import { translate, type MessageKey } from "@/lib/i18n";
import { formatEtbDisplay, formatEtbMinorUnits, toEtbMinorUnits } from "@/lib/ledger/money";

import { usePrefersReducedMotion } from "./DrawBoard";
import { MesobCeremony, type CeremonyPhase } from "./MesobCeremony";
import { CollateralPanel, type CollateralOutcome, type CollateralState } from "./CollateralPanel";
import { ContributionGrid, type ContributionsState, type GateOutcome } from "./ContributionGrid";
import { RiskPanel } from "./RiskPanel";
import { VerifyPanel } from "./VerifyPanel";
import { liveCopy, t as drawCopy, type DrawLiveKey, type Locale } from "./copy";
import "./draw.css";

export interface LiveDrawProps {
  readonly locale: Locale;
  /** The signed-in session's access token (used only to say whose seal this is). */
  readonly accessToken: string;
  /** Injectable for tests; production uses the browser session. */
  readonly deps?: AuthedFetchDeps;
}

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "message"; readonly key: DrawLiveKey }
  | { readonly kind: "ready"; readonly group: DrawGroup };

interface Problem {
  readonly key: MessageKey;
  readonly vars?: Record<string, string | number>;
  readonly detail?: string | null;
}

interface CycleDetail {
  readonly cycle: DrawCycleRecord;
  readonly draws: readonly DrawListEntry[];
}

const CARD = "sened-draw-shell rounded-[22px] border border-[#DCCFC7] p-4 shadow-card";
const HEADING = "font-ethiopic text-[15px] font-bold tracking-wide text-[#1C1410]";
const FIELD =
  "mt-1 w-full rounded-xl border border-[#DCCFC7] bg-white px-3 py-2 font-sans text-[13px] text-[#1C1410]";
const LABEL = "block text-[11px] font-semibold text-[#6F625D]";
const HINT = "mt-1 text-[11px] leading-4 text-[#6F625D]";
const BUTTON =
  "min-h-11 w-full rounded-2xl bg-[#C6532B] px-4 py-3 font-ethiopic text-[14px] font-bold tracking-wide text-[#FAF6F0] disabled:opacity-50";
const SECONDARY =
  "min-h-9 rounded-xl border border-[#453630] px-3 font-sans text-[12px] font-semibold text-[#1C1410] disabled:opacity-50";
const NOTICE =
  "mt-2 rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-2 text-[12px] font-semibold text-[#6B4E16]";
const GOOD = "mt-2 text-[12px] font-semibold text-[#065F46]";
const BAD = "mt-2 text-[12px] font-semibold text-[#863214]";

function shortId(id: string): string {
  return id.slice(0, 8);
}

function newKey(prefix: string): string {
  return `${prefix}.${globalThis.crypto.randomUUID()}`;
}

/** How many members the cycle's pot was sized for: the pot divided by the contribution. */
function potMembers(cycle: DrawCycleRecord): number | null {
  if (cycle.contributionAmount === null) return null;
  try {
    const each = toEtbMinorUnits(cycle.contributionAmount, true);
    return Number(toEtbMinorUnits(cycle.potAmount, true) / each);
  } catch {
    return null;
  }
}

/** The draw a screen should open on: the live one, else the latest. */
function pickDraw(draws: readonly DrawListEntry[]): DrawListEntry | null {
  const live = [...draws].reverse().find((entry) => !entry.superseded && !entry.legacy && entry.state !== "paid");
  return live ?? draws[draws.length - 1] ?? null;
}

/** Flagged rounds grouped by member, members in order of first appearance, rounds ascending. */
function flaggedByMember(flags: readonly DrawGateFlag[]): readonly (readonly [string, readonly number[]])[] {
  const byMember = new Map<string, number[]>();
  for (const flag of flags) {
    const rounds = byMember.get(flag.memberId) ?? [];
    rounds.push(flag.round);
    byMember.set(flag.memberId, rounds);
  }
  return [...byMember.entries()].map(([memberId, rounds]) => [memberId, rounds.sort((left, right) => left - right)] as const);
}

/**
 * The signed-in draw: the real flow, through `/api/draw/*`.
 *
 *   cycle   owner/treasurer creates it (contribution, rounds, reserve); everyone lists it
 *   open    owner/treasurer opens a draw; the server creates its id
 *   SEAL    each member seals a nonce for themselves (`POST /api/draw/seals`)
 *   commit  owner/treasurer commits over the roster and the seals the server holds
 *   RELEASE each member releases their own nonce, only once the commit is published
 *   reveal  owner/treasurer reveals with the seed; the server supplies the nonces
 *   verify  any member; the browser recomputes the result
 *   payout  owner/treasurer, after an explicit confirmation
 *
 * The nonce is generated on this device, kept here until the commitment is
 * published, and never rendered. The server's verdict is never displayed as the
 * answer: a revealed draw is recomputed here from the published values and the
 * two are compared.
 */
export function LiveDraw(props: LiveDrawProps) {
  // The draw follows the app's active group (see `GroupSwitcher`). It waits for
  // the groups to resolve, and a different group remounts the whole ceremony so
  // nothing of one group's cycle, draw or seal can show under another.
  const { ready, groupId } = useActiveGroupPreference();
  if (!ready) {
    return (
      <p role="status" className="px-4 py-6 text-[13px] text-[#6F625D]">
        {liveCopy(props.locale)("drawLive.loading")}
      </p>
    );
  }
  return <LiveDrawBody key={groupId ?? "no-active-group"} {...props} groupId={groupId} />;
}

function LiveDrawBody({
  locale,
  accessToken,
  deps,
  groupId: preferredGroupId
}: LiveDrawProps & { readonly groupId: string | null }) {
  const t = useMemo(() => liveCopy(locale), [locale]);
  const copy = useMemo(() => drawCopy(locale), [locale]);
  const reducedMotion = usePrefersReducedMotion();
  const myUserId = useMemo(() => userIdFromAccessToken(accessToken), [accessToken]);

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cycles, setCycles] = useState<readonly DrawCycleRecord[] | null>(null);
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [drawId, setDrawId] = useState<string | null>(null);
  const [session, setSession] = useState<DrawSessionView | null>(null);
  const [wire, setWire] = useState<WireVerify | null>(null);
  const [check, setCheck] = useState<BrowserCheck | null>(null);
  const [mySeal, setMySeal] = useState<MySeal | null>(null);
  const [draft, setDraft] = useState<DrawDraft | null>(null);
  const [ledger, setLedger] = useState<LedgerFiguresResult | "loading" | null>(null);
  const [collateral, setCollateral] = useState<CollateralState>({ kind: "loading" });
  /** Bumped after a guarantee command so the derived view is read again. */
  const [collateralTick, setCollateralTick] = useState(0);
  const [contributions, setContributions] = useState<ContributionsState>({ kind: "loading" });
  /** Bumped after a gate change or a refused open so the grid is read again. */
  const [contributionsTick, setContributionsTick] = useState(0);
  /** `warn`: the owner/treasurer ticked "I have seen the flagged rounds". */
  const [gateConfirm, setGateConfirm] = useState(false);
  /** `block`: the reason for opening despite the flagged rounds. */
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const [cycleName, setCycleName] = useState("");
  const [contribution, setContribution] = useState("");
  const [totalRounds, setTotalRounds] = useState("");
  const [reservePercent, setReservePercent] = useState("10");
  const [cycleGate, setCycleGate] = useState<DrawContributionGate>("off");
  const cycleKey = useRef(newKey("cycle-create"));

  const [confirmPayout, setConfirmPayout] = useState(false);
  const [receipt, setReceipt] = useState<PayoutReceipt | null>(null);

  /** Guards against an older response overwriting a newer selection. */
  const sequence = useRef(0);

  /**
   * The draw whose outcome should buzz when this device finishes verifying it.
   * Set only by a click that moves the ceremony forward, so opening a draw that
   * was already revealed never vibrates.
   */
  const announceOutcomeFor = useRef<string | null>(null);

  const group = load.kind === "ready" ? load.group : null;
  const isTreasurer = group !== null && canRunTreasurerSteps(group.role);

  const labelFor = useCallback(
    (memberId: string): string => {
      const member = group?.members.find((entry) => entry.userId === memberId);
      return member?.email ?? t("drawLive.memberAnonymous", { id: shortId(memberId) });
    },
    [group, t]
  );

  const fail = useCallback((failure: DrawFailure) => {
    setProblem({ key: drawErrorKey(failure), detail: failure.message });
  }, []);

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }, []);

  // -- loading -------------------------------------------------------------------

  /** Fetch the published, revealed draw and recompute it on this device. */
  const verifyDraw = useCallback(
    async (id: string, ticket: number): Promise<void> => {
      const result = await fetchVerification(id, deps);
      if (ticket !== sequence.current) return;
      if (!result.ok) {
        setWire(null);
        setCheck(null);
        fail(result);
        return;
      }
      const checked = await verifyInBrowser(result.data);
      if (ticket !== sequence.current) return;
      setWire(result.data);
      setCheck(checked);
    },
    [deps, fail]
  );

  /** Select a draw: its session, this device's seal and seed, and (once revealed) its verification. */
  const selectDraw = useCallback(
    async (entry: DrawListEntry | null): Promise<void> => {
      const ticket = ++sequence.current;
      setWire(null);
      setCheck(null);
      setReceipt(null);
      setConfirmPayout(false);
      if (entry === null) {
        setDrawId(null);
        setSession(null);
        setMySeal(null);
        setDraft(null);
        return;
      }
      setDrawId(entry.drawId);
      setMySeal(readSeal(entry.drawId));
      setDraft(readDraft(entry.drawId));
      if (entry.legacy) {
        setSession(null);
      } else {
        const result = await readSession(entry.drawId, deps);
        if (ticket !== sequence.current) return;
        if (!result.ok) {
          setSession(null);
          fail(result);
          return;
        }
        setSession(result.data);
      }
      if (entry.state === "revealed" || entry.state === "paid") {
        await verifyDraw(entry.drawId, ticket);
      }
    },
    [deps, fail, verifyDraw]
  );

  /** Load one cycle and its draws, and open on the right draw. */
  const loadCycle = useCallback(
    async (id: string, keepDraw?: string | null): Promise<void> => {
      const result = await readCycle(id, deps);
      if (!result.ok) {
        setDetail(null);
        fail(result);
        return;
      }
      setCycleId(id);
      setDetail(result.data);
      const kept = keepDraw ? result.data.draws.find((entry) => entry.drawId === keepDraw) : undefined;
      await selectDraw(kept ?? pickDraw(result.data.draws));
    },
    [deps, fail, selectDraw]
  );

  const loadCycles = useCallback(
    async (groupId: string, prefer?: string | null): Promise<void> => {
      const result = await listCycles(groupId, deps);
      if (!result.ok) {
        setCycles([]);
        fail(result);
        return;
      }
      setCycles(result.data);
      const chosen = result.data.find((cycle) => cycle.cycleId === prefer) ?? result.data[0] ?? null;
      if (chosen === null) {
        setCycleId(null);
        setDetail(null);
        await selectDraw(null);
        return;
      }
      await loadCycle(chosen.cycleId);
    },
    [deps, fail, loadCycle, selectDraw]
  );

  // Resolve the group once, then load its cycles.
  useEffect(() => {
    let active = true;
    void readDrawGroup(deps, { groupId: preferredGroupId }).then(async (read) => {
      if (!active) return;
      if (read.status !== "ok") {
        return setLoad({
          kind: "message",
          key:
            read.status === "no-group"
              ? "drawLive.noGroup"
              : read.status === "choose-group"
                ? "drawLive.chooseGroup"
                : read.status === "unauthorized"
                  ? "drawLive.error.unauthorized"
                  : "drawLive.loadError"
        });
      }
      setLoad({ kind: "ready", group: read.group });
      await loadCycles(read.group.groupId);
    });
    return () => {
      active = false;
    };
    // The group is resolved once per mount (a different group remounts this body); the loaders are stable for a given `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ledger's contribution figures for the selected cycle.
  const selectedCycle = detail?.cycle ?? null;
  const cycleStart = selectedCycle?.startedAt ?? null;
  useEffect(() => {
    if (cycleStart === null) {
      setLedger(null);
      return;
    }
    let active = true;
    setLedger("loading");
    void loadCycleLedgerFigures(cycleStart, deps, undefined, preferredGroupId).then((result) => {
      if (active) setLedger(result);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleStart]);

  // The derived collateral view for the selected cycle: re-read whenever the cycle's
  // draws move (a draw opened or revealed changes what is due) and after a
  // guarantee command. Nothing is cached or stored: the database derives it each time.
  const collateralKey =
    detail === null ? null : `${detail.cycle.cycleId}:${detail.draws.map((entry) => `${entry.drawId}${entry.state}`).join(",")}:${collateralTick}`;
  useEffect(() => {
    if (collateralKey === null || detail === null) {
      setCollateral({ kind: "loading" });
      return;
    }
    let active = true;
    void readCollateral(detail.cycle.cycleId, deps).then((result) => {
      if (!active) return;
      setCollateral(result.ok ? { kind: "ready", view: result.data } : { kind: "unavailable" });
    });
    return () => {
      active = false;
    };
    // The key already covers the cycle and its draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collateralKey]);

  // The derived members x rounds grid for the selected cycle: re-read whenever the cycle's draws move
  // (a draw opened or revealed changes what is due), after a gate change and after a refused open.
  // Nothing is cached or stored: the database derives it each time.
  const contributionsKey =
    detail === null
      ? null
      : `${detail.cycle.cycleId}:${detail.draws.map((entry) => `${entry.drawId}${entry.state}`).join(",")}:${contributionsTick}`;
  useEffect(() => {
    setGateConfirm(false);
    if (contributionsKey === null || detail === null) {
      setContributions({ kind: "loading" });
      return;
    }
    let active = true;
    void readContributions(detail.cycle.cycleId, deps).then((result) => {
      if (!active) return;
      setContributions(result.ok ? { kind: "ready", view: result.data } : { kind: "unavailable" });
    });
    return () => {
      active = false;
    };
    // The key already covers the cycle and its draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contributionsKey]);

  const gateCommand = useCallback(
    async (gate: DrawContributionGate, reason: string): Promise<GateOutcome> => {
      if (selectedCycle === null) return { ok: false, key: "drawLive.error.generic", detail: null };
      const result = await setContributionGate({ cycleId: selectedCycle.cycleId, gate, reason }, deps);
      if (!result.ok) return { ok: false, key: drawErrorKey(result), detail: result.message };
      const changed = result.data.cycle;
      setDetail((current) => (current === null || current.cycle.cycleId !== changed.cycleId ? current : { ...current, cycle: changed }));
      setCycles((current) => (current === null ? current : current.map((entry) => (entry.cycleId === changed.cycleId ? changed : entry))));
      setContributionsTick((value) => value + 1);
      return { ok: true };
    },
    [deps, selectedCycle]
  );

  const guaranteeCommand = useCallback(
    async (command: GuaranteeCommand): Promise<CollateralOutcome> => {
      const result = await sendGuarantee(command, deps);
      if (!result.ok) {
        return { ok: false, key: drawErrorKey(result), detail: result.message };
      }
      setCollateralTick((value) => value + 1);
      return { ok: true };
    },
    [deps]
  );

  // The winner moment, or the tamper moment: this device's own recomputation.
  useEffect(() => {
    if (check === null || !check.revealed || wire === null) return;
    if (announceOutcomeFor.current !== wire.round.drawId) return;
    announceOutcomeFor.current = null;
    triggerHaptic(check.trusted ? "winnerRevealed" : "tamperDetected");
  }, [check, wire]);

  const refresh = () =>
    run("refresh", async () => {
      if (group === null) return;
      // A member who refreshes into a reveal that just happened gets the outcome
      // buzz; one who refreshes an already-revealed draw does not.
      const open = drawId === null ? undefined : detail?.draws.find((entry) => entry.drawId === drawId);
      if (open !== undefined && open.state !== "revealed" && open.state !== "paid") {
        announceOutcomeFor.current = open.drawId;
      }
      if (cycleId === null) return loadCycles(group.groupId);
      await loadCycle(cycleId, drawId);
    });

  // -- cycles --------------------------------------------------------------------

  const createCycleAction = () =>
    run("cycle", async () => {
      if (group === null) return;
      const each = normaliseAmount(contribution);
      const rounds = Number(totalRounds);
      const bps = Math.round(Number(reservePercent) * 100);
      if (
        cycleName.trim() === "" ||
        each === null ||
        !Number.isInteger(rounds) ||
        rounds < 1 ||
        rounds > group.members.length ||
        !Number.isFinite(bps) ||
        bps < 0 ||
        bps > 3333
      ) {
        return setProblem({ key: "drawLive.cycleInvalid", vars: { members: group.members.length } });
      }
      const result = await createCycle(
        {
          groupId: group.groupId,
          name: cycleName.trim(),
          contributionAmount: each,
          totalRounds: rounds,
          reserveRatioBps: bps,
          idempotencyKey: cycleKey.current,
          contributionGate: cycleGate
        },
        deps
      );
      if (!result.ok) return fail(result);
      cycleKey.current = newKey("cycle-create");
      setCycleName("");
      setContribution("");
      setTotalRounds("");
      setCycleGate("off");
      await loadCycles(group.groupId, result.data.cycle.cycleId);
    });

  const touchCycleForm = () => {
    // A changed field is a different request, so it must not reuse the old key.
    cycleKey.current = newKey("cycle-create");
  };

  const openDrawAction = () =>
    run("open", async () => {
      if (selectedCycle === null) return;
      const gate = contributions.kind === "ready" ? previewGate(contributions.view) : null;
      const reason = overrideReason.trim();
      if (gate !== null && gate.needsOverride && reason.length < 10) {
        return setProblem({ key: "drawLive.gateOverrideShort" });
      }
      // A new key each time: an abandoned draw must be replaceable by a fresh one.
      const result = await openDraw(
        {
          cycleId: selectedCycle.cycleId,
          idempotencyKey: newKey("draw-open"),
          // Only sent when the gate asked for it; the database ignores a reason it does not need.
          ...(gate !== null && gate.needsOverride ? { overrideReason: reason } : {})
        },
        deps
      );
      if (!result.ok) {
        fail(result);
        // The gate may have changed since the grid was read: show what the server now sees.
        if (result.code === "contribution_gate_blocked") setContributionsTick((value) => value + 1);
        return;
      }
      setOverrideReason("");
      setGateConfirm(false);
      await loadCycle(selectedCycle.cycleId, result.data.session.drawId);
    });

  // -- the member's side: seal, then release -------------------------------------

  const reloadSelected = useCallback(async () => {
    if (cycleId !== null) await loadCycle(cycleId, drawId);
  }, [cycleId, drawId, loadCycle]);

  const sealAction = () =>
    run("seal", async () => {
      if (session === null || myUserId === null) return;
      const made = await sealForDraw(session.drawId, myUserId);
      // Persist the nonce BEFORE sending the seal: a seal the server holds and a
      // device that lost its nonce is a draw nobody can complete.
      const previous = mySeal;
      writeSeal(made);
      setMySeal(made);
      const result = await submitSeal({ drawId: session.drawId, sealed: made.sealed }, deps);
      if (!result.ok) {
        if (previous === null) clearSeal(session.drawId);
        else writeSeal(previous);
        setMySeal(previous);
        return fail(result);
      }
      triggerHaptic("commitSealed");
      await reloadSelected();
    });

  const releaseAction = () =>
    run("release", async () => {
      if (session === null || mySeal === null) return;
      const result = await submitNonce({ drawId: session.drawId, nonce: mySeal.nonce }, deps);
      if (!result.ok) return fail(result);
      triggerHaptic("revealStep");
      await reloadSelected();
    });

  // -- the treasurer's side: commit, reveal --------------------------------------

  const commitAction = () =>
    run("commit", async () => {
      if (session === null) return;
      let current = draft ?? readDraft(session.drawId);
      if (current === null) {
        current = {
          drawId: session.drawId,
          seed: randomHex(),
          commitmentNonce: randomHex(),
          commitKey: `draw-commit.${session.drawId}`,
          revealKey: `draw-reveal.${session.drawId}`,
          committed: false
        };
        // Persisted before the request, so a retry commits to the same seed.
        writeDraft(session.drawId, current);
        setDraft(current);
      }
      const result = await commitDraw(
        {
          drawId: session.drawId,
          commitmentNonce: current.commitmentNonce,
          seed: current.seed,
          idempotencyKey: current.commitKey
        },
        deps
      );
      if (!result.ok) return fail(result);
      triggerHaptic("commitSealed");
      const committed = { ...current, committed: true };
      writeDraft(session.drawId, committed);
      setDraft(committed);
      await reloadSelected();
    });

  const revealAction = () =>
    run("reveal", async () => {
      if (session === null) return;
      if (draft === null || draft.seed === "") return setProblem({ key: "drawLive.revealNoSeed" });
      const result = await revealDraw(
        { drawId: session.drawId, seed: draft.seed, idempotencyKey: draft.revealKey },
        deps
      );
      if (!result.ok) return fail(result);
      triggerHaptic("revealStep");
      // The outcome buzz fires once this device has verified (see the effect above).
      announceOutcomeFor.current = session.drawId;
      // The seed is public now; there is nothing left to protect on this device.
      const done = { ...draft, seed: "", revealed: true };
      writeDraft(session.drawId, done);
      setDraft(done);
      await reloadSelected();
    });

  // -- payout --------------------------------------------------------------------

  const payoutAction = () =>
    run("payout", async () => {
      if (group === null || wire === null || check === null || !check.trusted || !confirmPayout) return;
      if (group.potCashAccountId === null || group.payoutExpenseAccountId === null) {
        return setProblem({ key: "drawLive.payoutMissingAccounts" });
      }
      const result = await postPayout(
        {
          drawId: wire.round.drawId,
          cashAccountId: group.potCashAccountId,
          payoutAccountId: group.payoutExpenseAccountId
        },
        deps
      );
      if (!result.ok) return fail(result);
      setConfirmPayout(false);
      await reloadSelected();
      // Reloading clears the receipt with the rest of the selection; keep this one on screen.
      setReceipt(result.data);
    });

  // -- render --------------------------------------------------------------------

  if (load.kind === "loading") {
    return (
      <p role="status" className="px-4 py-6 text-[13px] text-[#6F625D]">
        {t("drawLive.loading")}
      </p>
    );
  }
  if (load.kind === "message") {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-6">
        <p role="alert" data-testid="draw-live-refusal" className="rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-3 text-[13px] text-[#6B4E16]">
          {t(load.key)}
        </p>
      </div>
    );
  }

  const readyGroup = load.group;
  const cycle = selectedCycle;
  const round1 = wire?.round ?? null;
  const winnerId = check?.trusted ? check.local.winnerMemberId : null;
  const phase: CeremonyPhase = winnerId !== null ? "revealed" : session === null ? "idle" : "sealed";
  const roundLabel = session
    ? copy.roundLabel(session.round, session.cycle.totalRounds)
    : cycle
      ? copy.roundLabel(cycle.nextRound ?? cycle.totalRounds, cycle.totalRounds)
      : copy.roundLabel(1, 1);
  const canPay = isTreasurer && round1 !== null && round1.state === "revealed" && check !== null && check.trusted;
  const stateLabel = (state: DrawListEntry["state"]) => t(`drawLive.lifecycle.${state}`);
  const gatePreview = contributions.kind === "ready" ? previewGate(contributions.view) : null;
  // The open button waits for the grid when a gate is in force, and for the owner/treasurer's
  // confirmation (warn) or reason (block) when something earlier is flagged.
  const openHeld =
    (contributions.kind === "loading" && cycle !== null && cycle.contributionGate !== "off") ||
    (gatePreview !== null && gatePreview.needsConfirm && !gateConfirm) ||
    (gatePreview !== null && gatePreview.needsOverride && overrideReason.trim().length < 10);
  const liveSealingForNext =
    detail !== null &&
    cycle !== null &&
    cycle.nextRound !== null &&
    detail.draws.some((entry) => entry.round === cycle.nextRound && entry.state === "sealing" && !entry.superseded);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden no-scrollbar" data-testid="draw-live">
      <MesobCeremony
        phase={phase}
        reducedMotion={reducedMotion}
        roundLabel={roundLabel}
        winnerName={winnerId === null ? undefined : labelFor(winnerId)}
      />

      <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 md:max-w-3xl md:px-6">
        <p
          data-testid="draw-live-badge"
          className="rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-3 py-2 text-[12px] font-semibold text-[#065F46]"
        >
          {t("drawLive.liveBadge")}
        </p>

        {problem ? (
          <div role="alert" className="rounded-xl border border-[#C6532B] bg-[#FDEDE6] px-3 py-2 text-[12px] font-semibold text-[#863214]">
            <p>{t(problem.key as DrawLiveKey, problem.vars)}</p>
            {problem.detail ? <p className="mt-1 font-mono text-[11px] font-normal">{problem.detail}</p> : null}
          </div>
        ) : null}

        <section className={CARD} aria-label={t("drawLive.rosterTitle")} data-draw-panel="roster">
          <h3 className={HEADING}>{t("drawLive.rosterTitle")}</h3>
          <p className={HINT}>{isTreasurer ? t("drawLive.roleTreasurerNote") : t("drawLive.roleMemberNote")}</p>
          <ul className="mt-2 space-y-1">
            {readyGroup.members.map((member) => (
              <li
                key={member.userId}
                className="flex items-center justify-between gap-2 rounded-lg bg-[#F5EFEB] px-2.5 py-1.5 text-[12px]"
              >
                <span className="min-w-0 truncate font-semibold">
                  {member.email ?? t("drawLive.memberAnonymous", { id: shortId(member.userId) })}
                  {member.userId === myUserId ? ` ${t("drawLive.you")}` : ""}
                </span>
                <span className="shrink-0 text-right text-[11px] text-[#6F625D]">
                  {cycle?.contributionAmount
                    ? `${t("drawLive.expectedEach", { each: formatEtbDisplay(cycle.contributionAmount) })} · `
                    : ""}
                  {t(`drawLive.role.${member.role}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={CARD} aria-label={t("drawLive.cycleTitle")} data-draw-panel="cycle" data-testid="cycle-card">
          <h3 className={HEADING}>{t("drawLive.cycleTitle")}</h3>
          {cycles === null || cycles.length === 0 ? (
            <p data-testid="cycle-none" className={HINT}>
              {isTreasurer ? t("drawLive.cycleNoneTreasurer") : t("drawLive.cycleNoneMember")}
            </p>
          ) : (
            <>
              <label className="mt-2 block">
                <span className={LABEL}>{t("drawLive.cyclePick")}</span>
                <select
                  data-testid="cycle-select"
                  className={FIELD}
                  value={cycleId ?? ""}
                  disabled={busy !== null}
                  onChange={(event) => void run("pick", () => loadCycle(event.target.value))}
                >
                  {cycles.map((entry) => (
                    <option key={entry.cycleId} value={entry.cycleId}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              {cycle !== null ? (
                <>
                  <dl data-testid="cycle-terms" className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
                    <dt className="text-[#6F625D]">{t("drawLive.cycleEach")}</dt>
                    <dd data-testid="cycle-each" className="font-semibold">
                      {cycle.contributionAmount === null
                        ? t("drawLive.cycleEachUnknown")
                        : `${formatEtbDisplay(cycle.contributionAmount)} ${copy.currency}`}
                    </dd>
                    <dt className="text-[#6F625D]">{t("drawLive.cyclePot")}</dt>
                    <dd data-testid="cycle-pot" className="font-semibold">
                      {formatEtbDisplay(cycle.potAmount)} {copy.currency}
                      {potMembers(cycle) !== null ? ` (${t("drawLive.cyclePotMembers", { count: potMembers(cycle) ?? 0 })})` : ""}
                    </dd>
                    <dt className="text-[#6F625D]">{t("drawLive.cycleRounds")}</dt>
                    <dd>{t("drawLive.cycleProgress", { done: cycle.roundsRevealed, total: cycle.totalRounds, paid: cycle.roundsPaid })}</dd>
                    <dt className="text-[#6F625D]">{t("drawLive.cycleReserve")}</dt>
                    <dd>{(cycle.reserveRatioBps / 100).toFixed(2)} %</dd>
                    <dt className="text-[#6F625D]">{t("drawLive.cycleStarted")}</dt>
                    <dd>{cycle.startedAt.slice(0, 10)}</dd>
                    <dt className="text-[#6F625D]">{t("drawLive.cycleGate")}</dt>
                    <dd data-testid="cycle-gate">{translate(locale, `contributions.gate.policy.${cycle.contributionGate}` as MessageKey)}</dd>
                  </dl>
                  {potMembers(cycle) !== null && potMembers(cycle) !== readyGroup.members.length ? (
                    <p data-testid="cycle-roster-drift" role="status" className={NOTICE}>
                      {t("drawLive.cycleRosterDrift", { was: potMembers(cycle) ?? 0, now: readyGroup.members.length })}
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          )}

          {isTreasurer ? (
            <details className="mt-3 rounded-xl border border-[#DCCFC7] bg-[#FAF7F2] px-3 py-2" open={cycles !== null && cycles.length === 0}>
              <summary className="cursor-pointer text-[12px] font-semibold text-[#1C1410]">{t("drawLive.cycleCreateTitle")}</summary>
              <div className="mt-2 space-y-2" data-testid="cycle-create-form">
                <label className="block">
                  <span className={LABEL}>{t("drawLive.cycleName")}</span>
                  <input
                    className={FIELD}
                    value={cycleName}
                    maxLength={120}
                    onChange={(event) => {
                      touchCycleForm();
                      setCycleName(event.target.value);
                    }}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className={LABEL}>{t("drawLive.contributionLabel")}</span>
                    <input
                      className={FIELD}
                      inputMode="decimal"
                      value={contribution}
                      onChange={(event) => {
                        touchCycleForm();
                        setContribution(event.target.value);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>{t("drawLive.totalRoundsLabel")}</span>
                    <input
                      className={FIELD}
                      inputMode="numeric"
                      value={totalRounds}
                      onChange={(event) => {
                        touchCycleForm();
                        setTotalRounds(event.target.value);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>{t("drawLive.reserveLabel")}</span>
                    <input
                      className={FIELD}
                      inputMode="decimal"
                      value={reservePercent}
                      onChange={(event) => {
                        touchCycleForm();
                        setReservePercent(event.target.value);
                      }}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className={LABEL}>{t("drawLive.gateLabel")}</span>
                  <select
                    className={FIELD}
                    data-testid="cycle-gate-select"
                    value={cycleGate}
                    onChange={(event) => {
                      touchCycleForm();
                      setCycleGate(event.target.value as DrawContributionGate);
                    }}
                  >
                    {DRAW_CONTRIBUTION_GATES.map((gate) => (
                      <option key={gate} value={gate}>
                        {t(`drawLive.gateOption.${gate}`)}
                      </option>
                    ))}
                  </select>
                  <span className={HINT}>{t("drawLive.gateHint")}</span>
                </label>
                {normaliseAmount(contribution) !== null ? (
                  <p data-testid="cycle-pot-preview" className="text-[12px] font-semibold text-[#1C1410]">
                    {t("drawLive.cyclePotPreview", {
                      pot: formatEtbDisplay(
                        formatEtbMinorUnits(
                          toEtbMinorUnits(normaliseAmount(contribution) as string, true) * BigInt(readyGroup.members.length)
                        )
                      ),
                      count: readyGroup.members.length,
                      each: formatEtbDisplay(normaliseAmount(contribution) as string)
                    })}
                  </p>
                ) : null}
                <p className={HINT}>{t("drawLive.cycleCreateHint")}</p>
                <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void createCycleAction()}>
                  {busy === "cycle" ? t("drawLive.working") : t("drawLive.cycleCreateAction")}
                </button>
              </div>
            </details>
          ) : null}
        </section>

        {cycle !== null && detail !== null ? (
          <ContributionGrid
            locale={locale}
            state={contributions}
            myUserId={myUserId}
            isTreasurer={isTreasurer}
            labelFor={labelFor}
            onSetGate={gateCommand}
          />
        ) : null}

        {cycle !== null ? (
          <section className={CARD} aria-label={t("drawLive.ledgerTitle")} data-draw-panel="ledger" data-testid="ledger-figures">
            <h3 className={HEADING}>{t("drawLive.ledgerTitle")}</h3>
            {ledger === "loading" || ledger === null ? (
              <p className={HINT}>{t("drawLive.ledgerLoading")}</p>
            ) : ledger.status === "ready" ? (
              <>
                <p data-testid="ledger-recorded" className="mt-2 text-[12px] font-semibold text-[#1C1410]">
                  {t("drawLive.ledgerRecorded", {
                    total: formatEtbDisplay(ledger.figures.total),
                    currency: copy.currency,
                    count: ledger.figures.count,
                    date: cycle.startedAt.slice(0, 10)
                  })}
                </p>
                {ledger.figures.unattributedCount > 0 ? (
                  <p data-testid="ledger-unattributed-entries" className={HINT}>
                    {t("drawLive.ledgerUnattributed", {
                      count: ledger.figures.unattributedCount,
                      total: formatEtbDisplay(ledger.figures.unattributedTotal),
                      currency: copy.currency
                    })}
                  </p>
                ) : null}
              </>
            ) : ledger.status === "empty" ? (
              <p data-testid="ledger-recorded" className="mt-2 text-[12px] font-semibold text-[#1C1410]">
                {t("drawLive.ledgerEmpty")}
              </p>
            ) : ledger.status === "incomplete" ? (
              <p data-testid="ledger-recorded" className={NOTICE}>
                {t("drawLive.ledgerIncomplete")}
              </p>
            ) : (
              <p data-testid="ledger-recorded" className={NOTICE}>
                {t("drawLive.ledgerUnavailable")}
              </p>
            )}
            <p data-testid="ledger-unattributed" className={HINT}>
              {t("drawLive.ledgerNoMember")}
            </p>
          </section>
        ) : null}

        {cycle !== null && detail !== null ? (
          <CollateralPanel
            locale={locale}
            state={collateral}
            currencyLabel={copy.currency}
            myUserId={myUserId}
            isTreasurer={isTreasurer}
            members={group?.members ?? []}
            labelFor={labelFor}
            onCommand={guaranteeCommand}
          />
        ) : null}

        {cycle !== null && detail !== null ? (
          <section className={CARD} aria-label={t("drawLive.drawsTitle")} data-draw-panel="draws" data-testid="draw-list">
            <div className="flex items-center justify-between gap-2">
              <h3 className={HEADING}>{t("drawLive.drawsTitle")}</h3>
              <button type="button" className={SECONDARY} disabled={busy !== null} onClick={() => void refresh()}>
                {busy === "refresh" ? t("drawLive.working") : t("drawLive.refresh")}
              </button>
            </div>
            {detail.draws.length === 0 ? (
              <p className={HINT}>{t("drawLive.drawsNone")}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {detail.draws.map((entry) => (
                  <li key={entry.drawId}>
                    <button
                      type="button"
                      data-testid={`draw-row-${entry.drawId}`}
                      aria-pressed={entry.drawId === drawId}
                      disabled={busy !== null}
                      onClick={() => void run("pick", () => selectDraw(entry))}
                      className={[
                        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px]",
                        entry.drawId === drawId ? "bg-[#ECFDF5] ring-1 ring-[#A7F3D0]" : "bg-[#F5EFEB]"
                      ].join(" ")}
                    >
                      <span className="font-semibold">
                        {t("drawLive.drawRow", { round: entry.round })} · {stateLabel(entry.state)}
                        {entry.superseded ? ` · ${t("drawLive.drawSuperseded")}` : ""}
                        {entry.legacy ? ` · ${t("drawLive.drawLegacy")}` : ""}
                      </span>
                      <span className="shrink-0 text-[11px] text-[#6F625D]">
                        {entry.state === "sealing"
                          ? t("drawLive.drawSealCount", { count: entry.sealCount })
                          : entry.state === "committed"
                            ? t("drawLive.drawReleaseCount", { count: entry.nonceCount, total: entry.sealCount })
                            : entry.winnerMemberId !== null
                              ? labelFor(entry.winnerMemberId)
                              : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isTreasurer && cycle.nextRound !== null && !liveSealingForNext ? (
              <>
                <p className={HINT}>{t("drawLive.openDetail")}</p>
                {gatePreview !== null && gatePreview.flagged.length > 0 && gatePreview.round !== null ? (
                  <div
                    data-testid="open-gate"
                    data-gate-policy={gatePreview.policy}
                    role={gatePreview.needsOverride ? "alert" : "status"}
                    className={NOTICE}
                  >
                    <p className="font-bold">
                      {t(gatePreview.needsOverride ? "drawLive.gateBlockedTitle" : "drawLive.gateWarnTitle")}
                    </p>
                    <p className="mt-1 font-normal">
                      {t(gatePreview.needsOverride ? "drawLive.gateBlockedBody" : "drawLive.gateWarnBody", {
                        count: gatePreview.flagged.length,
                        round: gatePreview.round
                      })}
                    </p>
                    <ul data-testid="open-gate-flagged" className="mt-1 list-disc pl-4 font-normal">
                      {flaggedByMember(gatePreview.flagged).map(([memberId, rounds]) => (
                        <li key={memberId}>{t("drawLive.gateFlaggedRow", { member: labelFor(memberId), rounds: rounds.join(", ") })}</li>
                      ))}
                    </ul>
                    {gatePreview.needsConfirm ? (
                      <label className="mt-2 flex items-start gap-2 font-normal">
                        <input
                          type="checkbox"
                          data-testid="open-gate-confirm"
                          checked={gateConfirm}
                          onChange={(event) => setGateConfirm(event.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[#C6532B]"
                        />
                        <span>{t("drawLive.gateWarnConfirm")}</span>
                      </label>
                    ) : (
                      <label className="mt-2 block font-normal">
                        <span className={LABEL}>{t("drawLive.gateOverrideReason")}</span>
                        <textarea
                          data-testid="open-gate-reason"
                          className={FIELD}
                          rows={2}
                          maxLength={1000}
                          value={overrideReason}
                          onChange={(event) => setOverrideReason(event.target.value)}
                        />
                        <span className={HINT}>{t("drawLive.gateOverrideNote")}</span>
                      </label>
                    )}
                  </div>
                ) : null}
                <button
                  type="button"
                  data-testid="open-draw"
                  className={`${BUTTON} mt-2`}
                  disabled={busy !== null || openHeld}
                  onClick={() => void openDrawAction()}
                >
                  {busy === "open"
                    ? t("drawLive.working")
                    : gatePreview?.needsOverride
                      ? t("drawLive.gateOverrideAction", { round: cycle.nextRound })
                      : t("drawLive.openAction", { round: cycle.nextRound })}
                </button>
              </>
            ) : null}
            {cycle.nextRound === null ? <p className={HINT}>{t("drawLive.cycleComplete")}</p> : null}
          </section>
        ) : null}

        {session !== null ? (
          <DrawPanel
            t={t}
            session={session}
            myUserId={myUserId}
            mySeal={mySeal}
            draft={draft}
            isTreasurer={isTreasurer}
            busy={busy}
            labelFor={labelFor}
            onSeal={() => void sealAction()}
            onRelease={() => void releaseAction()}
            onCommit={() => void commitAction()}
            onReveal={() => void revealAction()}
          />
        ) : drawId !== null && detail?.draws.find((entry) => entry.drawId === drawId)?.legacy ? (
          <section className={CARD} data-draw-panel="legacy">
            <p className={HINT}>{t("drawLive.legacyNote")}</p>
          </section>
        ) : null}

        {wire !== null && check !== null ? (
          <>
            <ComparePanel t={t} wire={wire} check={check} labelFor={labelFor} />
            {check.revealed ? (
              <VerifyPanel locale={locale} transcript={wire.transcript} verification={check.local} isRunning={false} error={null} />
            ) : null}
            {check.risk !== null && check.trusted ? (
              <RiskPanel locale={locale} risk={check.risk} currencyLabel={copy.currency} />
            ) : null}
          </>
        ) : null}

        {round1 !== null && round1.state === "paid" ? (
          <section className={CARD} data-draw-panel="paid">
            <h3 className={HEADING}>{t("drawLive.payoutTitle")}</h3>
            <p data-testid="payout-done" className="mt-2 text-[12px] font-semibold text-[#065F46]">
              {receipt !== null
                ? t(receipt.replayed ? "drawLive.payoutReplayed" : "drawLive.payoutDone", {
                    sequence: receipt.ledgerSequence ?? "?"
                  })
                : t("drawLive.payoutAlready")}
            </p>
            <p className="sened-hash mt-1">{receipt?.ledgerEntryId ?? round1.payout?.ledgerEntryId}</p>
            {receipt?.ledgerEntryHash ? <p className="sened-hash">{receipt.ledgerEntryHash}</p> : null}
          </section>
        ) : null}

        {isTreasurer && round1 !== null && round1.state === "revealed" ? (
          <section className={CARD} aria-label={t("drawLive.payoutTitle")} data-draw-panel="payout">
            <h3 className={HEADING}>{t("drawLive.payoutTitle")}</h3>
            {canPay && winnerId !== null && round1.payoutAmount !== null && round1.reserveAmount !== null ? (
              <>
                <p className={HINT}>{t("drawLive.payoutDetail")}</p>
                <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
                  <dt className="text-[#6F625D]">{t("drawLive.payoutWinner")}</dt>
                  <dd className="font-semibold">{labelFor(winnerId)}</dd>
                  <dt className="text-[#6F625D]">{t("drawLive.payoutAmount")}</dt>
                  <dd data-testid="payout-amount" className="font-semibold">
                    {formatEtbDisplay(round1.payoutAmount)} {copy.currency}
                  </dd>
                  <dt className="text-[#6F625D]">{t("drawLive.payoutReserve")}</dt>
                  <dd>{formatEtbDisplay(round1.reserveAmount)} {copy.currency}</dd>
                  <dt className="text-[#6F625D]">{t("drawLive.payoutDebit")}</dt>
                  <dd data-testid="payout-debit">
                    {readyGroup.payoutExpenseCode}{" "}
                    <span className="sened-hash">{readyGroup.payoutExpenseAccountId ?? t("drawLive.accountMissing")}</span>
                  </dd>
                  <dt className="text-[#6F625D]">{t("drawLive.payoutCredit")}</dt>
                  <dd data-testid="payout-credit">
                    {readyGroup.potCashCode}{" "}
                    <span className="sened-hash">{readyGroup.potCashAccountId ?? t("drawLive.accountMissing")}</span>
                  </dd>
                </dl>
                <label className="mt-3 flex items-start gap-2 rounded-xl border border-[#E5B450] bg-[#FBF3E2] px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={confirmPayout}
                    onChange={(event) => setConfirmPayout(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#C6532B]"
                  />
                  <span className="text-[11px] leading-4 text-[#6B4E16]">{t("drawLive.payoutConfirm")}</span>
                </label>
                <button
                  type="button"
                  className={`${BUTTON} mt-3`}
                  disabled={!confirmPayout || busy !== null}
                  onClick={() => void payoutAction()}
                >
                  {busy === "payout" ? t("drawLive.working") : t("drawLive.payoutAction")}
                </button>
              </>
            ) : (
              <p data-testid="payout-blocked" role="alert" className="mt-2 text-[12px] font-semibold text-[#863214]">
                {t("drawLive.payoutBlocked")}
              </p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

type Translate = (key: DrawLiveKey, variables?: Record<string, string | number>) => string;

/**
 * One draw in progress: who has sealed, who has released, and what THIS member
 * and the treasurer can do at this point. Every button is offered only in the
 * state in which the server will accept it, and the server refuses it otherwise.
 */
function DrawPanel({
  t,
  session,
  myUserId,
  mySeal,
  draft,
  isTreasurer,
  busy,
  labelFor,
  onSeal,
  onRelease,
  onCommit,
  onReveal
}: {
  readonly t: Translate;
  readonly session: DrawSessionView;
  readonly myUserId: string | null;
  readonly mySeal: MySeal | null;
  readonly draft: DrawDraft | null;
  readonly isTreasurer: boolean;
  readonly busy: string | null;
  readonly labelFor: (memberId: string) => string;
  readonly onSeal: () => void;
  readonly onRelease: () => void;
  readonly onCommit: () => void;
  readonly onReveal: () => void;
}) {
  const eligible = session.eligible;
  const sealedIds = new Set(session.seals.map((seal) => seal.memberId));
  const releasedIds = new Set(session.nonces.filter((entry) => entry.released).map((entry) => entry.memberId));
  const sealedCount = eligible.filter((id) => sealedIds.has(id)).length;
  const sealedMembers = session.seals.map((seal) => seal.memberId);
  const releasedCount = sealedMembers.filter((id) => releasedIds.has(id)).length;
  const sealing = session.state === "sealing";
  const committed = session.state === "committed";

  const iAmEligible = myUserId !== null && eligible.includes(myUserId);
  const standing = sealStanding(session, mySeal, myUserId);
  const iReleased = myUserId !== null && releasedIds.has(myUserId);
  const othersSealed = eligible.filter((id) => id !== myUserId && sealedIds.has(id)).length;
  // With nobody else to seal there is nothing to choose, so a lone committer may proceed.
  const needsOther = eligible.length > 1 && othersSealed < 1;
  const pending = sealedMembers.length - releasedCount;

  return (
    <section className={CARD} aria-label={t("drawLive.mineTitle")} data-draw-panel="draw" data-testid="draw-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className={HEADING}>
          {t("drawLive.drawRow", { round: session.round })} · {t(`drawLive.lifecycle.${session.state}`)}
        </h3>
        <span className="text-[11px] text-[#6F625D]">{shortId(session.drawId)}</span>
      </div>

      {sealing ? (
        <p data-testid="seal-progress" className="mt-2 text-[12px] font-semibold text-[#1C1410]">
          {t("drawLive.sealProgress", { sealed: sealedCount, total: eligible.length })}
        </p>
      ) : (
        <p data-testid="nonce-progress" className="mt-2 text-[12px] font-semibold text-[#1C1410]">
          {t("drawLive.nonceProgress", { released: releasedCount, total: sealedMembers.length })}
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {eligible.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2 rounded-lg bg-[#F5EFEB] px-2.5 py-1.5 text-[12px]">
            <span className="min-w-0 truncate">{labelFor(id)}</span>
            <span className="shrink-0 text-[11px] text-[#6F625D]">
              {sealedIds.has(id) ? t("drawLive.badge.sealed") : t("drawLive.badge.notSealed")}
              {!sealing && sealedIds.has(id)
                ? ` · ${releasedIds.has(id) ? t("drawLive.badge.released") : t("drawLive.badge.notReleased")}`
                : ""}
            </span>
          </li>
        ))}
      </ul>

      {/* This member's part. The nonce itself is never rendered. */}
      <div data-testid="my-part" className="mt-3 border-t border-dashed border-[#E4D9CE] pt-3">
        <h4 className="text-[12px] font-bold text-[#1C1410]">{t("drawLive.mineTitle")}</h4>
        <p className={HINT}>{t("drawLive.mineDetail")}</p>

        {myUserId === null || !iAmEligible ? (
          sealing || committed ? (
            <p data-testid="not-eligible" className={NOTICE}>
              {t("drawLive.sealNotEligible")}
            </p>
          ) : null
        ) : sealing ? (
          standing === "none" ? (
            <button type="button" data-testid="seal-button" className={`${BUTTON} mt-2`} disabled={busy !== null} onClick={onSeal}>
              {busy === "seal" ? t("drawLive.working") : t("drawLive.sealAction")}
            </button>
          ) : standing === "mine" ? (
            <div data-testid="my-seal">
              <p className={GOOD}>{t("drawLive.sealDone")}</p>
              <p data-testid="release-locked" className={NOTICE}>
                {t("drawLive.releaseWait")}
              </p>
              <p className={HINT}>{t("drawLive.keepSecret")}</p>
            </div>
          ) : (
            <div data-testid="seal-mismatch">
              <p role="alert" className={BAD}>
                {mySeal === null ? t("drawLive.releaseNoLocal") : t("drawLive.sealMismatch")}
              </p>
              <button type="button" data-testid="seal-replace-button" className={`${SECONDARY} mt-2`} disabled={busy !== null} onClick={onSeal}>
                {busy === "seal" ? t("drawLive.working") : t("drawLive.sealReplaceAction")}
              </button>
            </div>
          )
        ) : committed ? (
          standing === "none" ? (
            <p data-testid="seal-closed" className={NOTICE}>
              {mySeal === null ? t("drawLive.sealClosed") : t("drawLive.releaseMissingSeal")}
            </p>
          ) : standing === "other" ? (
            <p role="alert" data-testid="release-blocked" className={BAD}>
              {mySeal === null ? t("drawLive.releaseNoLocal") : t("drawLive.releaseMismatch")}
            </p>
          ) : iReleased ? (
            <p data-testid="release-done" className={GOOD}>
              {t("drawLive.releaseDone")}
            </p>
          ) : session.revealRequested ? (
            <p className={NOTICE}>{t("drawLive.releaseClosed")}</p>
          ) : (
            <div data-testid="release-ready">
              <p className={GOOD}>{t("drawLive.releaseReady")}</p>
              <button type="button" data-testid="release-button" className={`${BUTTON} mt-2`} disabled={busy !== null} onClick={onRelease}>
                {busy === "release" ? t("drawLive.working") : t("drawLive.releaseAction")}
              </button>
              <p className={HINT}>{t("drawLive.keepSecret")}</p>
            </div>
          )
        ) : null}
      </div>

      {isTreasurer && sealing ? (
        <div data-testid="commit-form" className="mt-3 space-y-2 border-t border-dashed border-[#E4D9CE] pt-3">
          <h4 className="text-[12px] font-bold text-[#1C1410]">{t("drawLive.ceremonyTitle")}</h4>
          <p className={HINT}>{t("drawLive.commitDetail")}</p>
          {needsOther ? (
            <p data-testid="commit-needs-other" role="status" className={NOTICE}>
              {t("drawLive.commitNeedOther")}
            </p>
          ) : null}
          <p className={HINT}>{t("drawLive.seedNote")}</p>
          <button type="button" data-testid="commit-button" className={BUTTON} disabled={busy !== null || needsOther} onClick={onCommit}>
            {busy === "commit" ? t("drawLive.working") : t("drawLive.commitAction")}
          </button>
        </div>
      ) : null}

      {isTreasurer && committed ? (
        <div data-testid="reveal-form" className="mt-3 space-y-2 border-t border-dashed border-[#E4D9CE] pt-3">
          <h4 className="text-[12px] font-bold text-[#1C1410]">{t("drawLive.ceremonyTitle")}</h4>
          <p className={GOOD}>{t("drawLive.commitDone")}</p>
          <p className={HINT}>{t("drawLive.revealDetail")}</p>
          {pending > 0 ? (
            <p data-testid="reveal-waiting" role="status" className={NOTICE}>
              {t("drawLive.revealWaiting", { pending })}
            </p>
          ) : null}
          {draft === null || draft.seed === "" ? (
            <p role="alert" className={BAD}>
              {t("drawLive.revealNoSeed")}
            </p>
          ) : null}
          <button
            type="button"
            data-testid="reveal-button"
            className={BUTTON}
            disabled={busy !== null || pending > 0 || draft === null || draft.seed === ""}
            onClick={onReveal}
          >
            {busy === "reveal" ? t("drawLive.working") : t("drawLive.revealAction")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ComparePanel({
  t,
  wire,
  check,
  labelFor
}: {
  readonly t: Translate;
  readonly wire: WireVerify;
  readonly check: BrowserCheck;
  readonly labelFor: (memberId: string) => string;
}) {
  const verdict = (ok: boolean): string => t(ok ? "drawLive.verdictOk" : "drawLive.verdictFail");
  const agree = check.disagreements.length === 0;
  return (
    <section className={CARD} aria-label={t("drawLive.compareTitle")} data-draw-panel="compare">
      <h3 className={HEADING}>{t("drawLive.compareTitle")}</h3>
      <p className="mt-1 text-[12px] text-[#6F625D]">
        {t("drawLive.stateLine", { state: t(`drawLive.state.${wire.round.state}`) })}
      </p>
      {!check.revealed ? (
        <p data-testid="compare-pending" className="mt-2 text-[12px] font-semibold text-[#6B4E16]">
          {t("drawLive.verifyNotRevealed")}
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <dt className="font-semibold">{t("drawLive.compareDevice")}</dt>
            <dd data-testid="verdict-device" className="font-semibold">
              {verdict(check.local.verified)}
              {check.local.winnerMemberId !== null ? ` — ${labelFor(check.local.winnerMemberId)}` : ""}
            </dd>
            <dt className="font-semibold">{t("drawLive.compareServer")}</dt>
            <dd data-testid="verdict-server">
              {verdict(wire.verification.verified)}
              {wire.round.winnerMemberId !== null ? ` — ${labelFor(wire.round.winnerMemberId)}` : ""}
            </dd>
          </dl>
          <p
            role="status"
            data-testid="compare-result"
            className={[
              "mt-3 rounded-xl border px-3 py-2 text-[12px] font-semibold",
              agree
                ? "border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]"
                : "border-[#C6532B] bg-[#FDEDE6] text-[#863214]"
            ].join(" ")}
          >
            {agree ? t("drawLive.compareAgree") : t("drawLive.compareDisagree")}
          </p>
          {!agree ? (
            <ul className="mt-2 space-y-1">
              {check.disagreements.map((kind: DisagreementKind) => (
                <li key={kind} className="text-[12px] text-[#863214]">
                  • {t(`drawLive.disagree.${kind}`)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
