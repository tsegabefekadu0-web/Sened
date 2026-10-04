"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import {
  canRunTreasurerSteps,
  checkOpenings,
  commitDraw,
  drawErrorKey,
  fetchVerification,
  isUuid,
  normaliseAmount,
  openingLine,
  parseOpeningLines,
  parseSealLines,
  postPayout,
  potFromContribution,
  randomHex,
  readDraft,
  readDrawGroup,
  readSeal,
  revealDraw,
  sealForDraw,
  sealLine,
  userIdFromAccessToken,
  verifyInBrowser,
  writeDraft,
  writeSeal,
  type BrowserCheck,
  type DisagreementKind,
  type DrawDraft,
  type DrawFailure,
  type DrawGroup,
  type MySeal,
  type PayoutReceipt,
  type WireVerify
} from "@/lib/draw/clientDraw";
import type { MessageKey } from "@/lib/i18n";
import { formatEtbDisplay } from "@/lib/ledger/money";

import { usePrefersReducedMotion } from "./DrawBoard";
import { MesobCeremony, type CeremonyPhase } from "./MesobCeremony";
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

function shortId(id: string): string {
  return id.slice(0, 8);
}

function CopyField({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <span className={LABEL}>{label}</span>
      <div className="mt-1 flex gap-2">
        <input
          readOnly
          aria-label={label}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-xl border border-[#DCCFC7] bg-[#FAF7F2] px-3 py-2 font-mono text-[11px] text-[#1C1410]"
        />
        <button
          type="button"
          className={SECONDARY}
          onClick={() => {
            void Promise.resolve(globalThis.navigator?.clipboard?.writeText(value))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "✓" : copyLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * The signed-in draw: the real flow, through `/api/draw/*`.
 *
 * Order the server enforces, and who may do each step:
 *
 *   0. members seal a nonce for a draw id        (any member, on their own device)
 *   1. `POST /api/draw/commits`   — owner/treasurer, with the sealed hashes
 *   2. `POST /api/draw/reveals`   — owner/treasurer, with the seed and the openings
 *   3. `POST /api/draw/verify`    — any member; the browser recomputes the result
 *   4. `POST /api/draw/payouts`   — owner/treasurer, after an explicit confirmation
 *
 * The server's verdict is never displayed as the answer. The draw is recomputed
 * here from the published values, and the two are compared.
 */
export function LiveDraw({ locale, accessToken, deps }: LiveDrawProps) {
  const t = useMemo(() => liveCopy(locale), [locale]);
  const copy = useMemo(() => drawCopy(locale), [locale]);
  const reducedMotion = usePrefersReducedMotion();
  const myUserId = useMemo(() => userIdFromAccessToken(accessToken), [accessToken]);

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<DrawDraft | null>(null);
  const [wire, setWire] = useState<WireVerify | null>(null);
  const [check, setCheck] = useState<BrowserCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const [sealDrawId, setSealDrawId] = useState("");
  const [mySeal, setMySeal] = useState<MySeal | null>(null);
  const [verifyDrawId, setVerifyDrawId] = useState("");

  const [cycleId, setCycleId] = useState("");
  const [round, setRound] = useState("1");
  const [totalRounds, setTotalRounds] = useState("");
  const [contribution, setContribution] = useState("");
  const [reservePercent, setReservePercent] = useState("10");
  const [sealsText, setSealsText] = useState("");
  const [openingsText, setOpeningsText] = useState("");

  const [confirmPayout, setConfirmPayout] = useState(false);
  const [receipt, setReceipt] = useState<PayoutReceipt | null>(null);

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

  /** Fetch the published draw and recompute it on this device. */
  const refresh = useCallback(
    async (drawId: string): Promise<BrowserCheck | null> => {
      const result = await fetchVerification(drawId, deps);
      if (!result.ok) {
        setWire(null);
        setCheck(null);
        fail(result);
        return null;
      }
      const checked = await verifyInBrowser(result.data);
      setWire(result.data);
      setCheck(checked);
      return checked;
    },
    [deps, fail]
  );

  // Resolve the group once, then restore any ceremony this device had open.
  useEffect(() => {
    let active = true;
    void readDrawGroup(deps).then((read) => {
      if (!active) return;
      if (read.status !== "ok") {
        return setLoad({
          kind: "message",
          key:
            read.status === "no-group"
              ? "drawLive.noGroup"
              : read.status === "multiple-groups"
                ? "drawLive.multipleGroups"
                : read.status === "unauthorized"
                  ? "drawLive.error.unauthorized"
                  : "drawLive.loadError"
        });
      }
      setLoad({ kind: "ready", group: read.group });
      const saved = readDraft(read.group.groupId);
      if (saved !== null) {
        setDraft(saved);
        setSealDrawId(saved.drawId);
        setVerifyDrawId(saved.drawId);
        if (saved.committed) void refresh(saved.drawId);
      }
    });
    return () => {
      active = false;
    };
    // `refresh` is stable for a given `deps`; the group is resolved once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setMySeal(isUuid(sealDrawId) ? readSeal(sealDrawId.trim().toLowerCase()) : null);
  }, [sealDrawId]);

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }, []);

  // -- step 0: a member seals ---------------------------------------------------

  const seal = () =>
    run("seal", async () => {
      const drawId = sealDrawId.trim().toLowerCase();
      if (!isUuid(drawId)) return setProblem({ key: "drawLive.sealNeedDrawId" });
      if (myUserId === null || group === null || !group.members.some((member) => member.userId === myUserId)) {
        return setProblem({ key: "drawLive.sealNotMember" });
      }
      const made = await sealForDraw(drawId, myUserId);
      writeSeal(made);
      setMySeal(made);
    });

  // -- step 1: open + commit -----------------------------------------------------

  const openDraw = () => {
    if (group === null) return;
    const drawId = globalThis.crypto.randomUUID();
    const next: DrawDraft = {
      drawId,
      seed: randomHex(),
      commitmentNonce: randomHex(),
      commitKey: `draw-commit.${drawId}`,
      revealKey: `draw-reveal.${drawId}`,
      committed: false
    };
    writeDraft(group.groupId, next);
    setDraft(next);
    setSealDrawId(drawId);
    setVerifyDrawId(drawId);
    setWire(null);
    setCheck(null);
    setReceipt(null);
    setConfirmPayout(false);
    setProblem(null);
  };

  const commit = () =>
    run("commit", async () => {
      if (group === null || draft === null) return;
      const roundNumber = Number(round);
      const total = Number(totalRounds);
      const each = normaliseAmount(contribution);
      const bps = Math.round(Number(reservePercent) * 100);
      const pot = each === null ? null : potFromContribution(each, group.members.length);
      if (
        !isUuid(cycleId) ||
        !Number.isInteger(roundNumber) ||
        !Number.isInteger(total) ||
        roundNumber < 1 ||
        total < roundNumber ||
        each === null ||
        pot === null ||
        !Number.isFinite(bps) ||
        bps < 0 ||
        bps > 3333
      ) {
        return setProblem({ key: "drawLive.commitInvalidFields" });
      }
      const parsed = parseSealLines(sealsText);
      if (!parsed.ok) return setProblem({ key: "drawLive.badLine", vars: { line: parsed.line } });
      if (!parsed.entries.some((entry) => entry.memberId !== myUserId)) {
        return setProblem({ key: "drawLive.needOtherSeal" });
      }
      const result = await commitDraw(
        {
          groupId: group.groupId,
          cycleId: cycleId.trim().toLowerCase(),
          round: roundNumber,
          totalRounds: total,
          drawId: draft.drawId,
          commitmentNonce: draft.commitmentNonce,
          seed: draft.seed,
          memberCommitments: parsed.entries,
          potAmount: pot,
          reserveRatioBps: bps,
          members: group.members.map((member) => ({
            memberId: member.userId,
            displayName: member.email ?? `Member ${shortId(member.userId)}`,
            contributionAmount: each
          })),
          idempotencyKey: draft.commitKey
        },
        deps
      );
      if (!result.ok) return fail(result);
      const committed = { ...draft, committed: true };
      writeDraft(group.groupId, committed);
      setDraft(committed);
      await refresh(draft.drawId);
    });

  // -- step 2: reveal ------------------------------------------------------------

  const reveal = () =>
    run("reveal", async () => {
      if (group === null || draft === null || wire === null) return;
      if (draft.seed === "") return setProblem({ key: "drawLive.revealNoSeed" });
      const parsed = parseOpeningLines(openingsText);
      if (!parsed.ok) return setProblem({ key: "drawLive.badLine", vars: { line: parsed.line } });
      // Cheap to catch here, and names the member, which the server's error does not.
      const bad = await checkOpenings(draft.drawId, wire.transcript.memberCommitments, parsed.entries);
      if (bad.length > 0) {
        return setProblem({ key: "drawLive.openingMismatch", vars: { members: bad.map(labelFor).join(", ") } });
      }
      const result = await revealDraw(
        { drawId: draft.drawId, seed: draft.seed, memberNonces: parsed.entries, idempotencyKey: draft.revealKey },
        deps
      );
      if (!result.ok) return fail(result);
      // The seed is public now; there is nothing left to protect on this device.
      const done = { ...draft, seed: "", revealed: true };
      writeDraft(group.groupId, done);
      setDraft(done);
      await refresh(draft.drawId);
    });

  // -- step 3: verify (anyone) ---------------------------------------------------

  const verify = () =>
    run("verify", async () => {
      const drawId = verifyDrawId.trim().toLowerCase();
      if (!isUuid(drawId)) return setProblem({ key: "drawLive.verifyNeedDrawId" });
      setReceipt(null);
      setConfirmPayout(false);
      await refresh(drawId);
    });

  // -- step 4: payout ------------------------------------------------------------

  const payout = () =>
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
      setReceipt(result.data);
      setConfirmPayout(false);
      await refresh(wire.round.drawId);
    });

  // -- render --------------------------------------------------------------------

  const winnerId = check?.trusted ? check.local.winnerMemberId : null;
  const phase: CeremonyPhase =
    wire === null ? "idle" : check?.trusted ? "revealed" : "sealed";
  const roundLabel = wire
    ? copy.roundLabel(wire.round.round, wire.round.totalRounds)
    : copy.roundLabel(Number(round) || 1, Number(totalRounds) || Number(round) || 1);

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
  const eachNormalised = normaliseAmount(contribution);
  const potPreview = eachNormalised === null ? null : potFromContribution(eachNormalised, readyGroup.members.length);
  const round1 = wire?.round ?? null;
  const canPay = isTreasurer && round1 !== null && round1.state === "revealed" && check !== null && check.trusted;

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
          <p className={HINT}>
            {isTreasurer ? t("drawLive.roleTreasurerNote") : t("drawLive.roleMemberNote")}
          </p>
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
                <span className="shrink-0 text-[11px] text-[#6F625D]">{t(`drawLive.role.${member.role}`)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={CARD} aria-label={t("drawLive.sealTitle")} data-draw-panel="seal">
          <h3 className={HEADING}>{t("drawLive.sealTitle")}</h3>
          <p className={HINT}>{t("drawLive.sealDetail")}</p>
          <label className="mt-2 block">
            <span className={LABEL}>{t("drawLive.drawIdLabel")}</span>
            <input
              aria-label={t("drawLive.sealDrawIdLabel")}
              className={FIELD}
              value={sealDrawId}
              onChange={(event) => setSealDrawId(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          {mySeal === null ? (
            <button type="button" className={`${BUTTON} mt-3`} disabled={busy !== null} onClick={() => void seal()}>
              {busy === "seal" ? t("drawLive.working") : t("drawLive.sealAction")}
            </button>
          ) : (
            <div data-testid="my-seal">
              <p className="mt-2 text-[12px] font-semibold text-[#065F46]">{t("drawLive.sealDone")}</p>
              <CopyField label={t("drawLive.sealLineLabel")} value={sealLine(mySeal)} copyLabel={t("drawLive.copy")} />
              <CopyField label={t("drawLive.openingLineLabel")} value={openingLine(mySeal)} copyLabel={t("drawLive.copy")} />
              <p className={HINT}>{t("drawLive.sealKeepSecret")}</p>
            </div>
          )}
        </section>

        {isTreasurer ? (
          <section className={CARD} aria-label={t("drawLive.ceremonyTitle")} data-draw-panel="treasurer">
            <h3 className={HEADING}>{t("drawLive.ceremonyTitle")}</h3>

            {draft === null || draft.revealed ? (
              <>
                <p className={HINT}>{t("drawLive.openDetail")}</p>
                <button type="button" className={`${BUTTON} mt-3`} onClick={openDraw}>
                  {t("drawLive.openAction")}
                </button>
              </>
            ) : (
              <>
                <CopyField label={t("drawLive.drawIdLabel")} value={draft.drawId} copyLabel={t("drawLive.copy")} />
                <p className={HINT}>{t("drawLive.openShare")}</p>

                {!draft.committed ? (
                  <div className="mt-3 space-y-2" data-testid="commit-form">
                    <div>
                      <label className="block">
                        <span className={LABEL}>{t("drawLive.cycleIdLabel")}</span>
                        <input className={FIELD} value={cycleId} onChange={(e) => setCycleId(e.target.value)} spellCheck={false} />
                      </label>
                      <p className={HINT}>{t("drawLive.cycleIdHint")}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className={LABEL}>{t("drawLive.roundLabel")}</span>
                        <input className={FIELD} inputMode="numeric" value={round} onChange={(e) => setRound(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className={LABEL}>{t("drawLive.totalRoundsLabel")}</span>
                        <input className={FIELD} inputMode="numeric" value={totalRounds} onChange={(e) => setTotalRounds(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className={LABEL}>{t("drawLive.contributionLabel")}</span>
                        <input className={FIELD} inputMode="decimal" value={contribution} onChange={(e) => setContribution(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className={LABEL}>{t("drawLive.reserveLabel")}</span>
                        <input className={FIELD} inputMode="decimal" value={reservePercent} onChange={(e) => setReservePercent(e.target.value)} />
                      </label>
                    </div>
                    {potPreview !== null && eachNormalised !== null ? (
                      <p data-testid="pot-preview" className="text-[12px] font-semibold text-[#1C1410]">
                        {t("drawLive.potLine", {
                          pot: formatEtbDisplay(potPreview),
                          count: readyGroup.members.length,
                          each: formatEtbDisplay(eachNormalised)
                        })}
                      </p>
                    ) : null}
                    <label className="block">
                      <span className={LABEL}>{t("drawLive.sealsLabel")}</span>
                      <textarea
                        className={`${FIELD} min-h-24 font-mono text-[11px]`}
                        value={sealsText}
                        onChange={(e) => setSealsText(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    {mySeal !== null && mySeal.drawId === draft.drawId ? (
                      <button
                        type="button"
                        className={SECONDARY}
                        onClick={() => setSealsText((text) => `${text.trim()}${text.trim() ? "\n" : ""}${sealLine(mySeal)}`)}
                      >
                        {t("drawLive.addMine")}
                      </button>
                    ) : null}
                    <p className={HINT}>{t("drawLive.seedNote")}</p>
                    <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void commit()}>
                      {busy === "commit" ? t("drawLive.working") : t("drawLive.commitAction")}
                    </button>
                  </div>
                ) : wire !== null && wire.round.state === "committed" ? (
                  <div className="mt-3 space-y-2" data-testid="reveal-form">
                    <p className="text-[12px] font-semibold text-[#065F46]">{t("drawLive.commitDone")}</p>
                    <label className="block">
                      <span className={LABEL}>{t("drawLive.openingsLabel")}</span>
                      <textarea
                        className={`${FIELD} min-h-24 font-mono text-[11px]`}
                        value={openingsText}
                        onChange={(e) => setOpeningsText(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    {mySeal !== null && mySeal.drawId === draft.drawId ? (
                      <button
                        type="button"
                        className={SECONDARY}
                        onClick={() => setOpeningsText((text) => `${text.trim()}${text.trim() ? "\n" : ""}${openingLine(mySeal)}`)}
                      >
                        {t("drawLive.addMine")}
                      </button>
                    ) : null}
                    <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void reveal()}>
                      {busy === "reveal" ? t("drawLive.working") : t("drawLive.revealAction")}
                    </button>
                  </div>
                ) : (
                  <p className={HINT}>{t("drawLive.commitDone")}</p>
                )}
              </>
            )}
          </section>
        ) : null}

        <section className={CARD} aria-label={t("drawLive.verifyTitle")} data-draw-panel="verify-live">
          <h3 className={HEADING}>{t("drawLive.verifyTitle")}</h3>
          <p className={HINT}>{t("drawLive.verifyDetail")}</p>
          <label className="mt-2 block">
            <span className={LABEL}>{t("drawLive.drawIdLabel")}</span>
            <input
              aria-label={t("drawLive.verifyDrawIdLabel")}
              className={FIELD}
              value={verifyDrawId}
              onChange={(event) => setVerifyDrawId(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button type="button" className={`${BUTTON} mt-3`} disabled={busy !== null} onClick={() => void verify()}>
            {busy === "verify" ? t("drawLive.working") : t("drawLive.verifyAction")}
          </button>
        </section>

        {wire !== null && check !== null ? (
          <>
            <ComparePanel t={t} wire={wire} check={check} labelFor={labelFor} />
            {check.revealed ? (
              <VerifyPanel transcript={wire.transcript} verification={check.local} isRunning={false} error={null} />
            ) : null}
            {check.risk !== null && check.trusted ? (
              <RiskPanel risk={check.risk} currencyLabel={copy.currency} />
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
                  onClick={() => void payout()}
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

function ComparePanel({
  t,
  wire,
  check,
  labelFor
}: {
  readonly t: (key: DrawLiveKey, variables?: Record<string, string | number>) => string;
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
