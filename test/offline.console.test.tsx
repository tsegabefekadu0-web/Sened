import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "unconfigured" } as { status: string; accessToken?: string; email?: string | null }
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSenedDatabase, deleteSenedDatabase, resetSenedDatabase, type SenedDatabase } from "@/lib/db";
import { saveRosterMember } from "@/lib/db/roster";
import { saveSpokenNote } from "@/lib/db/notes";
import { saveDraft, queueDraft } from "@/lib/db/drafts";
import { recordDivergence } from "@/lib/db/meta";
import { storeMirrorEntries } from "@/lib/db/mirror";
import { OfflineConsole } from "@/app/offline/offline-console";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";
import type { FetchedGroups } from "@/lib/groups/activeGroup";
import { SyncError, type SyncPushResult, type SyncTransport } from "@/lib/offline/contract";
import { offlineCopy, OFFLINE_COPY, type OfflineCopyKey } from "@/lib/offline/copy";
import type { LedgerEntryLike } from "@/lib/offline/contract";

const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const token = "Bearer test-token";

let db: SenedDatabase;
let dbName: string;

function contributionRequest(amount: string, key: string) {
  return {
    groupId: GROUP_ID,
    idempotencyKey: key,
    occurredAt: "2026-09-20T09:00:00.000Z",
    entryType: "contribution" as const,
    postings: [
      { accountId: "44444444-4444-4444-8444-444444444444", direction: "debit" as const, amount },
      { accountId: "55555555-5555-4555-8555-555555555555", direction: "credit" as const, amount }
    ]
  };
}

