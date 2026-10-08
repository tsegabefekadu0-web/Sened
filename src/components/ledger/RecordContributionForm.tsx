"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, BadgeCheck, HandCoins } from "lucide-react";

import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { useSession } from "@/lib/auth/useSession";
import { serverDisagreesWithActiveGroup, shortGroupId } from "@/lib/groups/activeGroup";
import { useActiveGroupPreference } from "@/lib/groups/useActiveGroup";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import { attributePayer, type AttributeResult } from "@/lib/ledger/clientAttribution";
import {
  ContributionBuildError,
  buildContributionRequest,
  loadContributionContext,
  newContributionIdempotencyKey,
  postContribution,
  type ContributionContext,
  type PostContributionResult,
  type PostedAttribution
} from "@/lib/ledger/clientContribution";
import { isEtbAmount } from "@/lib/ledger/money";
import {
  CONTRIBUTION_CHANNELS,
  CONTRIBUTION_NOTE_MAX,
  checkContributionNote,
  isBlankNote,
  isContributionChannel,
  type ContributionChannel
} from "@/lib/ledger/paymentChannel";

/**
 * Record one contribution and who paid it (ROADMAP 4.2, owner / treasurer only).
 *
 * One `POST /api/ledger/entries` carries the balanced entry and the `attribution`.
 * The two are separate writes and the ledger is the source of truth, so the result
 * is shown as what it is:
 *
 * - posted and attributed;
 * - posted, but the attribution was refused (the reason, and a one-click retry of
 *   ONLY the attribution through the existing attribute action: the entry is never
 *   posted a second time for that);
 * - failed (nothing recorded, or the outcome unknown: resubmitting the same attempt
 *   reuses its idempotency key, so it cannot post twice).
 *
 * How it was paid (telebirr, CBE, Awash, cash, other) and a short plain-text note
 * travel WITH the payer: they are saved beside the entry on the attribution record,
 * never inside the hash-chained entry. The note is shown to the group as text.
 *
 * Plain members and signed-out visitors see read-only text and no controls. The
 * database refuses everyone else regardless of what this form shows.
 */

type Translator = ReturnType<typeof createTranslator>;

const CONTEXT_MESSAGES: Readonly<Record<Exclude<ContributionContext["status"], "ready">, MessageKey>> = {
  "read-only": "record.readOnly",
  "no-accounts": "record.noAccounts",
  unauthorized: "record.unauthorized",
  "no-group": "record.noGroup",
  "choose-group": "record.chooseGroup",
  error: "record.loadError"
};

const CHANNEL_LABEL_KEYS: Readonly<Record<ContributionChannel, MessageKey>> = {
  telebirr: "shell.feed.channelTelebirr",
  cbe: "shell.feed.channelCbe",
  awash: "shell.feed.channelAwash",
  cash: "shell.feed.channelCash",
  other: "shell.feed.channelOther"
};

const FAILURE_MESSAGES: Readonly<Record<Exclude<PostContributionResult["status"], "created">, MessageKey>> = {
  invalid: "record.fail.invalid",
  unauthorized: "record.fail.unauthorized",
  forbidden: "record.fail.forbidden",
  conflict: "record.fail.conflict",
  "rate-limited": "record.fail.rate_limited",
  error: "record.fail.error"
};

function attributeErrorKey(result: Exclude<AttributeResult, { status: "ok" }>): MessageKey {
  switch (result.status) {
    case "refused":
      return `shell.feed.attribute.error.${result.code}` as MessageKey;
    case "forbidden":
      return "shell.feed.attribute.error.forbidden";
    case "unauthorized":
      return "shell.feed.attribute.error.unauthorized";
    case "rate-limited":
      return "shell.feed.attribute.error.rate_limited";
    case "error":
      return "shell.feed.attribute.error.error";
  }
}

function localDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The instant a date paid stands for: now for today, local noon for an earlier day. */
function occurredAtFor(date: string, now: Date): Date {
  if (date === localDateString(now)) {
    return now;
  }
  return new Date(`${date}T12:00:00`);
}

