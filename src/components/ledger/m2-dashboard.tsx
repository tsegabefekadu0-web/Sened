"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  FileLock2,
  FileText,
  Fingerprint,
  GitBranch,
  History,
  Info,
  Landmark,
  Languages,
  Link2Off,
  LockKeyhole,
  Plus,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createTranslator, type Locale, type MessageKey } from "@/lib/i18n";
import type { BankVerificationErrorCode } from "@/lib/banking/errors";
import type { BankVerificationReasonCode, BankVerificationState, ReconciliationJobState } from "@/lib/banking/types";
import type { LedgerErrorCode } from "@/lib/ledger/errors";
import type { LedgerEntryType } from "@/lib/ledger/types";
import { useSession } from "@/lib/auth/useSession";
import { loadCorrectionTargets, type CorrectionTarget, type LiveCorrectionTarget, type LiveLedgerResult } from "@/lib/ledger/clientRead";
import { postCorrection, type PostCorrectionResult } from "@/lib/ledger/clientCorrect";
import { buildCorrectionRequest, CorrectionBuildError, newCorrectionIdempotencyKey } from "@/lib/ledger/correction";
import { TibebHeaderPattern } from "@/components/cultural/TibebPattern";

type Translator = ReturnType<typeof createTranslator>;
type StatusTone = "verified" | "pending" | "danger" | "warning" | "neutral" | "info";
type CorrectionError = "required" | "length" | "target";
type SubmitError = "unbuildable" | Exclude<PostCorrectionResult["status"], "created">;
type LiveCorrectionSuccess = {
  readonly originalReference: string;
  readonly amount: string;
  readonly sequence: string;
  readonly replayed: boolean;
};

type DashboardEntry = {
  readonly id: string;
  readonly type: LedgerEntryType;
  readonly amount: string;
  readonly direction: "inbound" | "outbound";
  readonly status: BankVerificationState;
  readonly reason: BankVerificationReasonCode;
  readonly reference: string;
  readonly sequence: string;
  readonly hash: string;
  readonly memberKey: MessageKey;
  readonly recordedAt: string;
  readonly isCorrection?: boolean;
  readonly correctsReference?: string;
};

const TRUSTED_BALANCE = "186450.00";
const PENDING_AMOUNT = "12500.00";
const REVIEW_AMOUNT = "8150.00";
const LAST_RECORDED_AT = "2026-09-25T14:22:00+03:00";
const DEMO_CORRECTION_DATE = "2026-09-25T15:06:00+03:00";

const initialEntries: DashboardEntry[] = [
  {
    id: "entry-428",
    type: "contribution",
    amount: "12000.00",
    direction: "inbound",
    status: "VERIFIED",
    reason: "VERIFIED",
    reference: "TXN-4281",
    sequence: "000428",
    hash: "a19c…7e40",
    memberKey: "m2.fixture.abebe",
    recordedAt: "2026-09-25T14:22:00+03:00"
  },
  {
    id: "entry-427",
    type: "disbursement",
    amount: "8500.00",
    direction: "outbound",
    status: "VERIFIED",
    reason: "VERIFIED",
    reference: "PAY-2048",
    sequence: "000427",
    hash: "b82d…3a91",
    memberKey: "m2.fixture.senedFund",
    recordedAt: "2026-09-24T18:40:00+03:00"
  },
  {
    id: "entry-426",
    type: "contribution",
    amount: "12500.00",
    direction: "inbound",
    status: "PENDING_RECONCILIATION",
    reason: "PROVIDER_UNAVAILABLE",
    reference: "TXN-4276",
    sequence: "000426",
    hash: "c74e…91b2",
    memberKey: "m2.fixture.selam",
    recordedAt: "2026-09-24T16:15:00+03:00"
  },
  {
    id: "entry-425",
    type: "contribution",
    amount: "4950.00",
    direction: "inbound",
    status: "PENDING_RECONCILIATION",
    reason: "MANUAL_REVIEW_REQUIRED",
    reference: "TXN-4271",
    sequence: "000425",
    hash: "d03a…4f88",
    memberKey: "m2.fixture.marta",
    recordedAt: "2026-09-24T12:03:00+03:00"
  },
  {
    id: "entry-424",
    type: "contribution",
    amount: "3200.00",
    direction: "inbound",
    status: "REJECTED",
    reason: "AMOUNT_MISMATCH",
    reference: "TXN-4264",
    sequence: "000424",
    hash: "e5b2…c0d4",
    memberKey: "m2.fixture.dawit",
    recordedAt: "2026-09-23T10:18:00+03:00"
  }
];

const bankStateMessageKeys: Record<BankVerificationState, MessageKey> = {
  PENDING_RECONCILIATION: "m2.status.pendingReconciliation",
  VERIFIED: "m2.status.verified",
  REJECTED: "m2.status.rejected"
};

const reasonMessageKeys: Record<BankVerificationReasonCode, MessageKey> = {
  AWAITING_PROVIDER_EVIDENCE: "m2.reason.awaitingProviderEvidence",
  PROVIDER_TIMEOUT: "m2.reason.providerTimeout",
  PROVIDER_RATE_LIMITED: "m2.reason.providerRateLimited",
  PROVIDER_UNAVAILABLE: "m2.reason.providerUnavailable",
  PROVIDER_NOT_FOUND: "m2.reason.providerNotFound",
  PROVIDER_UNSETTLED: "m2.reason.providerUnsettled",
  PROVIDER_RESPONSE_INVALID: "m2.reason.providerResponseInvalid",
  EVIDENCE_INCOMPLETE: "m2.reason.evidenceIncomplete",
  AMOUNT_MISMATCH: "m2.reason.amountMismatch",
  CURRENCY_MISMATCH: "m2.reason.currencyMismatch",
  DIRECTION_MISMATCH: "m2.reason.directionMismatch",
  SENDER_MISMATCH: "m2.reason.senderMismatch",
  RECEIVER_MISMATCH: "m2.reason.receiverMismatch",
  TIMESTAMP_MISMATCH: "m2.reason.timestampMismatch",
  MANUAL_REVIEW_REQUIRED: "m2.reason.manualReviewRequired",
  VERIFIED: "m2.reason.verified"
};