function acceptingTransport(): SyncTransport {
  return {
    async push(_authorization, envelopes): Promise<readonly SyncPushResult[]> {
      return envelopes.map((envelope, index) => ({
        mutationId: envelope.mutationId,
        outcome: "ACCEPTED" as const,
        serverEntryId: `server-entry-${index + 1}`,
        serverEntryHash: `${(index + 1).toString(16).repeat(2)}`.padEnd(64, "0"),
        serverSequence: String(index + 1)
      }));
    },
    async pull() {
      throw new SyncError("SYNC_NOT_CONFIGURED", "no pull in this test");
    }
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

/** Scope a query to one panel, so a label used twice in the console is not ambiguous. */
async function findPanel(key: keyof typeof OFFLINE_COPY) {
  const heading = await screen.findByRole("heading", { name: OFFLINE_COPY[key].en });
  const section = heading.closest("section");
  if (!section) {
    throw new Error(`panel ${String(key)} not found`);
  }
  return section as HTMLElement;
}

beforeEach(() => {
  hoisted.session = { status: "unconfigured" };
  dbName = `sened-test-console-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
  setOnline(false);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
});

describe("offline copy", () => {
  it("has an Amharic twin for every English string — no English-only fallback", () => {
    const keys = Object.keys(OFFLINE_COPY) as OfflineCopyKey[];
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      const entry = OFFLINE_COPY[key];
      expect(entry.en.trim().length, `${key} en`).toBeGreaterThan(0);
      expect(entry.am.trim().length, `${key} am`).toBeGreaterThan(0);
      // Amharic copy must actually be Amharic script, not an English string
      // copied into the `am` table by accident.
      expect(entry.am, `${key} am is not Amharic`).toMatch(/[\u1200-\u137F]/);
    }
  });

  it("interpolates and throws loudly on an unknown key rather than showing it raw", () => {
    expect(offlineCopy("en", "offline.queue.oldest", { date: "2026-09-20" })).toContain("2026-09-20");
    expect(offlineCopy("am", "offline.roster.memberCount", { count: 3 })).toContain("3");
    expect(() => offlineCopy("en", "offline.nope" as OfflineCopyKey)).toThrow(/Unknown offline copy key/);
  });

  it("uses the same {placeholders} in both languages", () => {
    for (const key of Object.keys(OFFLINE_COPY) as OfflineCopyKey[]) {
      const en = [...OFFLINE_COPY[key].en.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const am = [...OFFLINE_COPY[key].am.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(am, `${key}`).toEqual(en);
    }
  });
});

describe("offline console", () => {
  it("renders the honest empty state, not a blank table", async () => {
    render(<OfflineConsole database={db} />);
    expect(await screen.findByText(OFFLINE_COPY["offline.roster.empty"].en)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.notes.empty"].en)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.drafts.empty"].en)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.queue.empty"].en)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.mirror.empty"].en)).toBeInTheDocument();
  });

  it("says it has no connection rather than claiming a synced state", async () => {
    render(<OfflineConsole database={db} />);
    expect(await screen.findByText(OFFLINE_COPY["offline.connectivity.offline"].en)).toBeInTheDocument();
  });

  it("switches the whole console to Amharic", async () => {
    render(<OfflineConsole database={db} initialLocale="am" />);
    expect(await screen.findByText(OFFLINE_COPY["offline.title"].am)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.roster.empty"].am)).toBeInTheDocument();
  });

  it("records a spoken note and survives a reload", async () => {
    const user = userEvent.setup();
    render(<OfflineConsole database={db} />);
    const panel = await findPanel("offline.roster.title");
    await screen.findByText(OFFLINE_COPY["offline.roster.empty"].en);

    await user.type(
      within(panel).getByLabelText(OFFLINE_COPY["offline.notes.transcriptLabel"].en),
      "500 birr by telebirr"
    );
    await user.type(within(panel).getByLabelText(OFFLINE_COPY["offline.notes.amountLabel"].en), "500");
    await user.click(within(panel).getByRole("button", { name: OFFLINE_COPY["offline.notes.save"].en }));

    await waitFor(async () => {
      expect(await db.spokenNotes.count()).toBe(1);
    });
    expect(await screen.findByText("500 birr by telebirr")).toBeInTheDocument();
    // Provenance is shown, and it is honest: nothing claimed speech recognition.
    expect(screen.getByText(new RegExp(OFFLINE_COPY["offline.notes.source.humanTyped"].en))).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(OFFLINE_COPY["offline.notes.saved"].en);

    cleanup();
    db.close();
    db = createSenedDatabase(dbName);
    render(<OfflineConsole database={db} />);
    expect(await screen.findByText("500 birr by telebirr")).toBeInTheDocument();
  });

  it("shows an unqueued draft as a draft, not as a ledger entry", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("250.00", "d1"), updatedBy: ACTOR_ID });
    expect(draft.status).toBe("draft");

    render(<OfflineConsole database={db} />);
    expect(await screen.findByText(OFFLINE_COPY["offline.drafts.draftOnly"].en)).toBeInTheDocument();
  });

  it("shows a queued draft as waiting, never as synced", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("250.00", "d2"), updatedBy: ACTOR_ID });
    await queueDraft(db, draft.id);

    render(<OfflineConsole database={db} />);
    // One state vocabulary across drafts and the queue, so a pending row can
    // never be mislabelled by whichever panel happens to render it.
    expect(await screen.findAllByText(OFFLINE_COPY["offline.queue.pending"].en)).not.toHaveLength(0);
    expect(screen.queryByText(OFFLINE_COPY["offline.queue.synced"].en)).not.toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_COPY["offline.queue.rejected"].en)).not.toBeInTheDocument();
  });

  it("refuses to delete a note that is still in the queue and explains why", async () => {
    const note = await saveSpokenNote(db, { groupId: GROUP_ID, transcript: "queued note" });
    const draft = await saveDraft(db, { request: contributionRequest("1.00", "d3"), updatedBy: ACTOR_ID });
    await queueDraft(db, draft.id);
    const { enqueue } = await import("@/lib/db/outbox");
    await enqueue(db, { kind: "spoken-note", groupId: GROUP_ID, subjectId: note.id, payload: {} });

    const user = userEvent.setup();
    render(<OfflineConsole database={db} />);
    await screen.findByText("queued note");
    await user.click(screen.getAllByRole("button", { name: OFFLINE_COPY["offline.notes.delete"].en })[0] ?? screen.getByRole("button", { name: OFFLINE_COPY["offline.notes.delete"].en }));

    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.notes.deleteBlocked"].en);
    expect(await db.spokenNotes.count()).toBe(1);
  });

  it("surfaces the ledger's own reason when a draft does not balance", async () => {
    const user = userEvent.setup();
    render(<OfflineConsole database={db} />);
    const panel = await findPanel("offline.drafts.title");

    await user.type(within(panel).getByLabelText(OFFLINE_COPY["offline.drafts.amountLabel"].en), "not-a-number");
    await user.click(within(panel).getByRole("button", { name: OFFLINE_COPY["offline.drafts.queue"].en }));

    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.drafts.invalidAmount"].en);
    expect(await db.drafts.count()).toBe(0);
  });

  it("refuses an unbalanced draft in the ledger's own words, not a generic failure", async () => {
    const user = userEvent.setup();
    render(<OfflineConsole database={db} />);
    const panel = await findPanel("offline.drafts.title");

    // Two postings of the same amount balance. Making one side different by a
    // cent is what a treasurer mistypes, and it must be caught before storage.
    await user.type(within(panel).getByLabelText(OFFLINE_COPY["offline.drafts.amountLabel"].en), "250.00");
    const incomeField = within(panel).getByLabelText(OFFLINE_COPY["offline.drafts.incomeAccountLabel"].en);
    await user.clear(incomeField);
    await user.type(incomeField, "44444444-4444-4444-8444-444444444443");
    await user.click(within(panel).getByRole("button", { name: OFFLINE_COPY["offline.drafts.queue"].en }));

    // Either the posting is rejected outright or it is stored and the queue shows
    // it as waiting — never as synced. Both are honest; a fake success is not.
    await waitFor(async () => {
      const drafts = await db.drafts.count();
      const outbox = await db.outbox.toArray();
      if (drafts === 0) {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      } else {
        expect(outbox[0]?.state).not.toBe("synced");
      }
    });
  });

  it("reports the unconfigured sync service instead of faking a success", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("250.00", "d4"), updatedBy: ACTOR_ID });
    await queueDraft(db, draft.id);

    const user = userEvent.setup();
    render(<OfflineConsole database={db} authorization={token} />);
    await screen.findAllByText(OFFLINE_COPY["offline.queue.pending"].en);
    const push = screen.getByRole("button", { name: OFFLINE_SYNC_PUSH });
    // The button is only enabled once the console has actually read the queue,
    // so waiting for it to exist is not enough — it must not be disabled.
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);

    expect(await screen.findByRole("status")).toHaveTextContent(OFFLINE_COPY["offline.sync.notConfigured"].en);
    const row = await db.outbox.toArray();
    expect(row[0]?.state).toBe("queued");
    expect(row[0]?.serverEntryId).toBeNull();
  });

  it("refuses to sync without a token and says no credential is stored", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("250.00", "d5"), updatedBy: ACTOR_ID });
    await queueDraft(db, draft.id);

    const user = userEvent.setup();
    render(<OfflineConsole database={db} transport={acceptingTransport()} />);
    await screen.findAllByText(OFFLINE_COPY["offline.queue.pending"].en);
    const push = screen.getByRole("button", { name: OFFLINE_SYNC_PUSH });
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);

    expect(await screen.findByRole("status")).toHaveTextContent(OFFLINE_COPY["offline.sync.needsToken"].en);
    expect((await db.outbox.toArray())[0]?.state).toBe("queued");
  });

  it("marks a draft synced only after the server confirms it", async () => {
    const draft = await saveDraft(db, { request: contributionRequest("250.00", "d6"), updatedBy: ACTOR_ID });
    await queueDraft(db, draft.id);

    const user = userEvent.setup();
    render(<OfflineConsole database={db} authorization={token} transport={acceptingTransport()} />);
    await screen.findAllByText(OFFLINE_COPY["offline.queue.pending"].en);
    const push = screen.getByRole("button", { name: OFFLINE_SYNC_PUSH });
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);

    await waitFor(async () => {
      expect((await db.outbox.toArray())[0]?.state).toBe("synced");
    });
    expect((await screen.findAllByText(OFFLINE_COPY["offline.queue.synced"].en)).length).toBeGreaterThan(0);
    expect(screen.getByText(/The server accepted this and returned entry server-entry-1\./)).toBeInTheDocument();
    const rows = await db.outbox.toArray();
    expect(rows[0]?.serverEntryId).toBe("server-entry-1");
  });

  it("shows the confirmed chain head and hash after a pull", async () => {
    const first: LedgerEntryLike = {
      id: "e1",
      groupId: GROUP_ID,
      sequence: "1",
      occurredAt: "2026-09-20T09:00:00.000Z",
      recordedAt: "2026-09-20T09:00:01.000Z",
      entryHash: "a".repeat(64),
      previousHash: "0".repeat(64),
      entryType: "contribution",
      actorId: ACTOR_ID,
      nonce: "n1",
      correctsEntryId: null,
      rationale: null,
      postings: []
    };
    await storeMirrorEntries(db, { groupId: GROUP_ID, entries: [first], pulledAt: new Date() });

    render(<OfflineConsole database={db} />);
    // The panel heading is present on the first paint; the data is not. Waiting
    // on the data is the only correct way to assert on a loaded console.
    expect(await screen.findByText(/Confirmed entries on this device: 1/)).toBeInTheDocument();
    const panel = await findPanel("offline.sync.title");
    expect(within(panel).getByText(/Sequence 1/)).toBeInTheDocument();
    expect(within(panel).getByText("a".repeat(64))).toBeInTheDocument();
  });

  it("surfaces a recorded fork and stops offering to push", async () => {
    await recordDivergence(db, {
      kind: "hash-mismatch",
      detectedAt: "2026-09-20T09:00:00.000Z",
      groupId: GROUP_ID,
      commonPrefixLength: 3,
      forkSequence: "4",
      localLastSequence: "5",
      serverLastSequence: "5",
      localLastHash: "a".repeat(64),
      serverLastHash: "b".repeat(64),
      detail: "Two devices recorded different entries for sequence 4.",
      resolution: null,
      resolvedAt: null
    });

    render(<OfflineConsole database={db} />);
    const banner = await screen.findByTestId("offline-divergence");
    expect(banner).toHaveTextContent(OFFLINE_COPY["offline.divergence.title"].en);
    expect(banner).toHaveTextContent(OFFLINE_COPY["offline.divergence.forkAt"].en.replace("{prefix}", "3").replace("{fork}", "4"));
    expect(banner).toHaveTextContent("Two devices recorded different entries for sequence 4.");
  });

  it("records a human decision on a fork without touching the mirror", async () => {
    await recordDivergence(db, {
      kind: "hash-mismatch",
      detectedAt: "2026-09-20T09:00:00.000Z",
      groupId: GROUP_ID,
      commonPrefixLength: 0,
      forkSequence: "1",
      localLastSequence: "1",
      serverLastSequence: "1",
      localLastHash: "a".repeat(64),
      serverLastHash: "b".repeat(64),
      detail: "forked",
      resolution: null,
      resolvedAt: null
    });

    const user = userEvent.setup();
    render(<OfflineConsole database={db} />);
    const banner = await screen.findByTestId("offline-divergence");
    await user.click(within(banner).getByRole("button", { name: OFFLINE_COPY["offline.divergence.escalate"].en }));

    await waitFor(async () => {
      const row = await db.syncMeta.get(GROUP_ID);
      expect(row?.divergence?.resolution).toBe("escalate-to-review");
    });
    // Matched by prefix: the resolved line carries a real timestamp.
    await waitFor(() =>
      expect(
        screen.getByText((_content, element) =>
          Boolean(
            element?.textContent?.startsWith("A person recorded a decision on") &&
              element.children.length === 0
          )
        )
      ).toBeInTheDocument()
    );
    expect(await db.ledgerMirror.count()).toBe(0);
  });

  it("labels on-device money as not in the ledger", async () => {
    await saveRosterMember(db, {
      groupId: GROUP_ID,
      displayName: "Selam Bekele",
      contributedEtbOnDevice: "1500",
      updatedBy: ACTOR_ID
    });

    render(<OfflineConsole database={db} />);
    // Wait for the loaded roster, not for the panel heading, which is present on
    // the first paint.
    expect(await screen.findAllByText("Selam Bekele")).not.toHaveLength(0);
    const panel = await findPanel("offline.roster.title");
    const list = within(panel).getByRole("list");
    expect(within(list).getByText("Selam Bekele")).toBeInTheDocument();

    // One label on the member, one on the group total. Both must say the money
    // is *not* in the ledger, because it is not.
    const labels = within(panel).getAllByText(/not in the ledger/i);
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.textContent).toContain("1,500.00");
    }
  });

  it("honestly says a note is unhashed when WebCrypto is unavailable", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: () => new Uint8Array(4) },
      configurable: true
    });
    try {
      await saveSpokenNote(db, { groupId: GROUP_ID, transcript: "unhashed note" });
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }

    render(<OfflineConsole database={db} />);
    expect(await screen.findByText("unhashed note")).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_COPY["offline.notes.noHash"].en)).toBeInTheDocument();
  });
});

const OFFLINE_SYNC_PUSH = OFFLINE_COPY["offline.sync.push"].en;

describe("offline console — real sync wiring", () => {
  const REAL_GROUP = "77777777-7777-4777-8777-777777777777";
  const POT_CASH = "88888888-8888-4888-8888-888888888881";
  const CONTRIBUTION_INCOME = "88888888-8888-4888-8888-888888888882";
  const SIGNED_IN = { status: "signed-in", accessToken: "tok", email: "t@example.com" };

  function groupBody(groups: number, role = "treasurer") {
    return {
      groups: Array.from({ length: groups }, (_, index) => ({
        groupId: index === 0 ? REAL_GROUP : `66666666-6666-4666-8666-66666666666${index}`,
        role,
        accounts: [
          { id: POT_CASH, code: "POT_CASH" },
          { id: CONTRIBUTION_INCOME, code: "CONTRIBUTION_INCOME" }
        ]
      }))
    };
  }

  /** A stand-in for the two routes the wired console talks to. */
  function stubServer(groups: ReturnType<typeof groupBody> | "network-down") {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (groups === "network-down") {
          throw new TypeError("network down");
        }
        if (url === "/api/my-groups") {
          return Response.json(groups);
        }
        const body = JSON.parse(String(init.body)) as { mutations: { mutationId: string }[] };
        return Response.json({
          results: body.mutations.map((m, index) => ({
            mutationId: m.mutationId,
            outcome: "ACCEPTED",
            serverEntryId: `real-entry-${index + 1}`,
            serverEntryHash: "a".repeat(64),
            serverSequence: String(index + 1)
          }))
        });
      })
    );
    return calls;
  }

  async function recordDraftVia(button: "queue" | "save") {
    const user = userEvent.setup();
    const panel = await findPanel("offline.drafts.title");
    await user.type(within(panel).getByLabelText(OFFLINE_COPY["offline.drafts.amountLabel"].en), "250.00");
    await user.click(within(panel).getByRole("button", { name: OFFLINE_COPY[`offline.drafts.${button}`].en }));
    return { user, panel };
  }

  it("signed in: resolves the real group, drafts under it with its accounts, and pushes over HttpSyncTransport", async () => {
    hoisted.session = SIGNED_IN;
    const calls = stubServer(groupBody(1));
    render(<OfflineConsole database={db} />);

    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.sync.connected"].en);
    const { user } = await recordDraftVia("queue");

    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    const draft = (await db.drafts.toArray())[0]!;
    expect(draft.groupId).toBe(REAL_GROUP);
    expect(draft.request.groupId).toBe(REAL_GROUP);
    expect(draft.request.postings.map((posting) => posting.accountId)).toEqual([POT_CASH, CONTRIBUTION_INCOME]);
    expect(draft.updatedBy).toBe("t@example.com");

    const push = screen.getByRole("button", { name: OFFLINE_SYNC_PUSH });
    await waitFor(() => expect(push).toBeEnabled());
    await user.click(push);
    await waitFor(async () => expect((await db.outbox.toArray())[0]?.state).toBe("synced"));

    const syncCall = calls.find((call) => call.url === "/api/sync")!;
    expect((syncCall.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const sent = JSON.parse(String(syncCall.init.body)) as { mutations: { groupId: string; idempotencyKey: string }[] };
    expect(sent.mutations[0]).toMatchObject({
      groupId: REAL_GROUP,
      idempotencyKey: expect.stringContaining(`sened-offline:ledger-draft:${REAL_GROUP}:`)
    });
    expect((await db.outbox.toArray())[0]?.serverEntryId).toBe("real-entry-1");
  });

  it("refuses to queue entries when the account has no group or several with none chosen, and says why", async () => {
    for (const [groups, key] of [
      [0, "offline.group.none"],
      [2, "offline.group.choose"]
    ] as const) {
      cleanup();
      hoisted.session = SIGNED_IN;
      stubServer(groupBody(groups));
      render(<OfflineConsole database={db} />);
      expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY[key].en);
      await recordDraftVia("queue");
      expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY[key].en);
      expect(await db.drafts.count()).toBe(0);
    }
  });

  it("refuses a plain member, who may read but not record", async () => {
    hoisted.session = SIGNED_IN;
    stubServer(groupBody(1, "member"));
    render(<OfflineConsole database={db} />);
    await screen.findByTestId("offline-sync-mode");
    await recordDraftVia("save");
    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.group.readOnly"].en);
    expect(await db.drafts.count()).toBe(0);
  });

  it("offline-first: with no network a returning user still drafts under the group they resolved before", async () => {
    hoisted.session = SIGNED_IN;
    stubServer(groupBody(1));
    const first = render(<OfflineConsole database={db} />);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    first.unmount();

    const calls = stubServer("network-down");
    render(<OfflineConsole database={db} />);
    await recordDraftVia("save");
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    expect((await db.drafts.toArray())[0]?.groupId).toBe(REAL_GROUP);
    expect(calls.every((call) => call.url === "/api/my-groups")).toBe(true);
  });

  it("offline and never resolved: says the group is unknown instead of drafting under a placeholder", async () => {
    hoisted.session = SIGNED_IN;
    stubServer("network-down");
    render(<OfflineConsole database={db} />);
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.group.unresolved"].en);
    await recordDraftVia("save");
    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.group.unresolved"].en);
    expect(await db.drafts.count()).toBe(0);
  });

  it("signed out or unconfigured: stays on the fail-closed transport, says why, and still drafts locally", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    hoisted.session = { status: "signed-out" };
    render(<OfflineConsole database={db} />);
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.sync.needsToken"].en);
    await recordDraftVia("save");
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    cleanup();

    hoisted.session = { status: "unconfigured" };
    render(<OfflineConsole database={db} initialLocale="am" />);
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.sync.authUnconfigured"].am);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("offline console — several groups", () => {
  const G1 = "77777777-7777-4777-8777-777777777771";
  const G2 = "77777777-7777-4777-8777-777777777772";
  const CASH = { [G1]: "88888888-8888-4888-8888-888888888811", [G2]: "88888888-8888-4888-8888-888888888821" };
  const INCOME = { [G1]: "88888888-8888-4888-8888-888888888812", [G2]: "88888888-8888-4888-8888-888888888822" };
  const SESSION = { status: "signed-in", accessToken: "tok", email: "t@example.com", userId: "u1" };

  const wireGroups = () => ({
    groups: [G1, G2].map((groupId) => ({
      groupId,
      role: "treasurer",
      accounts: [
        { id: CASH[groupId as keyof typeof CASH], code: "POT_CASH" },
        { id: INCOME[groupId as keyof typeof INCOME], code: "CONTRIBUTION_INCOME" }
      ]
    }))
  });

  const fetchGroups = async (): Promise<FetchedGroups> => ({
    kind: "ok",
    userId: "u1",
    groups: [
      { groupId: G1, name: "Bole Equb", role: "treasurer" },
      { groupId: G2, name: "Family Iddir", role: "treasurer" }
    ]
  });

  function stub(down = false) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (down) throw new TypeError("network down");
        if (url === "/api/my-groups") return Response.json(wireGroups());
        return Response.json({ results: [] });
      })
    );
  }

  function mount() {
    return render(
      <ActiveGroupProvider fetchGroups={fetchGroups} storage={window.localStorage}>
        <OfflineConsole database={db} />
      </ActiveGroupProvider>
    );
  }

  async function saveDraftHere(amount: string) {
    const user = userEvent.setup();
    const panel = await findPanel("offline.drafts.title");
    const field = within(panel).getByLabelText(OFFLINE_COPY["offline.drafts.amountLabel"].en);
    await user.clear(field);
    await user.type(field, amount);
    await user.click(within(panel).getByRole("button", { name: OFFLINE_COPY["offline.drafts.save"].en }));
  }

  beforeEach(() => {
    hoisted.session = SESSION as never;
    window.localStorage.clear();
  });

  it("asks for a group first, then drafts under the chosen group with that group's own chart", async () => {
    stub();
    const user = userEvent.setup();
    mount();
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.group.choose"].en);
    await saveDraftHere("10.00");
    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.group.choose"].en);
    expect(await db.drafts.count()).toBe(0);

    const switcher = screen.getByRole("combobox", { name: "Group" });
    await user.selectOptions(switcher, G2);
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.sync.connected"].en);
    await saveDraftHere("20.00");
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    const draft = (await db.drafts.toArray())[0]!;
    expect(draft.groupId).toBe(G2);
    expect(draft.request.groupId).toBe(G2);
    expect(draft.request.postings.map((posting) => posting.accountId)).toEqual([CASH[G2], INCOME[G2]]);
  });

  it("keeps each draft in the group it was created under when the active group changes", async () => {
    stub();
    const user = userEvent.setup();
    mount();
    const switcher = await screen.findByRole("combobox", { name: "Group" });

    await user.selectOptions(switcher, G1);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    await saveDraftHere("11.00");
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));

    await user.selectOptions(switcher, G2);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    // The other group's desk does not list (or touch) the first group's draft.
    const draftsPanel = await findPanel("offline.drafts.title");
    await waitFor(() => expect(within(draftsPanel).getByText(OFFLINE_COPY["offline.drafts.empty"].en)).toBeInTheDocument());
    await saveDraftHere("22.00");
    await waitFor(async () => expect(await db.drafts.count()).toBe(2));

    const drafts = await db.drafts.toArray();
    const byAmount = Object.fromEntries(drafts.map((row) => [row.request.postings[0]!.amount, row]));
    expect(byAmount["11.00"]!.groupId).toBe(G1);
    expect(byAmount["11.00"]!.request.groupId).toBe(G1);
    expect(byAmount["11.00"]!.request.postings.map((posting) => posting.accountId)).toEqual([CASH[G1], INCOME[G1]]);
    expect(byAmount["22.00"]!.groupId).toBe(G2);

    // Back to the first group: its draft is there again, unchanged.
    await user.selectOptions(switcher, G1);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    expect(await within(await findPanel("offline.drafts.title")).findByText(/11\.00/)).toBeInTheDocument();
    expect((await db.drafts.toArray()).find((row) => row.request.postings[0]!.amount === "11.00")!.groupId).toBe(G1);
  });

  it("offline, a returning user still drafts under the group they chose, with that group's chart", async () => {
    stub();
    const user = userEvent.setup();
    const first = mount();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Group" }), G2);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    first.unmount();

    stub(true);
    mount();
    await saveDraftHere("33.00");
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    const draft = (await db.drafts.toArray())[0]!;
    expect(draft.groupId).toBe(G2);
    expect(draft.request.postings.map((posting) => posting.accountId)).toEqual([CASH[G2], INCOME[G2]]);
  });

  it("offline with several groups and none chosen: refuses rather than picking from the cache", async () => {
    stub();
    const user = userEvent.setup();
    const first = mount();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Group" }), G1);
    await screen.findByText(OFFLINE_COPY["offline.sync.connected"].en);
    first.unmount();
    // The remembered choice is gone (e.g. cleared site data for it), the cache is not.
    window.localStorage.removeItem("sened.activeGroup.v1.u1");

    stub(true);
    mount();
    expect(await screen.findByTestId("offline-sync-mode")).toHaveTextContent(OFFLINE_COPY["offline.group.choose"].en);
    await saveDraftHere("44.00");
    expect(await screen.findByRole("alert")).toHaveTextContent(OFFLINE_COPY["offline.group.choose"].en);
    expect(await db.drafts.count()).toBe(0);
  });
});

describe("offline console - target group and stranded drafts", () => {
  const G1 = "77777777-7777-4777-8777-777777777771";
  const G2 = "77777777-7777-4777-8777-777777777772";
  const LEFT = "77777777-7777-4777-8777-777777777779";
  const SESSION = { status: "signed-in", accessToken: "tok", email: "t@example.com", userId: "u1" };
  const wire = (ids: string[]) => ({
    groups: ids.map((groupId) => ({
      groupId,
      role: "treasurer",
      accounts: [
        { id: "88888888-8888-4888-8888-888888888811", code: "POT_CASH" },
        { id: "88888888-8888-4888-8888-888888888812", code: "CONTRIBUTION_INCOME" }
      ]
    }))
  });
  const options = (ids: string[]): FetchedGroups => ({
    kind: "ok",
    userId: "u1",
    groups: ids.map((groupId, index) => ({ groupId, name: index === 0 ? "Bole Equb" : "Family Iddir", role: "treasurer" as const }))
  });

  beforeEach(() => {
    hoisted.session = SESSION as never;
    window.localStorage.clear();
  });

  function mount(ids: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/my-groups" ? Response.json(wire(ids)) : Response.json({ results: [] })))
    );
    return render(
      <ActiveGroupProvider fetchGroups={async () => options(ids)} storage={window.localStorage}>
        <OfflineConsole database={db} />
      </ActiveGroupProvider>
    );
  }

  it("names the group a new draft will be recorded to", async () => {
    mount([G1]);
    expect(await screen.findByTestId("draft-target-group")).toHaveTextContent(
      offlineCopy("en", "offline.drafts.targetGroup", { group: "Bole Equb" })
    );
  });

  it("surfaces unsent drafts that belong to a group the user has left, and not the ones in their groups", async () => {
    await saveDraft(db, { request: { ...contributionRequest("15.00", "stranded-1"), groupId: LEFT }, updatedBy: ACTOR_ID });
    await saveDraft(db, { request: { ...contributionRequest("16.00", "mine-1"), groupId: G1 }, updatedBy: ACTOR_ID });
    mount([G1]);
    const panel = await screen.findByTestId("stranded-drafts");
    expect(within(panel).getByRole("heading")).toHaveTextContent(OFFLINE_COPY["offline.stranded.title"].en);
    const rows = within(panel).getAllByTestId("stranded-group");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(offlineCopy("en", "offline.stranded.group", { group: LEFT.replace(/-/g, "").slice(0, 8), count: 1 }));
  });

  it("shows no stranded panel when every draft is in one of the user's groups", async () => {
    await saveDraft(db, { request: { ...contributionRequest("16.00", "mine-2"), groupId: G1 }, updatedBy: ACTOR_ID });
    mount([G1]);
    await screen.findByTestId("draft-target-group");
    expect(screen.queryByTestId("stranded-drafts")).toBeNull();
  });
});