interface Posted {
  readonly entryId: string;
  readonly sequence: string;
  readonly replayed: boolean;
  readonly groupId: string;
  readonly payerLabel: string;
  readonly payer: {
    readonly memberUserId: string;
    readonly cycleId?: string;
    readonly round?: number;
    readonly channel?: ContributionChannel;
    readonly note?: string;
  };
  readonly attribution: PostedAttribution;
}

type FieldError = "amount" | "date" | "payer" | "round" | "roundNeedsCycle" | "note";

export interface RecordContributionFormProps {
  readonly locale?: Locale;
  /** Test seam: token source and `fetch` for every call the form makes. */
  readonly deps?: AuthedFetchDeps;
}

export function RecordContributionForm({ locale = "en", deps }: RecordContributionFormProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const { ready: groupReady, groupId: activeGroupId, reload: reloadGroups } = useActiveGroupPreference();

  const [context, setContext] = useState<ContributionContext | "loading">("loading");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString(new Date()));
  const [payer, setPayer] = useState("");
  const [cycleId, setCycleId] = useState("");
  const [round, setRound] = useState("");
  const [channel, setChannel] = useState<ContributionChannel | "">("");
  const [note, setNote] = useState("");
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [failure, setFailure] = useState<Exclude<PostContributionResult["status"], "created"> | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<MessageKey | null>(null);
  // A save that finished after the person switched groups: said once, never applied to the new group's form.
  const [lateResult, setLateResult] = useState<{ readonly group: string; readonly saved: boolean } | null>(null);

  // Bumped whenever the form is (re)pointed at a group. A response that carries an
  // older value belongs to a form that no longer exists and must not touch this one.
  const formEpoch = useRef(0);
  const inFlight = useRef(false);
  // One idempotency key (and one timestamp) per distinct attempt: a resubmit of
  // the same values after an unknown outcome sends the identical request, so the
  // server can only ever post it once.
  const attempt = useRef<{ fingerprint: string; key: string; occurredAt: Date } | null>(null);

  useEffect(() => {
    if (!signedIn || !groupReady) {
      setContext("loading");
      return;
    }
    let active = true;
    setContext("loading");
    // A different group is a different ledger: nothing typed or posted carries over.
    formEpoch.current += 1;
    inFlight.current = false;
    setSubmitting(false);
    setRetrying(false);
    setRetryError(null);
    setLateResult(null);
    attempt.current = null;
    setPayer("");
    setCycleId("");
    setRound("");
    setChannel("");
    setNote("");
    setPosted(null);
    setFailure(null);
    void loadContributionContext(deps ?? {}, { groupId: activeGroupId }).then((next) => {
      if (!active) return;
      setContext(next);
      if (serverDisagreesWithActiveGroup(next as { status: string; groupId?: string }, activeGroupId)) {
        reloadGroups();
      }
    });
    return () => {
      active = false;
    };
    // `deps` is a test seam that is stable for the life of a mounted form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, groupReady, activeGroupId]);

  const ready = context !== "loading" && context.status === "ready" ? context : null;
  const cycle = ready?.cycles.find((candidate) => candidate.cycleId === cycleId) ?? null;

  const memberLabel = (userId: string, email: string | null) =>
    email ?? t("members.anonymous", { id: userId.slice(0, 8) });

  function changeCycle(next: string) {
    setCycleId(next);
    setRound("");
    setFieldError(null);
    const chosen = ready?.cycles.find((candidate) => candidate.cycleId === next);
    // A cycle knows what one member pays per round; offer it, never overwrite what was typed.
    if (chosen?.contributionAmount && amount.trim() === "") {
      setAmount(chosen.contributionAmount);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || inFlight.current) {
      return;
    }
    const trimmedAmount = amount.trim();
    if (!isEtbAmount(trimmedAmount, true)) {
      setFieldError("amount");
      return;
    }
    const now = new Date();
    if (date === "" || Number.isNaN(new Date(`${date}T12:00:00`).getTime()) || date > localDateString(now)) {
      setFieldError("date");
      return;
    }
    if (payer === "") {
      setFieldError("payer");
      return;
    }
    let roundNumber: number | undefined;
    if (round.trim() !== "") {
      if (cycleId === "" || cycle === null) {
        setFieldError("roundNeedsCycle");
        return;
      }
      roundNumber = /^\d{1,4}$/.test(round.trim()) ? Number(round.trim()) : Number.NaN;
      if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > cycle.totalRounds) {
        setFieldError("round");
        return;
      }
    }
    let cleanNote: string | undefined;
    if (!isBlankNote(note)) {
      const checked = checkContributionNote(note);
      if (!checked.ok) {
        setFieldError("note");
        return;
      }
      cleanNote = checked.note;
    }
    setFieldError(null);

    // Everything that is sent is part of the attempt: a changed channel or note is a
    // different request and must not reuse the key (the server would refuse it as a conflict).
    const fingerprint = [
      ready.groupId,
      trimmedAmount,
      date,
      payer,
      cycleId,
      roundNumber ?? "",
      channel,
      cleanNote ?? ""
    ].join("|");
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newContributionIdempotencyKey(), occurredAt: occurredAtFor(date, now) };
    }
    let request;
    try {
      request = buildContributionRequest({
        groupId: ready.groupId,
        cashAccountId: ready.cashAccountId,
        incomeAccountId: ready.incomeAccountId,
        amount: trimmedAmount,
        occurredAt: attempt.current.occurredAt,
        idempotencyKey: attempt.current.key
      });
    } catch (error) {
      if (!(error instanceof ContributionBuildError)) throw error;
      setFieldError(error.code === "date" ? "date" : "amount");
      return;
    }
    const payerChoice = {
      memberUserId: payer,
      ...(cycleId === "" ? {} : { cycleId }),
      ...(roundNumber === undefined ? {} : { round: roundNumber }),
      ...(channel === "" ? {} : { channel }),
      ...(cleanNote === undefined ? {} : { note: cleanNote })
    };
    const member = ready.members.find((candidate) => candidate.userId === payer);

    const epoch = formEpoch.current;
    const groupLabel = ready.groupName || shortGroupId(ready.groupId);
    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);
    setPosted(null);
    setRetryError(null);
    setLateResult(null);
    const result = await postContribution(request, payerChoice, deps ?? {});
    if (epoch !== formEpoch.current) {
      // The person switched groups while this was saving. The money went to the
      // group it was built for; the form in front of them is another ledger's, so
      // leave its fields, key and results alone and only say what happened.
      setLateResult({ group: groupLabel, saved: result.status === "created" });
      return;
    }
    inFlight.current = false;
    setSubmitting(false);

    if (result.status === "created") {
      attempt.current = null;
      setPosted({
        entryId: result.entryId,
        sequence: result.sequence,
        replayed: result.replayed,
        groupId: ready.groupId,
        payerLabel: member ? memberLabel(member.userId, member.email) : payer.slice(0, 8),
        payer: payerChoice,
        attribution: result.attribution ?? { status: "failed" }
      });
      setAmount("");
      setPayer("");
      setCycleId("");
      setRound("");
      setChannel("");
      setNote("");
      return;
    }
    setFailure(result.status);
    if (result.status === "invalid" || result.status === "conflict") {
      // A definite answer about this exact attempt: retire its key.
      attempt.current = null;
    }
  }

  async function retryAttribution() {
    if (!posted || retrying) return;
    const epoch = formEpoch.current;
    setRetrying(true);
    setRetryError(null);
    const result = await attributePayer({ groupId: posted.groupId, entryId: posted.entryId, ...posted.payer }, deps ?? {});
    if (epoch !== formEpoch.current) {
      return; // the person moved to another group's form: this result is not theirs to see
    }
    setRetrying(false);
    if (result.status === "ok") {
      setPosted({ ...posted, attribution: { status: "recorded", replayed: result.replayed } });
    } else if (result.status === "refused") {
      setPosted({ ...posted, attribution: { status: "refused", code: result.code } });
    } else {
      setRetryError(attributeErrorKey(result));
    }
  }

  const inputClass =
    "mt-2 block min-h-12 w-full rounded-xl border border-coffee-900/20 bg-white/75 px-3 text-base text-coffee-900 focus:border-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50";
  const errorFor = (name: FieldError) => (fieldError === name ? name : null);

  return (
    <section
      id="record-contribution"
      aria-labelledby="record-heading"
      className="scroll-mt-8 border-t border-coffee-900/10 py-12 sm:py-16"
    >
      <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-coffee-900 text-gold-300">
              <HandCoins aria-hidden="true" className="h-5 w-5" />
            </span>
            <h2 id="record-heading" className="text-3xl font-bold tracking-tight text-coffee-950">
              {t("record.title")}
            </h2>
          </div>
          <p className="mt-5 max-w-xl text-base leading-7 text-inkMuted">{t("record.help")}</p>
        </div>

        <div className="rounded-2xl border border-coffee-900/15 bg-parchment-50 p-6 shadow-card sm:p-8">
          {!signedIn ? (
            <p data-testid="record-state" className="text-base leading-6 text-inkMuted">
              {t("record.signIn")}
            </p>
          ) : context === "loading" ? (
            <p role="status" data-testid="record-state" className="text-base font-semibold leading-6 text-inkMuted">
              {t("record.loading")}
            </p>
          ) : context.status !== "ready" ? (
            <p
              role={context.status === "read-only" ? "status" : "alert"}
              data-testid="record-state"
              className="flex items-start gap-2 text-base font-semibold leading-6 text-terracotta-700"
            >
              <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {t(CONTEXT_MESSAGES[context.status])}
            </p>
          ) : (
            <form aria-labelledby="record-heading" onSubmit={(event) => void submit(event)} noValidate>
              <p data-testid="record-target-group" className="mb-5 text-base font-semibold text-coffee-900">
                {t("record.targetGroup", { group: context.groupName || shortGroupId(context.groupId) })}
              </p>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="record-amount" className="text-base font-bold text-coffee-900">
                    {t("record.amountLabel")} <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="record-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setFieldError(null);
                    }}
                    required
                    aria-invalid={errorFor("amount") !== null}
                    aria-describedby={errorFor("amount") ? "record-amount-help record-amount-error" : "record-amount-help"}
                    className={inputClass}
                  />
                  <p id="record-amount-help" className="mt-2 text-base leading-relaxed text-inkMuted">
                    {t("record.amountHelp")}
                  </p>
                  {errorFor("amount") ? <FieldMessage id="record-amount-error" text={t("record.error.amount")} /> : null}
                </div>

                <div>
                  <label htmlFor="record-date" className="text-base font-bold text-coffee-900">
                    {t("record.dateLabel")} <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="record-date"
                    type="date"
                    value={date}
                    max={localDateString(new Date())}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setFieldError(null);
                    }}
                    required
                    aria-invalid={errorFor("date") !== null}
                    aria-describedby={errorFor("date") ? "record-date-error" : undefined}
                    className={inputClass}
                  />
                  {errorFor("date") ? <FieldMessage id="record-date-error" text={t("record.error.date")} /> : null}
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="record-payer" className="text-base font-bold text-coffee-900">
                    {t("record.payerLabel")} <span aria-hidden="true">*</span>
                  </label>
                  <select
                    id="record-payer"
                    value={payer}
                    onChange={(event) => {
                      setPayer(event.target.value);
                      setFieldError(null);
                    }}
                    required
                    aria-invalid={errorFor("payer") !== null}
                    aria-describedby={errorFor("payer") ? "record-payer-error" : undefined}
                    className={inputClass}
                  >
                    <option value="">{t("record.payerChoose")}</option>
                    {context.members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {memberLabel(member.userId, member.email)}
                      </option>
                    ))}
                  </select>
                  {errorFor("payer") ? <FieldMessage id="record-payer-error" text={t("record.error.payer")} /> : null}
                </div>

                <div>
                  <label htmlFor="record-channel" className="text-base font-bold text-coffee-900">
                    {t("record.channelLabel")}
                  </label>
                  <select
                    id="record-channel"
                    value={channel}
                    onChange={(event) => {
                      setChannel(isContributionChannel(event.target.value) ? event.target.value : "");
                      setFieldError(null);
                    }}
                    className={inputClass}
                  >
                    <option value="">{t("record.channelNone")}</option>
                    {CONTRIBUTION_CHANNELS.map((option) => (
                      <option key={option} value={option}>
                        {t(CHANNEL_LABEL_KEYS[option])}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="record-note" className="text-base font-bold text-coffee-900">
                    {t("record.noteLabel")}
                  </label>
                  <input
                    id="record-note"
                    type="text"
                    autoComplete="off"
                    maxLength={CONTRIBUTION_NOTE_MAX * 2}
                    value={note}
                    onChange={(event) => {
                      setNote(event.target.value);
                      setFieldError(null);
                    }}
                    aria-invalid={errorFor("note") !== null}
                    aria-describedby={errorFor("note") ? "record-note-help record-note-error" : "record-note-help"}
                    className={inputClass}
                  />
                  <p id="record-note-help" className="mt-2 text-base leading-relaxed text-inkMuted">
                    {t("record.noteHelp")}
                  </p>
                  {errorFor("note") ? <FieldMessage id="record-note-error" text={t("record.error.note")} /> : null}
                </div>

                {context.cyclesLoaded ? (
                  <>
                    <div>
                      <label htmlFor="record-cycle" className="text-base font-bold text-coffee-900">
                        {t("record.cycleLabel")}
                      </label>
                      <select
                        id="record-cycle"
                        value={cycleId}
                        onChange={(event) => changeCycle(event.target.value)}
                        className={inputClass}
                      >
                        <option value="">{t("record.cycleNone")}</option>
                        {context.cycles.map((candidate) => (
                          <option key={candidate.cycleId} value={candidate.cycleId}>
                            {candidate.closed ? t("record.cycleClosed", { name: candidate.name }) : candidate.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="record-round" className="text-base font-bold text-coffee-900">
                        {t("record.roundLabel")}
                      </label>
                      <input
                        id="record-round"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={cycle?.totalRounds}
                        step={1}
                        value={round}
                        disabled={cycle === null}
                        onChange={(event) => {
                          setRound(event.target.value);
                          setFieldError(null);
                        }}
                        aria-invalid={errorFor("round") !== null || errorFor("roundNeedsCycle") !== null}
                        aria-describedby={
                          errorFor("round") || errorFor("roundNeedsCycle") ? "record-round-help record-round-error" : "record-round-help"
                        }
                        className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-60`}
                      />
                      {cycle ? (
                        <p id="record-round-help" className="mt-2 text-base leading-relaxed text-inkMuted">
                          {cycle.nextRound === null
                            ? t("record.roundHelp", { total: cycle.totalRounds })
                            : t("record.roundHelpNext", { total: cycle.totalRounds, next: cycle.nextRound })}
                        </p>
                      ) : (
                        <p id="record-round-help" className="sr-only">
                          {t("record.error.roundNeedsCycle")}
                        </p>
                      )}
                      {errorFor("round") && cycle ? (
                        <FieldMessage id="record-round-error" text={t("record.error.round", { total: cycle.totalRounds })} />
                      ) : null}
                      {errorFor("roundNeedsCycle") ? (
                        <FieldMessage id="record-round-error" text={t("record.error.roundNeedsCycle")} />
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="text-base leading-relaxed text-inkMuted sm:col-span-2" data-testid="record-cycles-unavailable">
                    {t("record.cyclesUnavailable")}
                  </p>
                )}
              </div>

              <div className="mt-6">
                <button
                  type="submit"
                  disabled={submitting}
                  aria-busy={submitting}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-terracotta-600 px-4 py-2.5 text-base font-bold text-white transition-colors hover:bg-terracotta-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                >
                  {submitting ? t("record.saving") : t("record.submit")}
                </button>
              </div>

              {submitting ? (
                <p role="status" className="mt-4 text-base font-semibold leading-relaxed text-inkMuted">
                  {t("record.saving")}
                </p>
              ) : null}

              {failure ? (
                <p
                  role="alert"
                  data-testid="record-failure"
                  className="mt-4 flex items-start gap-2 text-base font-semibold leading-relaxed text-terracotta-700"
                >
                  <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  {t(FAILURE_MESSAGES[failure])}
                </p>
              ) : null}

              {lateResult ? (
                <p role="status" data-testid="record-late-result" className="mt-4 text-base font-semibold leading-relaxed text-inkMuted">
                  {t(lateResult.saved ? "record.lateSaved" : "record.lateUnknown", { group: lateResult.group })}
                </p>
              ) : null}

              {posted ? (
                <PostedResult
                  posted={posted}
                  t={t}
                  retrying={retrying}
                  retryError={retryError}
                  onRetry={() => void retryAttribution()}
                />
              ) : null}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

function FieldMessage({ id, text }: { readonly id: string; readonly text: string }) {
  return (
    <p id={id} role="alert" className="mt-2 flex items-start gap-2 text-base font-semibold leading-relaxed text-terracotta-700">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      {text}
    </p>
  );
}

function PostedResult({
  posted,
  t,
  retrying,
  retryError,
  onRetry
}: {
  readonly posted: Posted;
  readonly t: Translator;
  readonly retrying: boolean;
  readonly retryError: MessageKey | null;
  readonly onRetry: () => void;
}) {
  const { attribution } = posted;
  const attributed = attribution.status === "recorded";
  return (
    <div
      role="status"
      data-testid="record-result"
      className={`mt-5 flex items-start gap-3 rounded-xl border p-4 text-base leading-6 ${
        attributed ? "border-[#B7DFC1] bg-[#EFFAF1] text-[#166534]" : "border-[#E5C9A8] bg-[#FBF1E3] text-[#7A4B12]"
      }`}
    >
      {attributed ? (
        <BadgeCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
      )}
      <div>
        <p className="font-bold" data-testid="record-posted">
          {posted.replayed
            ? t("record.result.replayed", { sequence: posted.sequence })
            : t("record.result.posted", { sequence: posted.sequence })}
        </p>
        {attribution.status === "recorded" ? (
          <>
            <p data-testid="record-attributed">{t("record.result.attributed", { payer: posted.payerLabel })}</p>
            {posted.payer.channel ? (
              <p data-testid="record-channel">
                {t("record.result.channel", { channel: t(CHANNEL_LABEL_KEYS[posted.payer.channel]) })}
              </p>
            ) : null}
            {posted.payer.note ? <p data-testid="record-note">{t("record.result.note", { note: posted.payer.note })}</p> : null}
          </>
        ) : attribution.status === "refused" ? (
          <p data-testid="record-attribution-refused">
            {t("record.result.refused", { reason: t(`shell.feed.attribute.error.${attribution.code}` as MessageKey) })}
          </p>
        ) : (
          <p data-testid="record-attribution-failed">{t("record.result.failed")}</p>
        )}
        {!attributed ? (
          <>
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="mt-3 inline-flex min-h-12 items-center justify-center rounded-xl border border-coffee-900/25 bg-white/70 px-4 text-base font-bold text-coffee-900 transition-colors hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {retrying ? t("record.retrying") : t("record.retry")}
            </button>
            {retryError ? (
              <p role="alert" data-testid="record-retry-error" className="mt-2 text-base font-semibold">
                {t(retryError)}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
