"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSession } from "@/lib/auth/useSession";
import { getSenedDatabase, isOfflineStorageAvailable } from "@/lib/db/database";
import { listDraftsWithQueueState } from "@/lib/db/drafts";
import { listSpokenNotes } from "@/lib/db/notes";
import { listOutbox, summarizeQueue } from "@/lib/db/outbox";
import type { SenedDatabase } from "@/lib/db/schema";
import type { LedgerDraftRow, OfflineQueueSummary, OutboxRow, SpokenNoteRow } from "@/lib/db/types";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { formatEtbDisplay } from "@/lib/ledger/money";
import { retryDueAttributions } from "./attributionRetry";
import { ATTRIBUTION_MAX_AUTO_ATTEMPTS, attributionRetryView } from "./attributionPolicy";
import { isSyncError, type OfflineSyncState } from "./contract";
import { OfflineSyncEngine } from "./engine";
import { HttpSyncTransport, UnconfiguredSyncTransport } from "./transport";
import { LOCAL_GROUP_ID } from "@/lib/voice/recordLocal";

export type QueueStatus = "saved" | "waiting" | "retry" | "sent" | "problem";

export interface QueueItem {
  readonly id: string;
  readonly kind: "note" | "entry";
  readonly text: string;
  readonly amount: string | null;
  readonly status: QueueStatus;
}

export type QueueMessage =
  | "needsToken"
  | "groupNone"
  | "groupChoose"
  | "groupReadOnly"
  | "notConfigured"
  | "nothingQueued"
  | "storageFull"
  | "failed"
  | { readonly drained: { readonly sent: number; readonly total: number } };

const MIN_AUTO_RETRY_DELAY_MS = 2_000;

function stateFor(state: OfflineSyncState | undefined): QueueStatus {
  switch (state) {
    case "synced":
      return "sent";
    case "queued":
      return "waiting";
    case "retry-scheduled":
    case "in-flight":
      return "retry";
    case "rejected":
    case "blocked":
      return "problem";
    default:
      return "saved";
  }
}

interface Desk {
  readonly notes: readonly SpokenNoteRow[];
  readonly drafts: readonly { readonly draft: LedgerDraftRow; readonly outbox: OutboxRow | null }[];
  readonly queue: OfflineQueueSummary | null;
  readonly outbox: readonly OutboxRow[];
}

/**
 * The device's offline queue as the "Saved while offline" screen needs it
 * (extracted from the old offline console, behaviour unchanged): spoken notes and
 * ledger drafts saved in IndexedDB, each with its sync state in plain words; one
 * action to send what is waiting; automatic retry of payers that did not record.
 */