const reconciliationStateMessageKeys: Record<ReconciliationJobState, MessageKey> = {
  QUEUED: "m2.reconciliation.queued",
  CLAIMED: "m2.reconciliation.claimed",
  RETRY_SCHEDULED: "m2.reconciliation.retryScheduled",
  SUCCEEDED: "m2.reconciliation.succeeded",
  MANUAL_REVIEW: "m2.reconciliation.manualReview"
};

const ledgerErrorMessageKeys: Record<LedgerErrorCode, MessageKey> = {
  INVALID_AMOUNT: "m2.error.invalidAmount",
  INVALID_REQUEST: "m2.error.invalidRequest",
  UNBALANCED: "m2.error.unbalanced",
  INVALID_CORRECTION: "m2.error.invalidCorrection",
  NOT_FOUND: "m2.error.notFound",
  FORBIDDEN: "m2.error.forbidden",
  IDEMPOTENCY_CONFLICT: "m2.error.idempotencyConflict",
  UNAVAILABLE: "m2.error.unavailable",
  STORAGE_FAILURE: "m2.error.storageFailure",
  INTEGRITY_FAILURE: "m2.error.integrityFailure"
};

const bankErrorMessageKeys: Record<BankVerificationErrorCode, MessageKey> = {
  INVALID_REQUEST: "m2.apiError.invalidRequest",
  UNAUTHORIZED: "m2.apiError.unauthorized",
  FORBIDDEN: "m2.apiError.forbidden",
  NOT_FOUND: "m2.apiError.notFound",
  IDEMPOTENCY_CONFLICT: "m2.apiError.idempotencyConflict",
  PROVIDER_NOT_CONFIGURED: "m2.apiError.providerNotConfigured",
  PROVIDER_UNAVAILABLE: "m2.apiError.providerUnavailable",
  STORAGE_FAILURE: "m2.apiError.storageFailure",
  STORAGE_UNAVAILABLE: "m2.apiError.storageUnavailable",
  INTEGRITY_FAILURE: "m2.apiError.integrityFailure",
  INVALID_PROVIDER_RESULT: "m2.apiError.invalidProviderResult",
  INVALID_BINDING: "m2.apiError.invalidBinding"
};

const submitErrorMessageKeys: Record<SubmitError, MessageKey> = {
  unbuildable: "m2.correction.live.submitError.unbuildable",
  invalid: "m2.correction.live.submitError.invalid",
  unauthorized: "m2.correction.live.submitError.unauthorized",
  forbidden: "m2.correction.live.submitError.forbidden",
  conflict: "m2.correction.live.submitError.conflict",
  "rate-limited": "m2.correction.live.submitError.rateLimited",
  error: "m2.correction.live.submitError.error"
};

const liveStatusMessageKeys: Record<Exclude<LiveLedgerResult["status"], "ready">, MessageKey> = {
  empty: "m2.correction.live.empty",
  unauthorized: "m2.correction.live.unauthorized",
  "no-group": "m2.correction.live.noGroup",
  "multiple-groups": "m2.correction.live.multipleGroups",
  error: "m2.correction.live.error"
};

const entryTypeMessageKeys: Record<LedgerEntryType, MessageKey> = {
  journal: "m2.entryType.journal",
  contribution: "m2.entryType.contribution",
  disbursement: "m2.entryType.disbursement",
  adjustment: "m2.entryType.adjustment",
  correction: "m2.entryType.correction"
};

const statusToneClasses: Record<StatusTone, string> = {
  verified: "border-[#B7DFC1] bg-[#EFFAF1] text-[#166534]",
  pending: "border-[#E7C978] bg-[#FFF8DF] text-[#7A5200]",
  danger: "border-[#E7B4A5] bg-[#FFF2ED] text-[#9A3412]",
  warning: "border-[#E7C978] bg-[#FFF8DF] text-[#7A5200]",
  neutral: "border-coffee-900/15 bg-parchment-200/70 text-coffee-700",
  info: "border-[#B9CBD8] bg-[#F0F6FA] text-[#2B526B]"
};

const statusIconByState: Record<BankVerificationState, LucideIcon> = {
  VERIFIED: CircleCheck,
  PENDING_RECONCILIATION: Clock3,
  REJECTED: CircleX
};

