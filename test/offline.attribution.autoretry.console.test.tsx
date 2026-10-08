import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "unconfigured" } as { status: string; accessToken?: string; email?: string | null }
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSenedDatabase, deleteSenedDatabase, resetSenedDatabase, type SenedDatabase } from "@/lib/db";
import { OfflineConsole } from "@/app/offline/offline-console";
import { OFFLINE_COPY } from "@/lib/offline/copy";
import { translate, type MessageKey } from "@/lib/i18n";

const GROUP = "77777777-7777-4777-8777-777777777777";
const POT_CASH = "88888888-8888-4888-8888-888888888881";
const CONTRIBUTION_INCOME = "88888888-8888-4888-8888-888888888882";
const BERHAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY = "99999999-9999-4999-8999-999999999999";
const SIGNED_IN = { status: "signed-in", accessToken: "tok", email: "t@example.com" };

const copy = (key: keyof typeof OFFLINE_COPY, vars: Record<string, string | number> = {}) =>
  translate("en", key as MessageKey, vars);
const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);

let db: SenedDatabase;
let dbName: string;

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

interface Wire {
  report: { outcome: "RECORDED" } | { outcome: "REFUSED"; error: string } | undefined;
  attributionResponse: () => Response;
  pushed: { payload: Record<string, unknown> }[];
  attributionCalls: Record<string, unknown>[];
}

function stubServer(wire: Partial<Wire> = {}) {
  const state: Wire = {
    report: { outcome: "REFUSED", error: "attribution_failed" },
    attributionResponse: () => Response.json({ attribution: { revision: 1 }, replayed: false }, { status: 201 }),
    pushed: [],
    attributionCalls: [],
    ...wire
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/my-groups") {
        return Response.json({
          groups: [
            {
              groupId: GROUP,
              role: "treasurer",
              accounts: [
                { id: POT_CASH, code: "POT_CASH" },
                { id: CONTRIBUTION_INCOME, code: "CONTRIBUTION_INCOME" }
              ]
            }
          ]
        });
      }
      if (url.startsWith("/api/ledger/members")) {
        return Response.json({
          members: [{ userId: BERHAN, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: "berhan@example.test", attire: "none" }]
        });
      }
      if (url.startsWith("/api/draw/cycles")) {
        return Response.json({ cycles: [] });
      }
      if (url === "/api/ledger/attributions") {
        state.attributionCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return state.attributionResponse();
      }
      if (url === "/api/sync") {
        const body = JSON.parse(String(init.body)) as { mutations: { mutationId: string; payload: Record<string, unknown> }[] };
        state.pushed.push(...body.mutations);
        return Response.json({
          results: body.mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            outcome: "ACCEPTED",
            serverEntryId: ENTRY,
            serverEntryHash: "a".repeat(64),
            serverSequence: "1",
            ...(mutation.payload.attribution && state.report ? { attribution: state.report } : {})
          }))
        });
      }
      throw new Error(`unexpected request ${url}`);
    })
  );
  return state;
}

async function findPanel() {
  const heading = await screen.findByRole("heading", { name: copy("offline.drafts.title") });
  return heading.closest("section") as HTMLElement;
}

const field = (panel: HTMLElement, key: keyof typeof OFFLINE_COPY) => within(panel).getByLabelText(copy(key));
const button = (panel: HTMLElement, key: keyof typeof OFFLINE_COPY) => within(panel).getByRole("button", { name: copy(key) });

async function queuePayerDraft(
  user: ReturnType<typeof userEvent.setup>,
  panel: HTMLElement,
  extra: { channel?: string; note?: string } = {}
) {
  await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
  await user.type(field(panel, "offline.drafts.amountLabel"), "500.00");
  await user.selectOptions(field(panel, "offline.drafts.payerLabel"), BERHAN);
  if (extra.channel) await user.selectOptions(field(panel, "offline.drafts.channelLabel"), extra.channel);
  if (extra.note) await user.type(field(panel, "offline.drafts.noteLabel"), extra.note);
  await user.click(button(panel, "offline.drafts.queue"));
}

async function push(user: ReturnType<typeof userEvent.setup>) {
  const pushButton = screen.getByRole("button", { name: copy("offline.sync.push") });
  await waitFor(() => expect(pushButton).toBeEnabled());
  await user.click(pushButton);
}

/** Make the stored payer retry due right now, as if its backoff had passed while the tab was away. */
async function makeDue() {
  const row = (await db.outbox.toArray()).find((candidate) => candidate.serverEntryId !== null && candidate.attributionOutcome !== "RECORDED")!;
  await db.outbox.put({ ...row, attributionNextAttemptAt: 0 });
}