export function useOfflineQueue() {
  const session = useSession();
  const group = useActiveGroup();
  const [db, setDb] = useState<SenedDatabase | null>(null);
  const [storage, setStorage] = useState(true);
  const [desk, setDesk] = useState<Desk>({ notes: [], drafts: [], queue: null, outbox: [] });
  const [online, setOnline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<QueueMessage | null>(null);
  const signedIn = session.status === "signed-in";
  const token = session.status === "signed-in" ? session.accessToken : null;
  const groupReady = !group.provided || group.status !== "loading";
  const groupId = signedIn ? (group.activeGroupId ?? LOCAL_GROUP_ID) : LOCAL_GROUP_ID;
  const active = group.active;

  const block: QueueMessage | null = !signedIn
    ? null
    : !groupReady
      ? null
      : group.status === "no-group"
        ? "groupNone"
        : group.needsChoice
          ? "groupChoose"
          : active?.role === "member"
            ? "groupReadOnly"
            : null;

  useEffect(() => {
    if (!isOfflineStorageAvailable()) {
      setStorage(false);
      return;
    }
    setDb(getSenedDatabase());
  }, []);

  useEffect(() => {
    const update = () => setOnline(typeof navigator === "undefined" ? null : navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const engine = useMemo(
    () => (db ? new OfflineSyncEngine({ db, transport: signedIn ? new HttpSyncTransport() : new UnconfiguredSyncTransport() }) : null),
    [db, signedIn]
  );

  const refresh = useCallback(async () => {
    if (!db) return;
    try {
      const [notes, drafts, queue, outbox] = await Promise.all([
        listSpokenNotes(db, groupId, { limit: 25 }),
        listDraftsWithQueueState(db, groupId),
        summarizeQueue(db, groupId),
        listOutbox(db, { groupId })
      ]);
      setDesk({ notes, drafts, queue, outbox });
    } catch {
      // A database closed underneath us (fast navigation) is not worth reporting.
    }
  }, [db, groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const authBlocked = useRef(false);
  useEffect(() => {
    authBlocked.current = false;
  }, [token]);

  const autoRetry = useCallback(
    async (isOnline?: boolean) => {
      if (!db || !token || authBlocked.current) return;
      const report = await retryDueAttributions(db, {
        signedIn: true,
        ...(isOnline === undefined ? {} : { online: isOnline }),
        deps: { getToken: async () => token },
        groupId
      });
      if (report.status !== "done") return;
      if (report.stoppedSignedOut) authBlocked.current = true;
      if (report.attempted > 0 || report.stoppedSignedOut) await refresh();
    },
    [db, token, groupId, refresh]
  );
  const autoRetryRef = useRef(autoRetry);
  useEffect(() => {
    autoRetryRef.current = autoRetry;
  }, [autoRetry]);

  useEffect(() => {
    const onOnline = () => void autoRetryRef.current(true);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  useEffect(() => {
    if (!db || !token || online === false || authBlocked.current) return;
    let earliest: number | null = null;
    for (const row of desk.outbox) {
      const view = attributionRetryView(row, ATTRIBUTION_MAX_AUTO_ATTEMPTS);
      if (view.kind === "auto") earliest = earliest === null ? (view.nextAt ?? 0) : Math.min(earliest, view.nextAt ?? 0);
    }
    if (earliest === null) return;
    const timer = setTimeout(() => void autoRetryRef.current(), Math.max(MIN_AUTO_RETRY_DELAY_MS, earliest - Date.now()));
    return () => clearTimeout(timer);
  }, [db, token, online, desk.outbox]);

  const drain = useCallback(async () => {
    if (!engine) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!token) {
        setMessage("needsToken");
        return;
      }
      if (block) {
        setMessage(block);
        return;
      }
      const report = await engine.drain(`Bearer ${token}`, { groupId });
      await autoRetry();
      await refresh();
      if (report.notConfigured) setMessage("notConfigured");
      else if (report.attempted === 0) setMessage("nothingQueued");
      else setMessage({ drained: { sent: report.synced, total: report.attempted } });
    } catch (thrown) {
      setMessage(isSyncError(thrown) && thrown.code === "STORAGE_FULL" ? "storageFull" : "failed");
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [engine, token, block, groupId, autoRetry, refresh]);

  // The service worker asks the page to drain when the connection returns.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !db) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "sened:outbox-drain-requested") void drain();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [db, drain]);

  const outboxState = new Map(desk.outbox.map((row) => [row.id, row.state]));
  const money = (amount: string) => formatEtbDisplay(amount).replace(/^Br\s*/, "");
  const items: QueueItem[] = [
    ...desk.notes.map((note) => ({
      id: `note-${note.id}`,
      kind: "note" as const,
      text: note.transcript,
      amount: note.amountEtb ? money(note.amountEtb) : null,
      status: stateFor(note.outboxId ? outboxState.get(note.outboxId) : undefined)
    })),
    ...desk.drafts.map(({ draft, outbox }) => ({
      id: `draft-${draft.id}`,
      kind: "entry" as const,
      text: "",
      amount: money(draft.request.postings.find((p) => p.direction === "debit")?.amount ?? "0.00"),
      status: stateFor(outbox?.state)
    }))
  ];
  const waiting = (desk.queue?.byState.queued ?? 0) + (desk.queue?.byState["retry-scheduled"] ?? 0);

  return { items, online, busy, canSend: waiting > 0, drain, message, storage, signedIn, loading: session.status === "loading" };
}
