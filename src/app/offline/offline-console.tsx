"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { OfflineSyncEngine } from "@/lib/offline/engine";
import { UnconfiguredSyncTransport } from "@/lib/offline/transport";
import { isContentHashingAvailable } from "@/lib/offline/hash";
import { offlineCopy, type OfflineLocale } from "@/lib/offline/copy";
import {
  isTerminalOfflineSyncState,
  isSyncError,
  type OfflineSyncState,
  type SyncTransport
} from "@/lib/offline/contract";
import { addOnDeviceContribution, listRoster, rosterTotalsOnDevice } from "@/lib/db/roster";
import { deleteSpokenNote, listSpokenNotes, saveSpokenNote } from "@/lib/db/notes";
import { listDraftsWithQueueState, queueDraft, saveDraft } from "@/lib/db/drafts";
import { getLocalChainHead, listMirrorChain } from "@/lib/db/mirror";
import { readDivergence, resolveDivergence } from "@/lib/db/meta";
import { findOutboxBySubject, listOutbox, summarizeQueue } from "@/lib/db/outbox";
import { getSenedDatabase, isOfflineStorageAvailable } from "@/lib/db/database";
import type { SenedDatabase } from "@/lib/db/schema";
import type { LedgerDraftRow, OfflineQueueSummary, OutboxRow, RosterMemberRow, SpokenNoteRow } from "@/lib/db/types";
import type { SyncDivergence } from "@/lib/offline/contract";
import { formatEtbDisplay } from "@/lib/ledger/money";

/**
 * The offline ledger desk.
 *
 * Design rules this component follows, in priority order:
 *
 * 1. **Nothing pending is ever drawn like something committed.** Every row
 *    reads its state from the outbox row, which is the only thing that can
 *    reach `synced`, and that only from a server response.
 * 2. **Empty is a real state, and it says what is missing.** "No notes on this
 *    device yet" is honest; an empty table with no explanation is not.
 * 3. **Fail closed everywhere.** Storage unavailable, no crypto, no sync
 *    service, an unresolved fork — each gets its own message rather than a
 *    generic error.
 * 4. **Both languages.** Strings come from the lane-local table in
 *    `src/lib/offline/copy.ts` (see `docs/requests/agent-4.md` R3).
 */

const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const CASH_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const INCOME_ACCOUNT = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const CHANNELS = ["telebirr", "cbe-birr", "cash", "bank-transfer"] as const;
const ENTRY_TYPES = ["contribution", "disbursement", "journal"] as const;

type Connectivity = "online" | "offline" | "unknown";

interface DeskState {
  readonly roster: readonly RosterMemberRow[];
  readonly totals: { readonly memberCount: number; readonly activeMemberCount: number; readonly contributedEtbOnDevice: string };
  readonly notes: readonly SpokenNoteRow[];
  readonly drafts: readonly { readonly draft: LedgerDraftRow; readonly outbox: OutboxRow | null }[];
  readonly queue: OfflineQueueSummary;
  readonly chainHead: { readonly sequence: string; readonly hash: string } | null;
  readonly chainLength: number;
  readonly divergence: SyncDivergence | null;
  readonly outbox: readonly OutboxRow[];
}

const EMPTY_STATE: DeskState = {
  roster: [],
  totals: { memberCount: 0, activeMemberCount: 0, contributedEtbOnDevice: "0.00" },
  notes: [],
  drafts: [],
  queue: { total: 0, byState: {} as never, oldestPendingAt: null, blockedCount: 0, rejectedCount: 0, quiet: true },
  chainHead: null,
  chainLength: 0,
  divergence: null,
  outbox: []
};

export interface OfflineConsoleProps {
  /** Wave 2 replaces this. Defaults to the fail-closed transport. */
  readonly transport?: SyncTransport;
  /** Wave 2 supplies the session token. Never persisted. */
  readonly authorization?: string;
  readonly initialLocale?: OfflineLocale;
  /** Test seam. Production resolves the device's real IndexedDB. */
  readonly database?: SenedDatabase;
}

function stateLabelKey(state: OfflineSyncState): string {
  switch (state) {
    case "synced":
      return "offline.queue.synced";
    case "queued":
      return "offline.queue.pending";
    case "retry-scheduled":
    case "in-flight":
      return "offline.queue.retrying";
    case "rejected":
      return "offline.queue.rejected";
    case "blocked":
      return "offline.queue.blocked";
    case "local-draft":
    default:
      return "offline.drafts.draftOnly";
  }
}