beforeEach(() => {
  hoisted.session = SIGNED_IN;
  dbName = `sened-test-autoretry-console-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
  setOnline(true);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "serviceWorker");
  window.localStorage.clear();
  db.close();
  await resetSenedDatabase();
  await deleteSenedDatabase(dbName);
});

describe("offline console: automatic retry of a payer that did not record", () => {
  it("says it is retrying by itself, with the attempt and the next time, and keeps the manual button", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);

    const auto = await within(panel).findByTestId("draft-attribution-auto");
    expect(auto.textContent).toMatch(/^Retrying automatically \(attempt 2 of 8, next try at /);
    expect(within(panel).queryByTestId("draft-attribution-attention")).toBeNull();
    expect(within(panel).getByRole("button", { name: copy("offline.attribution.retry") })).toBeInTheDocument();
    // The entry is synced; the sync result counted as the first try and the next one is scheduled on the row.
    const row = (await db.outbox.toArray())[0]!;
    expect(row).toMatchObject({ state: "synced", attributionAttempts: 1 });
    expect(row.attributionNextAttemptAt).toBeGreaterThan(Date.now() - 1000);
  });

  it("retries on reconnect (the online event) once it is due, sends only the attribution, and records it", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel, { channel: "cash", note: "Brought by his brother" });
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    expect(server.attributionCalls).toHaveLength(0);

    await makeDue();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toBeInTheDocument();
    expect(server.attributionCalls).toEqual([
      { groupId: GROUP, entryId: ENTRY, memberUserId: BERHAN, channel: "cash", note: "Brought by his brother" }
    ]);
    // The entry went out once and only once.
    expect(server.pushed).toHaveLength(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({ attributionOutcome: "RECORDED", attributionAttempts: 2 });
  });

  it("retries after the console's own drain, and after the service worker's drain message", async () => {
    const server = stubServer();
    const worker = new EventTarget();
    Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    expect(server.attributionCalls).toHaveLength(0);

    // The service worker asks for a drain once the device is back online.
    await makeDue();
    await act(async () => {
      worker.dispatchEvent(new MessageEvent("message", { data: { type: "sened:outbox-drain-requested" } }));
    });
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toBeInTheDocument();
    expect(server.attributionCalls).toHaveLength(1);
    expect(server.pushed).toHaveLength(1);
  });

  it("retries on the console's drain button when the payer is due", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    await makeDue();
    // Something else is waiting, so the drain button is live; the payer is retried after that drain.
    await user.type(field(panel, "offline.drafts.amountLabel"), "10.00");
    await user.click(button(panel, "offline.drafts.queue"));
    await push(user);
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toBeInTheDocument();
    expect(server.attributionCalls).toHaveLength(1);
    expect(server.pushed).toHaveLength(2);
  });

  it("retries by itself when the scheduled time comes, with no click and no event", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    expect(server.attributionCalls).toHaveLength(0);
    // The console's own timer fires (it never schedules sooner than two seconds).
    expect(await within(panel).findByTestId("draft-attribution-recorded", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(server.attributionCalls).toHaveLength(1);
  }, 12000);

  it("does not retry while the device is offline, and picks it up on reconnect", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    await makeDue();
    setOnline(false);
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(within(panel).getByRole("button", { name: copy("offline.attribution.retry") })).toBeDisabled());
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(server.attributionCalls).toHaveLength(0);

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toBeInTheDocument();
  });

  describe("with a payer that is due on this device's local desk", () => {
    const LOCAL_GROUP = "22222222-2222-4222-8222-222222222222";
    const request = {
      groupId: LOCAL_GROUP,
      idempotencyKey: "k-local",
      occurredAt: "2026-09-20T09:00:00.000Z",
      entryType: "contribution",
      postings: [
        { accountId: POT_CASH, direction: "debit", amount: "500.00" },
        { accountId: CONTRIBUTION_INCOME, direction: "credit", amount: "500.00" }
      ]
    };

    async function seedDueRow() {
      await db.outbox.put({
        id: "outbox-local",
        kind: "ledger-draft",
        groupId: LOCAL_GROUP,
        subjectId: "draft-local",
        idempotencyKey: "sened-offline:ledger-draft:local",
        state: "synced",
        attempts: 0,
        payload: { ...request, attribution: { memberUserId: BERHAN } },
        nextAttemptAt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        serverEntryId: ENTRY,
        serverEntryHash: "a".repeat(64),
        serverSequence: "1",
        attributionOutcome: "REFUSED",
        attributionError: "attribution_failed",
        attributionAttempts: 1,
        attributionNextAttemptAt: 0,
        createdAt: "2026-09-20T09:00:00.000Z",
        updatedAt: "2026-09-20T09:00:00.000Z",
        settledAt: "2026-09-20T09:00:00.000Z"
      });
    }

    it("never retries while signed out: no request, and no try is spent", async () => {
      hoisted.session = { status: "signed-out" };
      const server = stubServer();
      await seedDueRow();
      render(<OfflineConsole database={db} />);
      await screen.findByRole("heading", { name: copy("offline.drafts.title") });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await new Promise((resolve) => setTimeout(resolve, 2600));
      expect(server.attributionCalls).toHaveLength(0);
      expect(await db.outbox.get("outbox-local")).toMatchObject({ attributionOutcome: "REFUSED", attributionAttempts: 1, attributionNextAttemptAt: 0 });
    }, 10000);

    it("control: the same due row IS retried once a bearer token is available", async () => {
      hoisted.session = { status: "signed-out" };
      const server = stubServer();
      await seedDueRow();
      render(<OfflineConsole database={db} authorization="Bearer tok" />);
      await screen.findByRole("heading", { name: copy("offline.drafts.title") });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await waitFor(() => expect(server.attributionCalls).toHaveLength(1));
      await waitFor(async () => expect(await db.outbox.get("outbox-local")).toMatchObject({ attributionOutcome: "RECORDED" }));
    });
  });

  it("does not retry a definitive refusal by itself: it says why, that it needs attention, and keeps the button", async () => {
    const server = stubServer({ report: { outcome: "REFUSED", error: "attribution_exists" } });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);

    expect(await within(panel).findByTestId("draft-attribution-refused")).toHaveTextContent(en("shell.feed.attribute.error.exists"));
    expect(within(panel).getByTestId("draft-attribution-attention")).toHaveTextContent(copy("offline.attribution.attention.definitive"));
    expect(within(panel).queryByTestId("draft-attribution-auto")).toBeNull();
    await waitFor(() => expect(within(panel).getByRole("button", { name: copy("offline.attribution.retry") })).toBeEnabled());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.attributionCalls).toHaveLength(0);
    expect((await db.outbox.toArray())[0]).toMatchObject({ attributionOutcome: "REFUSED", attributionError: "attribution_exists" });
  });

  it("tells a person when the automatic tries have run out", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    await push(user);
    await within(panel).findByTestId("draft-attribution-auto");
    const row = (await db.outbox.toArray())[0]!;
    await db.outbox.put({ ...row, attributionAttempts: 8, attributionNextAttemptAt: null });
    cleanup();
    render(<OfflineConsole database={db} />);
    const again = await findPanel();
    expect(await within(again).findByTestId("draft-attribution-attention")).toHaveTextContent(
      copy("offline.attribution.attention.exhausted", { max: 8 })
    );
    expect(within(again).queryByTestId("draft-attribution-auto")).toBeNull();
  });
});

describe("offline console: a draft's payment channel and note", () => {
  it("saves them with the payer, sends them in the payload beside the entry, and shows them as text", async () => {
    const server = stubServer({ report: { outcome: "RECORDED" } });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel, { channel: "telebirr", note: '  <b>from</b> his wife  ' });

    const draft = (await db.drafts.toArray())[0]!;
    expect(draft.attribution).toEqual({ memberUserId: BERHAN, channel: "telebirr", note: "<b>from</b> his wife" });
    const shown = await within(panel).findByTestId("draft-attribution-note");
    expect(shown).toHaveTextContent("Note: <b>from</b> his wife");
    expect(shown.querySelector("b")).toBeNull();
    expect(within(panel).getByTestId("draft-attribution-channel")).toHaveTextContent("How it was paid: Telebirr");

    await push(user);
    await within(panel).findByTestId("draft-attribution-recorded");
    expect(server.pushed[0]!.payload.attribution).toEqual({ memberUserId: BERHAN, channel: "telebirr", note: "<b>from</b> his wife" });
    // The entry itself carries neither.
    expect(JSON.stringify({ ...server.pushed[0]!.payload, attribution: undefined })).not.toMatch(/telebirr|from.*wife|channel|note/);
  });

  it("refuses a channel or note with no payer, and a note with a control character or over 280 characters", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
    await user.type(field(panel, "offline.drafts.amountLabel"), "10.00");

    await user.selectOptions(field(panel, "offline.drafts.channelLabel"), "cash");
    await user.click(button(panel, "offline.drafts.save"));
    expect(await within(panel).findByTestId("offline-draft-form-error")).toHaveTextContent(copy("offline.drafts.channelNeedsPayer"));

    await user.selectOptions(field(panel, "offline.drafts.payerLabel"), BERHAN);
    fireEvent.change(field(panel, "offline.drafts.noteLabel"), { target: { value: "bell\u0007char" } });
    await user.click(button(panel, "offline.drafts.save"));
    expect(await within(panel).findByTestId("offline-draft-form-error")).toHaveTextContent(copy("offline.drafts.noteError"));

    fireEvent.change(field(panel, "offline.drafts.noteLabel"), { target: { value: "n".repeat(281) } });
    await user.click(button(panel, "offline.drafts.save"));
    expect(await within(panel).findByTestId("offline-draft-form-error")).toHaveTextContent(copy("offline.drafts.noteError"));
    expect(await db.drafts.count()).toBe(0);
  });

  it("a draft with no channel and no note is exactly the payer it always was", async () => {
    stubServer({ report: { outcome: "RECORDED" } });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await queuePayerDraft(user, panel);
    expect((await db.drafts.toArray())[0]!.attribution).toEqual({ memberUserId: BERHAN });
    expect(within(panel).queryByTestId("draft-attribution-channel")).toBeNull();
    expect(within(panel).queryByTestId("draft-attribution-note")).toBeNull();
  });
});