function StatusPill({ label, tone, icon: Icon }: { label: string; tone: StatusTone; icon: LucideIcon }) {
  return (
    <span className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${statusToneClasses[tone]}`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      <span>{label}</span>
    </span>
  );
}

function formatAmount(amount: string, locale: Locale, t: Translator, signed = false) {
  const value = Number(amount);
  const formatted = new Intl.NumberFormat(locale === "am" ? "am-ET" : "en-ET", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
  const sign = signed && value > 0 ? "−" : "";
  return `${sign}${formatted} ${t("m2.currency.etb")}`;
}

function formatDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "am" ? "am-ET" : "en-ET", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Addis_Ababa"
  }).format(new Date(value));
}

function statusLabel(entry: DashboardEntry, t: Translator) {
  if (entry.isCorrection) {
    return t("m2.correction.newEntryStatus");
  }
  if (entry.reason === "MANUAL_REVIEW_REQUIRED") {
    return t("m2.status.manualReview");
  }
  return t(bankStateMessageKeys[entry.status]);
}

function statusTone(entry: DashboardEntry): StatusTone {
  if (entry.isCorrection) {
    return "pending";
  }
  if (entry.reason === "MANUAL_REVIEW_REQUIRED") {
    return "warning";
  }
  if (entry.status === "VERIFIED") {
    return "verified";
  }
  if (entry.status === "REJECTED") {
    return "danger";
  }
  return "pending";
}

function statusIcon(entry: DashboardEntry): LucideIcon {
  if (entry.isCorrection) {
    return CircleDashed;
  }
  return statusIconByState[entry.status];
}

function reasonLabel(entry: DashboardEntry, t: Translator) {
  if (entry.isCorrection) {
    return t("m2.reason.demoCorrection");
  }
  return t(reasonMessageKeys[entry.reason]);
}

export interface M2DashboardProps {
  readonly locale?: Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export function M2Dashboard({ locale = "en", onLocaleChange }: M2DashboardProps) {
  const t = createTranslator(locale);
  const [entries, setEntries] = useState<DashboardEntry[]>(initialEntries);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState(initialEntries[0].id);
  const [rationale, setRationale] = useState("");
  const [correctionError, setCorrectionError] = useState<CorrectionError | null>(null);
  const [correctionReference, setCorrectionReference] = useState<string | null>(null);
  const [correctionCount, setCorrectionCount] = useState(0);
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const [live, setLive] = useState<LiveLedgerResult | "loading">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [liveSuccess, setLiveSuccess] = useState<LiveCorrectionSuccess | null>(null);
  // One idempotency key per distinct (original, rationale) attempt. A retry or a
  // double-click of the same attempt reuses the key and the timestamp, so the
  // server sees the identical request and can only ever post it once.
  const attempt = useRef<{ fingerprint: string; key: string; now: Date } | null>(null);
  const inFlight = useRef(false);

  // Signed in, the form's choices come from the live ledger; otherwise the
  // fixture, exactly as before there was a sign-in surface.
  useEffect(() => {
    if (!signedIn || !correctionOpen) {
      return;
    }
    let active = true;
    setLive("loading");
    setSelectedEntryId("");
    void loadCorrectionTargets().then((result) => {
      if (active) {
        setLive(result);
      }
    });
    return () => {
      active = false;
    };
  }, [signedIn, correctionOpen]);

  const liveTargets: readonly LiveCorrectionTarget[] = live !== "loading" && live.status === "ready" ? live.targets : [];
  const correctionTargets: readonly CorrectionTarget[] = signedIn
    ? liveTargets
    : entries.filter((entry) => entry.type !== "correction");
  const selectedEntry = correctionTargets.find((entry) => entry.id === selectedEntryId);
  const unresolvedEntries = entries.filter((entry) => entry.status !== "VERIFIED" && !entry.isCorrection);
  const pendingAmount = formatAmount(PENDING_AMOUNT, locale, t);
  const reviewAmount = formatAmount(REVIEW_AMOUNT, locale, t);
  const trustedAmount = formatAmount(TRUSTED_BALANCE, locale, t);

  function openCorrection() {
    setCorrectionOpen(true);
    setCorrectionError(null);
  }

  function closeCorrection() {
    setCorrectionOpen(false);
    setCorrectionError(null);
    setSubmitError(null);
    setLiveSuccess(null);
    setCorrectionReference(null);
    setRationale("");
  }

  async function submitLiveCorrection(target: LiveCorrectionTarget, normalizedRationale: string) {
    if (inFlight.current) {
      return;
    }
    const fingerprint = `${target.id}\n${normalizedRationale}`;
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newCorrectionIdempotencyKey(), now: new Date() };
    }
    let request;
    try {
      request = buildCorrectionRequest({
        original: { ...target, entryType: target.type },
        rationale: normalizedRationale,
        idempotencyKey: attempt.current.key,
        now: attempt.current.now
      });
    } catch (error) {
      if (!(error instanceof CorrectionBuildError)) {
        throw error;
      }
      setSubmitError("unbuildable");
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setLiveSuccess(null);
    const result = await postCorrection(request);
    inFlight.current = false;
    setSubmitting(false);

    if (result.status === "created") {
      attempt.current = null;
      setLiveSuccess({
        originalReference: target.reference,
        amount: target.amount,
        sequence: result.sequence,
        replayed: result.replayed
      });
      setRationale("");
      setSelectedEntryId("");
      void loadCorrectionTargets().then(setLive);
      return;
    }
    setSubmitError(result.status);
    if (result.status === "invalid" || result.status === "conflict") {
      // A definite answer about this exact attempt: retire its key and show
      // the ledger as it is now, since the original may already be corrected.
      attempt.current = null;
      setSelectedEntryId("");
      void loadCorrectionTargets().then(setLive);
    }
  }

  function handleCorrectionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEntry) {
      setCorrectionError("target");
      return;
    }
    const normalizedRationale = rationale.trim();
    if (!normalizedRationale) {
      setCorrectionError("required");
      return;
    }
    if (normalizedRationale.length < 10) {
      setCorrectionError("length");
      return;
    }

    if (signedIn) {
      void submitLiveCorrection(selectedEntry as LiveCorrectionTarget, normalizedRationale);
      return;
    }

    const nextCount = correctionCount + 1;
    const nextReference = `DEMO-COMP-${String(nextCount).padStart(3, "0")}`;
    const nextSequence = String(428 + nextCount).padStart(6, "0");
    const compensatingEntry: DashboardEntry = {
      id: `demo-compensation-${nextCount}`,
      type: "correction",
      amount: selectedEntry.amount,
      direction: selectedEntry.direction === "inbound" ? "outbound" : "inbound",
      status: "PENDING_RECONCILIATION",
      reason: "AWAITING_PROVIDER_EVIDENCE",
      reference: nextReference,
      sequence: nextSequence,
      hash: "demo…new0",
      memberKey: "m2.fixture.compensation",
      recordedAt: DEMO_CORRECTION_DATE,
      isCorrection: true,
      correctsReference: selectedEntry.reference
    };

    setEntries((currentEntries) => [compensatingEntry, ...currentEntries]);
    setCorrectionCount(nextCount);
    setCorrectionReference(nextReference);
    setRationale("");
    setCorrectionError(null);
  }

  return (
    <div id="top" className="min-h-screen overflow-x-hidden bg-parchment-100 text-coffee-900">
      <header className="border-b border-coffee-900/10 bg-parchment-50/95">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <a
              href="#top"
              aria-label={t("m2.brand.home")}
              className="inline-flex min-h-11 items-center gap-3 self-start rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
            >
              <span aria-hidden="true" className="relative flex h-10 w-10 items-center justify-center rounded-xl border-2 border-terracotta bg-gold/25">
                <span className="h-4 w-4 rotate-45 border-2 border-terracotta" />
                <span className="absolute h-1.5 w-1.5 rotate-45 bg-coffee-900" />
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-lg font-bold tracking-tight text-coffee-900">{t("m2.brand.name")}</span>
                <span className="text-xs font-medium text-inkMuted">{t("m2.brand.context")}</span>
              </span>
            </a>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-gold-500/45 bg-gold/15 px-3 text-xs font-semibold text-coffee-700">
                <CircleDashed aria-hidden="true" className="h-3.5 w-3.5" />
                {t("m2.header.demoLabel")}
              </span>
              <span className="hidden min-h-9 items-center gap-2 px-2 text-xs font-medium text-inkMuted md:inline-flex">
                <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" />
                {t("m2.header.noSession")}
              </span>
              <button
                type="button"
                onClick={() => onLocaleChange?.(locale === "en" ? "am" : "en")}
                aria-label={t("shell.changeLanguage")}
                aria-pressed={locale === "am"}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-coffee-900/15 bg-white/60 px-3 text-sm font-semibold text-coffee-800 transition-colors hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
              >
                <Languages aria-hidden="true" className="h-4 w-4" />
                <span>{locale === "en" ? t("shell.amharic") : t("shell.english")}</span>
              </button>
            </div>
          </div>
          <nav aria-label={t("shell.primaryNavigation")} className="flex flex-wrap gap-x-5 gap-y-1 border-t border-coffee-900/10 py-2 text-sm font-semibold text-inkMuted">
            <a href="#balance" className="inline-flex min-h-11 items-center rounded-lg px-1 transition-colors hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50">
              {t("m2.nav.overview")}
            </a>
            <a href="#integrations" className="inline-flex min-h-11 items-center rounded-lg px-1 transition-colors hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50">
              {t("m2.nav.integrations")}
            </a>
            <a href="#history" className="inline-flex min-h-11 items-center rounded-lg px-1 transition-colors hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50">
              {t("m2.nav.ledger")}
            </a>
            <a href="#correction" className="inline-flex min-h-11 items-center rounded-lg px-1 transition-colors hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50">
              {t("m2.nav.corrections")}
            </a>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section aria-labelledby="m2-hero-heading" className="overflow-hidden bg-coffee-900 text-parchment-50">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:px-8 lg:py-20">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-gold-400/40 bg-gold-400/10 px-3 py-1.5 text-xs font-semibold text-gold-300">
                <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" />
                {t("m2.header.readOnly")}
              </div>
              <h1 id="m2-hero-heading" className="mt-6 max-w-2xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
                {t("m2.hero.title")}
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-parchment-200 sm:text-lg">{t("m2.hero.description")}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <a
                  href="#balance"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gold-400 px-4 py-2.5 text-sm font-bold text-coffee-950 transition-colors hover:bg-gold-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-300 focus-visible:ring-offset-2 focus-visible:ring-offset-coffee-900"
                >
                  {t("m2.hero.viewBalance")}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={openCorrection}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-parchment-300/35 px-4 py-2.5 text-sm font-bold text-parchment-100 transition-colors hover:border-gold-300 hover:text-gold-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-300 focus-visible:ring-offset-2 focus-visible:ring-offset-coffee-900"
                >
                  {t("m2.hero.startCorrection")}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-parchment-300">{t("m2.hero.demoNotice")}</p>
            </div>
            <div aria-hidden="true" className="relative hidden min-h-64 items-center justify-center lg:flex">
              <div className="absolute inset-0 opacity-40">
                <TibebHeaderPattern className="h-20 w-full" />
              </div>
              <div className="relative flex h-52 w-52 rotate-3 items-center justify-center border border-gold-400/45 bg-coffee-950/60 shadow-2xl">
                <div className="flex h-32 w-32 rotate-45 items-center justify-center border-2 border-gold-400/70">
                  <ShieldCheck className="h-16 w-16 -rotate-45 text-gold-300" strokeWidth={1.25} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <section id="balance" aria-labelledby="balance-heading" className="scroll-mt-8 py-12 sm:py-16">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-2xl">
                <h2 id="balance-heading" className="text-3xl font-bold tracking-tight text-coffee-950 sm:text-4xl">{t("m2.balance.title")}</h2>
                <p className="mt-3 text-base leading-7 text-inkMuted">{t("m2.balance.description")}</p>
              </div>
              <StatusPill label={t("m2.status.readOnly")} tone="neutral" icon={LockKeyhole} />
            </div>

            <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-coffee-900/15 bg-coffee-900/15 shadow-card lg:grid-cols-2">
              <div data-testid="trusted-balance" className="bg-parchment-50 p-6 sm:p-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <p className="text-sm font-semibold text-inkMuted">{t("m2.balance.trustedLabel")}</p>
                  <StatusPill label={t("m2.status.ledgerVerified")} tone="verified" icon={CircleCheck} />
                </div>
                <p data-testid="trusted-balance-amount" className="mt-6 break-words text-4xl font-bold tracking-tight text-coffee-950 sm:text-5xl">{trustedAmount}</p>
                <p className="mt-5 max-w-xl text-sm leading-6 text-inkMuted">{t("m2.balance.verifiedExplanation")}</p>
              </div>
              <div data-testid="pending-excluded" className="bg-parchment-50 p-6 sm:p-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <p className="text-sm font-semibold text-inkMuted">{t("m2.balance.pendingTitle")}</p>
                  <StatusPill label={t("m2.status.pendingReconciliation")} tone="pending" icon={Clock3} />
                </div>
                <p data-testid="pending-balance-amount" className="mt-6 break-words text-4xl font-bold tracking-tight text-coffee-950 sm:text-5xl">{pendingAmount}</p>
                <p className="mt-5 max-w-xl text-sm leading-6 text-inkMuted">{t("m2.balance.pendingDescription")}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <p data-testid="pending-exclusion-note" className="border-l-2 border-gold-500 bg-parchment-50 px-4 py-3 text-sm leading-6 text-coffee-800">
                {t("m2.balance.pendingExcluded", { amount: pendingAmount })}
              </p>
              <p className="border-l-2 border-terracotta bg-parchment-50 px-4 py-3 text-sm leading-6 text-coffee-800">
                <span className="block text-xs font-bold uppercase tracking-[0.12em] text-terracotta-700">{t("m2.balance.reviewTitle")}</span>
                {t("m2.balance.reviewExcluded", { amount: reviewAmount })}
              </p>
            </div>
            <p className="mt-4 text-xs font-medium text-inkMuted">{t("m2.balance.currencyNote")}</p>
          </section>

          <section aria-labelledby="integrity-heading" className="border-y border-coffee-900/10 py-10 sm:py-12">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="integrity-heading" className="text-2xl font-bold tracking-tight text-coffee-950 sm:text-3xl">{t("m2.integrity.title")}</h2>
                <p className="mt-2 text-sm leading-6 text-inkMuted">{t("m2.integrity.description")}</p>
              </div>
              <p className="text-xs font-semibold text-inkMuted">{t("m2.integrity.checkedAt", { date: formatDate(LAST_RECORDED_AT, locale) })}</p>
            </div>
            <dl className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex min-h-24 items-center gap-3 rounded-xl border border-[#B7DFC1] bg-[#EFFAF1] px-4 py-4">
                <ShieldCheck aria-hidden="true" className="h-6 w-6 shrink-0 text-[#166534]" />
                <div className="min-w-0">
                  <dt className="text-xs font-semibold text-[#166534]">{t("m2.integrity.chainLabel")}</dt>
                  <dd className="mt-1"><StatusPill label={t("m2.status.chainIntact")} tone="verified" icon={Check} /></dd>
                </div>
              </div>
              <div className="flex min-h-24 items-center gap-3 rounded-xl border border-coffee-900/15 bg-parchment-50 px-4 py-4">
                <GitBranch aria-hidden="true" className="h-6 w-6 shrink-0 text-terracotta-600" />
                <div>
                  <dt className="text-xs font-semibold text-inkMuted">{t("m2.integrity.historyLabel")}</dt>
                  <dd className="mt-1 text-sm font-bold text-coffee-900">{t("m2.integrity.historyValue")}</dd>
                </div>
              </div>
              <div className="flex min-h-24 items-center gap-3 rounded-xl border border-coffee-900/15 bg-parchment-50 px-4 py-4">
                <ScrollText aria-hidden="true" className="h-6 w-6 shrink-0 text-terracotta-600" />
                <div>
                  <dt className="text-xs font-semibold text-inkMuted">{t("m2.integrity.sequenceLabel")}</dt>
                  <dd className="mt-1 text-sm font-bold text-coffee-900">{t("m2.integrity.sequenceValue", { sequence: "000428" })}</dd>
                </div>
              </div>
              <div className="flex min-h-24 items-center gap-3 rounded-xl border border-coffee-900/15 bg-parchment-50 px-4 py-4">
                <Fingerprint aria-hidden="true" className="h-6 w-6 shrink-0 text-terracotta-600" />
                <div className="min-w-0">
                  <dt className="text-xs font-semibold text-inkMuted">{t("m2.integrity.hashLabel")}</dt>
                  <dd aria-label={t("m2.integrity.hashAccessible")} className="mt-1 truncate text-sm font-bold text-coffee-900">{t("m2.integrity.hashVisible")}</dd>
                </div>
              </div>
            </dl>
            <p className="mt-5 flex items-start gap-2 text-sm leading-6 text-inkMuted">
              <FileLock2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-terracotta-600" />
              {t("m2.integrity.noEdits")}
            </p>
          </section>

          <section id="integrations" aria-labelledby="integrations-heading" className="scroll-mt-8 py-12 sm:py-16">
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
              <article className="rounded-2xl border border-coffee-900/15 bg-parchment-50 p-6 shadow-card sm:p-8">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-coffee-900 text-gold-300">
                      <Landmark aria-hidden="true" className="h-5 w-5" />
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-inkMuted">{t("m2.integration.statusLabel")}</p>
                      <h2 id="integrations-heading" className="mt-1 text-2xl font-bold tracking-tight text-coffee-950">{t("m2.integration.title")}</h2>
                    </div>
                  </div>
                  <StatusPill label={t("m2.integration.unconfigured")} tone="pending" icon={Unplug} />
                </div>
                <p className="mt-6 text-lg font-bold text-coffee-900">{t("m2.integration.linksName")}</p>
                <p className="mt-2 text-sm leading-6 text-inkMuted">{t("m2.integration.unconfiguredDescription")}</p>
                <div className="mt-6 flex items-start gap-3 rounded-xl border border-gold-500/40 bg-gold/10 p-4 text-sm leading-6 text-coffee-800">
                  <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-terracotta-600" />
                  <div>
                    <p className="font-bold">{t("m2.integration.readOnlyTitle")}</p>
                    <p>{t("m2.integration.readOnlyDescription")}</p>
                  </div>
                </div>
                <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-inkMuted">
                  <Link2Off aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  {t("m2.integration.noSecrets")}
                </p>
                <div className="mt-7 border-t border-coffee-900/10 pt-5">
                  <p className="text-sm font-bold text-coffee-900">{t("m2.integration.availableTitle")}</p>
                  <ul className="mt-3 space-y-3 text-sm leading-6 text-inkMuted">
                    <li className="flex gap-2"><Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-[#166534]" />{t("m2.integration.localLedger")}</li>
                    <li className="flex gap-2"><Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-[#166534]" />{t("m2.integration.pendingOutside")}</li>
                    <li className="flex gap-2"><Clock3 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-[#7A5200]" />{t("m2.integration.futureProvider")}</li>
                  </ul>
                </div>
                <p className="mt-5 text-xs leading-5 text-inkMuted">{t("m2.integration.configurationNote")}</p>
              </article>

              <article aria-labelledby="queue-heading" className="rounded-2xl border border-coffee-900/15 bg-parchment-50 p-6 shadow-card sm:p-8">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta-600">
                    <TriangleAlert aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <div>
                    <h2 id="queue-heading" className="text-2xl font-bold tracking-tight text-coffee-950">{t("m2.queue.title")}</h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-inkMuted">{t("m2.queue.description")}</p>
                  </div>
                </div>
                {unresolvedEntries.length === 0 ? (
                  <div className="mt-7 border-t border-coffee-900/10 pt-6">
                    <CircleCheck aria-hidden="true" className="h-7 w-7 text-[#166534]" />
                    <p className="mt-3 font-bold text-coffee-900">{t("m2.queue.emptyTitle")}</p>
                    <p className="mt-1 text-sm leading-6 text-inkMuted">{t("m2.queue.emptyDescription")}</p>
                  </div>
                ) : (
                  <ul className="mt-7 divide-y divide-coffee-900/10 border-y border-coffee-900/10">
                    {unresolvedEntries.map((entry) => {
                      const manual = entry.reason === "MANUAL_REVIEW_REQUIRED";
                      const rejected = entry.status === "REJECTED";
                      return (
                        <li key={entry.id} aria-label={t("m2.queue.referenceLabel", { reference: entry.reference })} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="font-bold text-coffee-900">{manual ? t("m2.queue.reviewTitle") : t("m2.queue.pendingTitle")}</p>
                            <p className="mt-1 text-sm leading-6 text-inkMuted">
                              {rejected
                                ? t("m2.queue.rejectedMeta", { amount: formatAmount(entry.amount, locale, t) })
                                : manual
                                  ? t("m2.queue.reviewMeta", { amount: formatAmount(entry.amount, locale, t) })
                                  : t("m2.queue.pendingMeta", { amount: formatAmount(entry.amount, locale, t) })}
                            </p>
                            <p className="mt-1 text-xs font-semibold text-inkMuted">{reasonLabel(entry, t)}</p>
                          </div>
                          <StatusPill
                            label={manual ? t("m2.queue.manualBadge") : t(bankStateMessageKeys[entry.status])}
                            tone={manual ? "warning" : rejected ? "danger" : "pending"}
                            icon={manual ? CircleAlert : rejected ? CircleX : Clock3}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </article>
            </div>
          </section>

          <section id="history" aria-labelledby="history-heading" className="scroll-mt-8 pb-12 sm:pb-16">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-2xl">
                <h2 id="history-heading" className="text-3xl font-bold tracking-tight text-coffee-950 sm:text-4xl">{t("m2.history.title")}</h2>
                <p className="mt-3 text-base leading-7 text-inkMuted">{t("m2.history.description")}</p>
              </div>
              <StatusPill label={t("m2.history.readOnly")} tone="neutral" icon={History} />
            </div>
            <div className="mt-8 border-y border-coffee-900/15">
              {entries.length === 0 ? (
                <div className="py-10 text-center">
                  <FileText aria-hidden="true" className="mx-auto h-8 w-8 text-terracotta-600" />
                  <p className="mt-3 font-bold text-coffee-900">{t("m2.history.noEntriesTitle")}</p>
                  <p className="mt-1 text-sm leading-6 text-inkMuted">{t("m2.history.noEntriesDescription")}</p>
                </div>
              ) : (
                entries.map((entry) => (
                  <article key={entry.id} className="border-b border-coffee-900/10 py-6 last:border-b-0 sm:py-7">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-[0.14em] text-terracotta-600">{t("m2.history.sequence", { sequence: entry.sequence })}</p>
                        <h3 className="mt-2 text-xl font-bold tracking-tight text-coffee-950">{t(entryTypeMessageKeys[entry.type])}</h3>
                        <p className="mt-1 text-sm leading-6 text-inkMuted">{t(entry.memberKey)}</p>
                      </div>
                      <StatusPill label={statusLabel(entry, t)} tone={statusTone(entry)} icon={statusIcon(entry)} />
                    </div>
                    <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt className="text-xs font-semibold text-inkMuted">{t("m2.history.amountLabel")}</dt>
                        <dd className="mt-1 break-words text-sm font-bold text-coffee-900">{formatAmount(entry.amount, locale, t, entry.direction === "outbound")}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold text-inkMuted">{t("m2.history.typeLabel")}</dt>
                        <dd className="mt-1 text-sm font-semibold text-coffee-900">{t(entry.direction === "inbound" ? "m2.history.directionInbound" : "m2.history.directionOutbound")}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold text-inkMuted">{t("m2.history.recordedLabel")}</dt>
                        <dd className="mt-1 text-sm leading-6 text-coffee-900">{t("m2.history.recordedAt", { date: formatDate(entry.recordedAt, locale) })}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs font-semibold text-inkMuted">{t("m2.history.referenceLabel")}</dt>
                        <dd className="mt-1 break-all text-sm font-semibold text-coffee-900">{entry.reference}</dd>
                        <dd className="mt-1 text-xs text-inkMuted">{t("m2.history.hash", { hash: entry.hash })}</dd>
                      </div>
                    </dl>
                    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-semibold text-inkMuted">
                      <span className="inline-flex items-center gap-2">
                        <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 text-terracotta-600" />
                        {reasonLabel(entry, t)}
                      </span>
                      {entry.isCorrection && entry.correctsReference ? (
                        <span className="inline-flex items-center gap-2 text-[#166534]">
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                          {t("m2.history.originalPreserved", { reference: entry.correctsReference })}
                        </span>
                      ) : null}
                      {entry.isCorrection ? <span className="rounded-full bg-parchment-200 px-2 py-1 text-[#7A5200]">{t("m2.history.demoLabel")}</span> : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section id="correction" aria-labelledby="correction-heading" className="scroll-mt-8 border-t border-coffee-900/10 py-12 sm:py-16">
            <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-coffee-900 text-gold-300">
                    <BookOpenCheck aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <h2 id="correction-heading" className="text-3xl font-bold tracking-tight text-coffee-950">{t("m2.correction.title")}</h2>
                </div>
                <p className="mt-5 max-w-xl text-base leading-7 text-inkMuted">{t("m2.correction.description")}</p>
                <div className="mt-6">
                  <StatusPill label={t("m2.correction.readOnly")} tone="neutral" icon={FileLock2} />
                </div>
                <button
                  type="button"
                  onClick={openCorrection}
                  className="mt-7 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-terracotta-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-100"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {t("m2.correction.open")}
                </button>
              </div>

              <div className="rounded-2xl border border-coffee-900/15 bg-parchment-50 p-6 shadow-card sm:p-8">
                <ol className="grid gap-5 sm:grid-cols-3">
                  <li className="flex gap-3">
                    <FileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-terracotta-600" />
                    <div><p className="text-sm font-bold text-coffee-900">{t("m2.correction.stepOne")}</p><p className="mt-1 text-xs leading-5 text-inkMuted">{t("m2.correction.stepOneDescription")}</p></div>
                  </li>
                  <li className="flex gap-3">
                    <CircleAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-terracotta-600" />
                    <div><p className="text-sm font-bold text-coffee-900">{t("m2.correction.stepTwo")}</p><p className="mt-1 text-xs leading-5 text-inkMuted">{t("m2.correction.stepTwoDescription")}</p></div>
                  </li>
                  <li className="flex gap-3">
                    <Plus aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-terracotta-600" />
                    <div><p className="text-sm font-bold text-coffee-900">{t("m2.correction.stepThree")}</p><p className="mt-1 text-xs leading-5 text-inkMuted">{t("m2.correction.stepThreeDescription")}</p></div>
                  </li>
                </ol>

                {correctionOpen ? (
                  <form aria-labelledby="correction-form-title" onSubmit={handleCorrectionSubmit} noValidate className="mt-8 border-t border-coffee-900/10 pt-7">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <h3 id="correction-form-title" className="text-xl font-bold text-coffee-950">{t("m2.correction.formTitle")}</h3>
                      <button
                        type="button"
                        onClick={closeCorrection}
                        aria-label={t("m2.correction.close")}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-coffee-900/15 px-3 text-sm font-semibold text-inkMuted transition-colors hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                        {t("m2.correction.close")}
                      </button>
                    </div>
                    <div className="mt-6">
                      <label htmlFor="correction-entry" className="text-sm font-bold text-coffee-900">{t("m2.correction.entryLabel")}</label>
                      <select
                        id="correction-entry"
                        value={selectedEntryId}
                        onChange={(event) => {
                          setSelectedEntryId(event.target.value);
                          setCorrectionError(null);
                          setSubmitError(null);
                        }}
                        aria-describedby="correction-entry-helper"
                        className="mt-2 block min-h-11 w-full rounded-xl border border-coffee-900/20 bg-white/75 px-3 text-sm text-coffee-900 focus:border-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
                      >
                        <option value="">{t("m2.correction.chooseEntry")}</option>
                        {correctionTargets.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {signedIn
                              ? t("m2.correction.live.entryOption", {
                                  type: t(entryTypeMessageKeys[entry.type]),
                                  sequence: entry.reference.replace("#", ""),
                                  amount: formatAmount(entry.amount, locale, t)
                                })
                              : `${t(entryTypeMessageKeys[entry.type])} · ${entry.reference}`}
                          </option>
                        ))}
                      </select>
                      <p id="correction-entry-helper" className="mt-2 text-xs leading-5 text-inkMuted">{signedIn ? t("m2.correction.live.helper") : t("m2.correction.entryHelper")}</p>
                      {signedIn && live === "loading" ? (
                        <p role="status" className="mt-2 text-xs font-semibold leading-5 text-inkMuted">{t("m2.correction.live.loading")}</p>
                      ) : null}
                      {signedIn && live !== "loading" && live.status !== "ready" ? (
                        <p role={live.status === "empty" ? "status" : "alert"} className="mt-2 flex items-start gap-2 text-xs font-semibold leading-5 text-terracotta-700">
                          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                          {t(liveStatusMessageKeys[live.status])}
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-5">
                      <label htmlFor="correction-rationale" className="text-sm font-bold text-coffee-900">
                        {t("m2.correction.rationaleLabel")} <span aria-hidden="true">*</span><span className="sr-only">({t("m2.a11y.required")})</span>
                      </label>
                      <textarea
                        id="correction-rationale"
                        value={rationale}
                        onChange={(event) => {
                          setRationale(event.target.value);
                          setSubmitError(null);
                          if (correctionError) {
                            setCorrectionError(null);
                          }
                        }}
                        required
                        minLength={10}
                        rows={4}
                        placeholder={t("m2.correction.rationalePlaceholder")}
                        aria-invalid={Boolean(correctionError)}
                        aria-describedby={correctionError ? "correction-rationale-helper correction-rationale-error" : "correction-rationale-helper"}
                        className="mt-2 block w-full resize-y rounded-xl border border-coffee-900/20 bg-white/75 px-3 py-3 text-sm leading-6 text-coffee-900 placeholder:text-inkMuted focus:border-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
                      />
                      <p id="correction-rationale-helper" className="mt-2 text-xs leading-5 text-inkMuted">{t("m2.correction.rationaleHelper")}</p>
                      {correctionError ? (
                        <p id="correction-rationale-error" role="alert" className="mt-2 flex items-start gap-2 text-xs font-semibold leading-5 text-terracotta-700">
                          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                          {correctionError === "required" ? t("m2.correction.requiredError") : correctionError === "length" ? t("m2.correction.lengthError") : t("m2.correction.targetError")}
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                      <button
                        type="submit"
                        disabled={submitting}
                        aria-busy={submitting}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-terracotta-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Plus aria-hidden="true" className="h-4 w-4" />
                        {t("m2.correction.submit")}
                      </button>
                      <button
                        type="button"
                        onClick={closeCorrection}
                        className="inline-flex min-h-11 items-center justify-center rounded-xl border border-coffee-900/15 px-4 py-2.5 text-sm font-semibold text-inkMuted transition-colors hover:border-terracotta hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-50"
                      >
                        {t("m2.correction.cancel")}
                      </button>
                    </div>
                    <p className="mt-4 text-xs leading-5 text-inkMuted">{signedIn ? t("m2.correction.live.notice") : t("m2.correction.demoNotice")}</p>
                    {submitting ? (
                      <p role="status" className="mt-4 text-xs font-semibold leading-5 text-inkMuted">{t("m2.correction.live.submitting")}</p>
                    ) : null}
                    {submitError ? (
                      <p role="alert" className="mt-4 flex items-start gap-2 text-xs font-semibold leading-5 text-terracotta-700">
                        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                        {t(submitErrorMessageKeys[submitError])}
                      </p>
                    ) : null}
                    {liveSuccess ? (
                      <div role="status" className="mt-5 flex items-start gap-3 rounded-xl border border-[#B7DFC1] bg-[#EFFAF1] p-4 text-sm leading-6 text-[#166534]">
                        <BadgeCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
                        <div>
                          <p className="font-bold">{t("m2.correction.live.successTitle")}</p>
                          <p>{liveSuccess.replayed ? t("m2.correction.live.replayed") : t("m2.correction.live.successDescription")}</p>
                          <p className="mt-1 font-semibold">{t("m2.correction.originalPreserved", { reference: liveSuccess.originalReference })}</p>
                          <p>{t("m2.correction.compensatingAmount", { amount: formatAmount(liveSuccess.amount, locale, t) })}</p>
                          <p>{t("m2.correction.live.createdReference", { sequence: liveSuccess.sequence })}</p>
                        </div>
                      </div>
                    ) : null}
                    {correctionReference && selectedEntry ? (
                      <div role="status" className="mt-5 flex items-start gap-3 rounded-xl border border-[#B7DFC1] bg-[#EFFAF1] p-4 text-sm leading-6 text-[#166534]">
                        <BadgeCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
                        <div>
                          <p className="font-bold">{t("m2.correction.successTitle")}</p>
                          <p>{t("m2.correction.successDescription")}</p>
                          <p className="mt-1 font-semibold">{t("m2.correction.originalPreserved", { reference: selectedEntry.reference })}</p>
                          <p>{t("m2.correction.compensatingAmount", { amount: formatAmount(selectedEntry.amount, locale, t) })}</p>
                          <p>{t("m2.correction.createdReference", { reference: correctionReference })}</p>
                        </div>
                      </div>
                    ) : null}
                  </form>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-coffee-900/10 bg-coffee-900 text-parchment-300">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-xs leading-5 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <p>{t("m2.footer.demo")}</p>
          <p>{t("m2.footer.privacy")}</p>
          <p className="font-semibold text-gold-300">{t("m2.footer.tagline")}</p>
        </div>
      </footer>
    </div>
  );
}