function stateClassName(state: OfflineSyncState): string {
  switch (state) {
    case "synced":
      return "offline-state-synced";
    case "queued":
    case "retry-scheduled":
    case "in-flight":
      return "offline-state-pending animate-offline-pulse";
    case "rejected":
      return "offline-state-rejected";
    case "blocked":
      return "offline-state-blocked";
    case "local-draft":
    default:
      return "offline-state-draft";
  }
}

function isStateCopyKey(value: string): value is Parameters<typeof offlineCopy>[1] {
  return value.startsWith("offline.");
}

export function OfflineConsole(props: OfflineConsoleProps) {
  const [locale, setLocale] = useState<OfflineLocale>(props.initialLocale ?? "en");
  const [connectivity, setConnectivity] = useState<Connectivity>("unknown");
  const [db, setDb] = useState<SenedDatabase | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [desk, setDesk] = useState<DeskState>(EMPTY_STATE);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const t = useCallback(
    (key: string, variables: Record<string, string | number> = {}) =>
      isStateCopyKey(key) ? offlineCopy(locale, key, variables) : key,
    [locale]
  );

  // The engine is memoised on the resolved database, not on a ref. A ref read
  // during the first render is always `null`, so memoising on it produced an
  // engine that could never push anything.
  const engine = useMemo(() => {
    if (!db) {
      return null;
    }
    return new OfflineSyncEngine({ db, transport: props.transport ?? new UnconfiguredSyncTransport() });
  }, [db, props.transport]);

  const refresh = useCallback(async () => {
    if (!db) {
      return;
    }
    try {
      const [roster, totals, notes, drafts, queue, chainHead, chain, divergence, outbox] = await Promise.all([
        listRoster(db, GROUP_ID),
        rosterTotalsOnDevice(db, GROUP_ID),
        listSpokenNotes(db, GROUP_ID, { limit: 25 }),
        listDraftsWithQueueState(db, GROUP_ID),
        summarizeQueue(db, GROUP_ID),
        getLocalChainHead(db, GROUP_ID),
        listMirrorChain(db, GROUP_ID),
        readDivergence(db, GROUP_ID),
        listOutbox(db, { groupId: GROUP_ID })
      ]);
      setDesk({ roster, totals, notes, drafts, queue, chainHead, chainLength: chain.length, divergence, outbox });
    } catch (thrown) {
      // A database closed underneath us (a fast navigation, a test tearing the
      // device store down) must not surface as an unhandled rejection. Storage
      // failures that a person can act on are reported by `run` instead.
      if (isSyncError(thrown)) {
        return;
      }
    }
  }, [db]);

  useEffect(() => {
    if (!isOfflineStorageAvailable()) {
      setStorageAvailable(false);
      return;
    }
    setDb(props.database ?? getSenedDatabase());
    setStorageAvailable(true);
  }, [props.database]);

  useEffect(() => {
    if (db) {
      void refresh();
    }
  }, [db, refresh]);

  useEffect(() => {
    const update = () => setConnectivity(typeof navigator === "undefined" || !navigator.onLine ? "offline" : "online");
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !db) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "sened:outbox-drain-requested") {
        void drain();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    // `drain` is stable enough for this listener: it re-reads the engine on call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, engine]);

  const run = useCallback(
    async (action: () => Promise<string | null>) => {
      setBusy(true);
      setError(null);
      try {
        const message = await action();
        setStatus(message);
      } catch (thrown) {
        setStatus(null);
        // A refused draft is shown as the ledger's own reason, not a generic
        // failure. The rule that rejected it is the useful part.
        if (isSyncError(thrown)) {
          if (thrown.code === "STORAGE_FULL") {
            setError(t("offline.storage.full"));
          } else if (thrown.code === "INVALID_DRAFT") {
            setError(
              thrown.message.includes("UNBALANCED")
                ? t("offline.drafts.unbalanced")
                : thrown.message.includes("INVALID_AMOUNT")
                  ? t("offline.drafts.invalidAmount")
                  : thrown.message
            );
          } else if (thrown.code === "SYNC_PROTECTED_ROW") {
            setError(t("offline.notes.deleteBlocked"));
          } else {
            setError(thrown.message);
          }
        } else {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        }
      } finally {
        await refresh();
        setBusy(false);
      }
    },
    [refresh, t]
  );

  async function drain(): Promise<void> {
    if (!engine) {
      return;
    }
    await run(async () => {
      if (!props.authorization) {
        return t("offline.sync.needsToken");
      }
      const report = await engine.drain(props.authorization, { groupId: GROUP_ID });
      await refresh();
      // Localised, actionable copy first. A raw transport string is honest but
      // is not something an Ethiopian treasurer can act on in Amharic.
      if (report.notConfigured) {
        return t("offline.sync.notConfigured");
      }
      if (report.skippedReason) {
        return report.skippedReason;
      }
      if (report.attempted === 0) {
        return t("offline.sync.nothingQueued");
      }
      return t("offline.sync.drained", { sent: report.synced, total: report.attempted });
    });
  }

  async function pull(): Promise<void> {
    if (!engine) {
      return;
    }
    await run(async () => {
      if (!props.authorization) {
        return t("offline.sync.needsToken");
      }
      const report = await engine.pull(props.authorization, { groupId: GROUP_ID });
      if (report.notConfigured) {
        return t("offline.sync.notConfigured");
      }
      if (report.divergence) {
        return report.divergence.detail;
      }
      if (report.relation === "server-ahead") {
        const behind = report.stored;
        return behind > 0 ? t("offline.sync.ahead", { count: behind }) : t("offline.sync.identical");
      }
      return t("offline.sync.identical");
    });
  }

  async function recordNote(input: { transcript: string; amount: string; channel: (typeof CHANNELS)[number]; memberId: string }) {
    await run(async () => {
      if (!db) {
        throw new Error(t("offline.storage.unavailable"));
      }
      const note = await saveSpokenNote(db, {
        groupId: GROUP_ID,
        memberId: input.memberId || null,
        transcript: input.transcript,
        transcriptSource: "human-typed",
        amountEtb: input.amount || null,
        channel: input.channel,
        occurredAt: new Date().toISOString()
      });
      if (input.memberId && input.amount) {
        await addOnDeviceContribution(db, input.memberId, input.amount);
      }
      return note.contentHash ? t("offline.notes.saved") : `${t("offline.notes.saved")} ${t("offline.notes.noHash")}`;
    });
  }

  async function deleteNote(noteId: string): Promise<void> {
    await run(async () => {
      if (!db) {
        throw new Error(t("offline.storage.unavailable"));
      }
      // Refused by the store while the note is still in flight — the error
      // mapper turns that into the human sentence for this user.
      const row = await findOutboxBySubject(db, noteId);
      await deleteSpokenNote(db, noteId, { outboxStateOf: () => row?.state });
      return t("offline.notes.delete");
    });
  }

  async function recordDraft(input: {
    amount: string;
    entryType: (typeof ENTRY_TYPES)[number];
    cashAccountId: string;
    incomeAccountId: string;
    occurredAt: string;
    queueNow: boolean;
  }) {
    await run(async () => {
      if (!db) {
        throw new Error(t("offline.storage.unavailable"));
      }
      const draft = await saveDraft(db, {
        updatedBy: ACTOR_ID,
        request: {
          groupId: GROUP_ID,
          idempotencyKey: `offline-${Date.now().toString(36)}`,
          occurredAt: new Date(input.occurredAt).toISOString(),
          entryType: input.entryType,
          postings: [
            { accountId: input.cashAccountId, direction: "debit", amount: input.amount },
            { accountId: input.incomeAccountId, direction: "credit", amount: input.amount }
          ]
        }
      });
      if (input.queueNow) {
        await queueDraft(db, draft.id);
        return t("offline.drafts.queuedSaved");
      }
      return t("offline.drafts.saved");
    });
  }

  if (!storageAvailable) {
    return (
      <main className="min-h-screen bg-offline-surface px-4 py-10 text-parchment-100">
        <div className="mx-auto max-w-xl rounded-2xl border border-offline-rejected/60 bg-offline-raised p-6">
          <h1 className="text-xl font-semibold">{t("offline.title")}</h1>
          <p className="mt-3 text-sm text-offline-quiet">{t("offline.storage.unavailable")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-offline-surface px-4 py-8 text-parchment-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{t("offline.title")}</h1>
            <p className="mt-1 max-w-md text-sm text-offline-quiet">{t("offline.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                connectivity === "online"
                  ? "offline-state-synced"
                  : connectivity === "offline"
                    ? "offline-state-pending"
                    : "offline-state-draft"
              }`}
            >
              <span className="offline-dot" aria-hidden="true" />
              {connectivity === "online"
                ? t("offline.connectivity.online")
                : connectivity === "offline"
                  ? t("offline.connectivity.offline")
                  : t("offline.connectivity.unknown")}
            </span>
            <button
              type="button"
              onClick={() => setLocale(locale === "en" ? "am" : "en")}
              className="rounded-full border border-offline-quiet/40 px-3 py-1 text-xs"
            >
              {locale === "en" ? "አማርኛ" : "English"}
            </button>
          </div>
        </header>

        {desk.divergence ? (
          <section
            className="offline-fork-banner rounded-2xl p-5"
            aria-labelledby="offline-fork-heading"
            data-testid="offline-divergence"
          >
            <h2 id="offline-fork-heading" className="text-base font-semibold text-terracotta-400">
              {t("offline.divergence.title")}
            </h2>
            <p className="mt-2 text-sm text-parchment-200">{t("offline.divergence.explain")}</p>
            {desk.divergence.kind === "local-chain-broken" ? (
              <p className="mt-2 text-sm font-medium text-terracotta-400">
                {t("offline.divergence.localBroken")}
              </p>
            ) : null}
            <p className="mt-2 text-sm text-offline-quiet">
              {t("offline.divergence.forkAt", { prefix: desk.divergence.commonPrefixLength, fork: desk.divergence.forkSequence })}
            </p>
            <p className="mt-2 text-sm text-offline-quiet">{desk.divergence.detail}</p>
            {desk.divergence.resolution ? (
              <p className="mt-3 text-xs text-offline-quiet">
                {t("offline.divergence.resolved", { date: desk.divergence.resolvedAt ?? "" })}
              </p>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!db) {
                        throw new Error(t("offline.storage.unavailable"));
                      }
                      await resolveDivergence(db, GROUP_ID, "escalate-to-review", new Date());
                      return t("offline.divergence.escalate");
                    })
                  }
                  className="rounded-full border border-terracotta-500 px-4 py-1.5 text-xs"
                >
                  {t("offline.divergence.escalate")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!db) {
                        throw new Error(t("offline.storage.unavailable"));
                      }
                      await resolveDivergence(db, GROUP_ID, "accept-server-as-truth", new Date());
                      return t("offline.divergence.acceptServer");
                    })
                  }
                  className="rounded-full border border-offline-quiet/50 px-4 py-1.5 text-xs"
                >
                  {t("offline.divergence.acceptServer")}
                </button>
              </div>
            )}
          </section>
        ) : null}

        <section className="rounded-2xl border border-offline-quiet/25 bg-offline-raised p-5">
          <h2 className="text-base font-semibold">{t("offline.sync.title")}</h2>
          {desk.chainHead ? (
            <>
              <p className="mt-1 text-xs text-offline-quiet">
                {t("offline.mirror.entries", { count: desk.chainLength })} · {t("offline.integrity.sequenceValue", { sequence: desk.chainHead.sequence })}
              </p>
              <p className="offline-hash mt-2 text-offline-quiet">{desk.chainHead.hash}</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-offline-quiet">{t("offline.mirror.empty")}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void pull()}
              className="rounded-full border border-gold-500 px-4 py-1.5 text-xs disabled:opacity-50"
            >
              {t("offline.sync.pull")}
            </button>
            <button
              type="button"
              disabled={busy || desk.queue.byState.queued === 0}
              onClick={() => void drain()}
              className="rounded-full border border-terracotta-500 px-4 py-1.5 text-xs disabled:opacity-50"
            >
              {t("offline.sync.push")}
            </button>
          </div>
          {status ? (
            <p className="mt-3 text-xs text-gold-300" role="status">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 text-xs text-terracotta-400" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <RosterPanel desk={desk} t={t} onRecord={recordNote} />
        <NotesPanel notes={desk.notes} t={t} onDelete={deleteNote} />
        <DraftsPanel desk={desk} t={t} onRecord={recordDraft} />
        <QueuePanel desk={desk} t={t} />
      </div>
    </main>
  );
}

type TFn = (key: string, variables?: Record<string, string | number>) => string;

function Panel({
  title,
  children
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-offline-quiet/25 bg-offline-raised p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function NoteForm({ roster, t, onRecord }: { readonly roster: readonly RosterMemberRow[]; readonly t: TFn; readonly onRecord: (input: { transcript: string; amount: string; channel: (typeof CHANNELS)[number]; memberId: string }) => Promise<void> }) {
  const [transcript, setTranscript] = useState("");
  const [amount, setAmount] = useState("");
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("telebirr");
  const [memberId, setMemberId] = useState("");

  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onRecord({ transcript, amount, channel, memberId });
        setTranscript("");
        setAmount("");
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-offline-quiet">{t("offline.roster.memberCount", { count: roster.length })}</span>
        <select
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
          className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
        >
          <option value="">—</option>
          {roster.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-offline-quiet">{t("offline.notes.transcriptLabel")}</span>
        <textarea
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder={t("offline.notes.transcriptPlaceholder")}
          rows={2}
          className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-offline-quiet">{t("offline.notes.amountLabel")}</span>
          <input
            value={amount}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-offline-quiet">{t("offline.notes.channelLabel")}</span>
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value as (typeof CHANNELS)[number])}
            className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
          >
            {CHANNELS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="submit"
        className="self-start rounded-full border border-gold-500 px-4 py-1.5 text-xs"
      >
        {t("offline.notes.save")}
      </button>
    </form>
  );
}

function RosterPanel({ desk, t, onRecord }: { readonly desk: DeskState; readonly t: TFn; readonly onRecord: (input: { transcript: string; amount: string; channel: (typeof CHANNELS)[number]; memberId: string }) => Promise<void> }) {
  return (
    <Panel title={t("offline.roster.title")}>
      {desk.roster.length === 0 ? (
        <p className="mt-2 text-sm text-offline-quiet">{t("offline.roster.empty")}</p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {desk.roster.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{member.displayName}</span>
                <span className="offline-hash text-offline-quiet">
                  {t("offline.roster.onDeviceTotal", { amount: formatEtbDisplay(member.contributedEtbOnDevice) })}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-offline-quiet">
            {t("offline.roster.onDeviceTotal", {
              amount: formatEtbDisplay(desk.totals.contributedEtbOnDevice)
            })}
          </p>
        </>
      )}
      <NoteForm roster={desk.roster} t={t} onRecord={onRecord} />
    </Panel>
  );
}

function NotesPanel({ notes, t, onDelete }: { readonly notes: readonly SpokenNoteRow[]; readonly t: TFn; readonly onDelete: (noteId: string) => Promise<void> }) {
  return (
    <Panel title={t("offline.notes.title")}>
      {notes.length === 0 ? (
        <p className="mt-2 text-sm text-offline-quiet">{t("offline.notes.empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-xl border border-offline-quiet/20 p-3">
              <p className="text-sm">{note.transcript || "—"}</p>
              <p className="mt-1 text-xs text-offline-quiet">
                {note.transcriptSource === "asr" ? t("offline.notes.source.asr") : t("offline.notes.source.humanTyped")}
                {note.amountEtb ? ` · ${formatEtbDisplay(note.amountEtb)}` : ""}
                {note.channel ? ` · ${note.channel}` : ""}
              </p>
              {note.contentHash ? (
                <p className="offline-hash mt-1 text-offline-quiet">{note.contentHash}</p>
              ) : (
                <p className="mt-1 text-xs text-offline-rejected">{t("offline.notes.noHash")}</p>
              )}
              <button
                type="button"
                onClick={() => void onDelete(note.id)}
                className="mt-2 rounded-full border border-offline-quiet/40 px-3 py-1 text-xs"
              >
                {t("offline.notes.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DraftsPanel({ desk, t, onRecord }: { readonly desk: DeskState; readonly t: TFn; readonly onRecord: (input: { amount: string; entryType: (typeof ENTRY_TYPES)[number]; cashAccountId: string; incomeAccountId: string; occurredAt: string; queueNow: boolean }) => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [entryType, setEntryType] = useState<(typeof ENTRY_TYPES)[number]>("contribution");
  const [cashAccountId, setCashAccountId] = useState(CASH_ACCOUNT);
  const [incomeAccountId, setIncomeAccountId] = useState(INCOME_ACCOUNT);
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));

  return (
    <Panel title={t("offline.drafts.title")}>
      {desk.drafts.length === 0 ? (
        <p className="mt-2 text-sm text-offline-quiet">{t("offline.drafts.empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {desk.drafts.map(({ draft, outbox }) => {
            const state: OfflineSyncState = outbox ? outbox.state : "local-draft";
            return (
              <li key={draft.id} className={`rounded-xl border px-3 py-2 text-sm ${stateClassName(state)}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {draft.request.entryType} ·{" "}
                    {formatEtbDisplay(
                      draft.request.postings.find((posting) => posting.direction === "debit")?.amount ?? "0.00"
                    )}
                  </span>
                  <span className="inline-flex items-center gap-2 text-xs">
                    <span className={`offline-dot ${state === "queued" || state === "retry-scheduled" || state === "in-flight" ? "offline-dot-pending" : ""}`} aria-hidden="true" />
                    {t(stateLabelKey(state))}
                  </span>
                </div>
                {outbox?.lastErrorMessage ? (
                  <p className="mt-1 text-xs opacity-90">{outbox.lastErrorMessage}</p>
                ) : null}
                {outbox?.serverEntryHash ? (
                  <p className="offline-hash mt-1 opacity-80">{outbox.serverEntryHash}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onRecord({ amount, entryType, cashAccountId, incomeAccountId, occurredAt, queueNow: true });
          setAmount("");
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-offline-quiet">{t("offline.drafts.amountLabel")}</span>
            <input
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-offline-quiet">{t("offline.drafts.entryTypeLabel")}</span>
            <select
              value={entryType}
              onChange={(event) => setEntryType(event.target.value as (typeof ENTRY_TYPES)[number])}
              className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
            >
              {ENTRY_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-offline-quiet">{t("offline.drafts.cashAccountLabel")}</span>
            <input
              value={cashAccountId}
              onChange={(event) => setCashAccountId(event.target.value)}
              className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-offline-quiet">{t("offline.drafts.incomeAccountLabel")}</span>
            <input
              value={incomeAccountId}
              onChange={(event) => setIncomeAccountId(event.target.value)}
              className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-offline-quiet">{t("offline.drafts.occurredAtLabel")}</span>
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
            className="rounded-lg border border-offline-quiet/40 bg-offline-surface px-3 py-2 text-sm"
          />
        </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            void onRecord({ amount, entryType, cashAccountId, incomeAccountId, occurredAt, queueNow: false })
          }
          className="rounded-full border border-offline-quiet/50 px-4 py-1.5 text-xs"
        >
          {t("offline.drafts.save")}
        </button>
        <button type="submit" className="rounded-full border border-terracotta-500 px-4 py-1.5 text-xs">
          {t("offline.drafts.queue")}
        </button>
      </div>
      </form>
    </Panel>
  );
}

function QueuePanel({ desk, t }: { readonly desk: DeskState; readonly t: TFn }) {
  return (
    <Panel title={t("offline.queue.title")}>
      {desk.outbox.length === 0 ? (
        <p className="mt-2 text-sm text-offline-quiet">{t("offline.queue.empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {desk.outbox.map((row) => (
            <li key={row.id} className={`rounded-xl border px-3 py-2 text-sm ${stateClassName(row.state)}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="offline-hash">{row.idempotencyKey}</span>
                <span className="inline-flex items-center gap-2 text-xs">
                  <span
                    className={`offline-dot ${
                      row.state === "queued" || row.state === "retry-scheduled" || row.state === "in-flight"
                        ? "offline-dot-pending"
                        : ""
                    }`}
                    aria-hidden="true"
                  />
                  {t(stateLabelKey(row.state))}
                </span>
              </div>
              <p className="mt-1 text-xs opacity-80">
                {row.state === "synced" && row.serverEntryId
                  ? t("offline.queue.syncedBody", { entry: row.serverEntryId })
                  : (row.lastErrorMessage ?? t("offline.a11y.state"))}
              </p>
              {isTerminalOfflineSyncState(row.state) ? (
                <p className="offline-hash mt-1 opacity-70">
                  {row.attempts} {t("offline.queue.retrying").toLowerCase()}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {desk.queue.oldestPendingAt ? (
        <p className="mt-3 text-xs text-offline-quiet">
          {t("offline.queue.oldest", { date: desk.queue.oldestPendingAt })}
        </p>
      ) : null}
    </Panel>
  );
}
