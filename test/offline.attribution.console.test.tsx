import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "unconfigured" } as { status: string; accessToken?: string; email?: string | null }
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSenedDatabase, deleteSenedDatabase, resetSenedDatabase, type SenedDatabase } from "@/lib/db";
import { OfflineConsole } from "@/app/offline/offline-console";
import { OFFLINE_COPY } from "@/lib/offline/copy";
import { translate, type MessageKey } from "@/lib/i18n";

const GROUP = "77777777-7777-4777-8777-777777777777";
const POT_CASH = "88888888-8888-4888-8888-888888888881";
const CONTRIBUTION_INCOME = "88888888-8888-4888-8888-888888888882";
const BERHAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELAM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CYCLE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
  pushResult: (mutation: { mutationId: string; payload: Record<string, unknown> }) => Record<string, unknown>;
  attributionResponse: () => Response;
  pushed: { payload: Record<string, unknown> }[];
  retried: Record<string, unknown>[];
  membersDown?: boolean;
}

function stubServer(wire: Partial<Wire> = {}) {
  const state: Wire = {
    pushResult: (mutation) => ({
      mutationId: mutation.mutationId,
      outcome: "ACCEPTED",
      serverEntryId: "99999999-9999-4999-8999-999999999999",
      serverEntryHash: "a".repeat(64),
      serverSequence: "1",
      ...(mutation.payload.attribution ? { attribution: { outcome: "RECORDED" } } : {})
    }),
    attributionResponse: () => Response.json({ attribution: { revision: 1 }, replayed: false }, { status: 201 }),
    pushed: [],
    retried: [],
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
        if (state.membersDown) throw new TypeError("network down");
        return Response.json({
          members: [
            { userId: BERHAN, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: "berhan@example.test", attire: "none" },
            { userId: SELAM, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: null, attire: "none" }
          ]
        });
      }
      if (url.startsWith("/api/draw/cycles")) {
        return Response.json({
          cycles: [
            {
              cycleId: CYCLE,
              groupId: GROUP,
              name: "Meskerem Equb",
              contributionAmount: "500.00",
              potAmount: "5000.00",
              totalRounds: 10,
              reserveRatioBps: 0,
              startedAt: "2026-09-01T00:00:00Z",
              closedAt: null,
              createdAt: "2026-09-01T00:00:00Z",
              roundsRevealed: 0,
              roundsPaid: 0,
              nextRound: 1
            }
          ]
        });
      }
      if (url === "/api/ledger/attributions") {
        state.retried.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return state.attributionResponse();
      }
      if (url === "/api/sync") {
        const body = JSON.parse(String(init.body)) as { mutations: { mutationId: string; payload: Record<string, unknown> }[] };
        state.pushed.push(...body.mutations);
        return Response.json({ results: body.mutations.map((mutation) => state.pushResult(mutation)) });
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

async function draftWithPayer(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, action: "save" | "queue") {
  await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
  await user.type(field(panel, "offline.drafts.amountLabel"), "500.00");
  await user.selectOptions(field(panel, "offline.drafts.payerLabel"), BERHAN);
  await user.selectOptions(field(panel, "offline.drafts.cycleLabel"), CYCLE);
  await user.type(field(panel, "offline.drafts.roundLabel"), "4");
  await user.click(button(panel, `offline.drafts.${action}` as keyof typeof OFFLINE_COPY));
}

async function pushQueue(user: ReturnType<typeof userEvent.setup>) {
  const push = screen.getByRole("button", { name: copy("offline.sync.push") });
  await waitFor(() => expect(push).toBeEnabled());
  await user.click(push);
}

beforeEach(() => {
  hoisted.session = SIGNED_IN;
  dbName = `sened-test-attr-console-${Math.random().toString(36).slice(2, 10)}`;
  db = createSenedDatabase(dbName);
  setOnline(true);
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

describe("offline console: a draft that names who paid", () => {
  it("shows the payer as pending, sends it in the payload, and shows it recorded once the server says so", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();

    await draftWithPayer(user, panel, "queue");
    const pending = await within(panel).findByTestId("draft-attribution");
    expect(pending).toHaveTextContent(copy("offline.attribution.pending", { payer: "berhan@example.test" }));

    const draft = (await db.drafts.toArray())[0]!;
    expect(draft.attribution).toEqual({ memberUserId: BERHAN, cycleId: CYCLE, round: 4 });

    await pushQueue(user);
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toHaveTextContent(
      copy("offline.attribution.recorded", { payer: "berhan@example.test" })
    );
    expect(server.pushed[0].payload.attribution).toEqual({ memberUserId: BERHAN, cycleId: CYCLE, round: 4 });
    expect(server.pushed[0].payload.entryType).toBe("contribution");
    expect(within(panel).queryByRole("button", { name: copy("offline.attribution.retry") })).toBeNull();
    expect((await db.outbox.toArray())[0]).toMatchObject({ state: "synced", attributionOutcome: "RECORDED" });
  });

  it("a refused attribution leaves the entry synced, names the reason, and the treasurer can retry it", async () => {
    const server = stubServer({
      pushResult: (mutation) => ({
        mutationId: mutation.mutationId,
        outcome: "ACCEPTED",
        serverEntryId: "99999999-9999-4999-8999-999999999999",
        serverEntryHash: "a".repeat(64),
        serverSequence: "1",
        attribution: { outcome: "REFUSED", error: "attribution_failed" }
      })
    });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await draftWithPayer(user, panel, "queue");
    await pushQueue(user);

    const refused = await within(panel).findByTestId("draft-attribution-refused");
    expect(refused).toHaveTextContent(
      copy("offline.attribution.refused", { reason: copy("offline.attribution.reason.failed") })
    );
    expect(await db.outbox.toArray()).toMatchObject([{ state: "synced", attributionOutcome: "REFUSED", attributionError: "attribution_failed" }]);
    // The entry is synced, not rejected: the queue says synced.
    expect(within(panel).getByText(copy("offline.queue.synced"))).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: copy("offline.attribution.retry") }));
    expect(await within(panel).findByTestId("draft-attribution-recorded")).toBeInTheDocument();
    expect(server.retried).toEqual([
      { groupId: GROUP, entryId: "99999999-9999-4999-8999-999999999999", memberUserId: BERHAN, cycleId: CYCLE, round: 4 }
    ]);
    // Only the attribution was sent again: the entry was pushed once.
    expect(server.pushed).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(copy("offline.attribution.retryDone"));
    expect((await db.outbox.toArray())[0]).toMatchObject({ attributionOutcome: "RECORDED", attributionError: null });
  });

  it("a retry the database refuses shows its reason and keeps the retry available", async () => {
    stubServer({
      pushResult: (mutation) => ({
        mutationId: mutation.mutationId,
        outcome: "ACCEPTED",
        serverEntryId: "99999999-9999-4999-8999-999999999999",
        serverEntryHash: "a".repeat(64),
        serverSequence: "1",
        attribution: { outcome: "REFUSED", error: "attribution_failed" }
      }),
      attributionResponse: () => Response.json({ error: "attribution_bank_verified" }, { status: 409 })
    });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await draftWithPayer(user, panel, "queue");
    await pushQueue(user);
    const retry = await within(panel).findByRole("button", { name: copy("offline.attribution.retry") });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    await waitFor(() =>
      expect(within(panel).getByTestId("draft-attribution-refused")).toHaveTextContent(en("shell.feed.attribute.error.bank_verified"))
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      copy("offline.attribution.retryFailed", { reason: en("shell.feed.attribute.error.bank_verified") })
    );
    expect(within(panel).getByRole("button", { name: copy("offline.attribution.retry") })).toBeEnabled();
  });

  it("an unreadable attribution answer is a refusal with a reason, and the entry is still synced", async () => {
    stubServer({
      pushResult: (mutation) => ({
        mutationId: mutation.mutationId,
        outcome: "ACCEPTED",
        serverEntryId: "99999999-9999-4999-8999-999999999999",
        serverEntryHash: "a".repeat(64),
        serverSequence: "1",
        attribution: { outcome: "WHO_KNOWS" }
      })
    });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await draftWithPayer(user, panel, "queue");
    await pushQueue(user);
    expect(await within(panel).findByTestId("draft-attribution-refused")).toHaveTextContent(
      copy("offline.attribution.reason.unreadable")
    );
    expect((await db.outbox.toArray())[0]).toMatchObject({ state: "synced" });
  });

  it("disables the retry while the device is offline", async () => {
    stubServer({
      pushResult: (mutation) => ({
        mutationId: mutation.mutationId,
        outcome: "ACCEPTED",
        serverEntryId: "99999999-9999-4999-8999-999999999999",
        serverEntryHash: "a".repeat(64),
        serverSequence: "1",
        attribution: { outcome: "REFUSED", error: "attribution_failed" }
      })
    });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await draftWithPayer(user, panel, "queue");
    await pushQueue(user);
    const retry = await within(panel).findByRole("button", { name: copy("offline.attribution.retry") });
    await waitFor(() => expect(retry).toBeEnabled());
    setOnline(false);
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(retry).toBeDisabled());
  });
});

describe("offline console: a draft without a payer, and a device without a member list", () => {
  it("still saves and syncs a plain draft: no attribution in the payload, no attribution UI", async () => {
    const server = stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
    await user.type(field(panel, "offline.drafts.amountLabel"), "75.00");
    await user.click(button(panel, "offline.drafts.queue"));
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    expect((await db.drafts.toArray())[0]!.attribution).toBeNull();
    await pushQueue(user);
    await waitFor(async () => expect((await db.outbox.toArray())[0]?.state).toBe("synced"));
    expect("attribution" in server.pushed[0].payload).toBe(false);
    expect(within(panel).queryByTestId("draft-attribution")).toBeNull();
  });

  it("offline with a cached member list: names the payer from the cache and says the list is from last time", async () => {
    window.localStorage.setItem(
      "sened.payers.v1",
      JSON.stringify({
        [GROUP]: {
          status: "ready",
          members: [{ userId: BERHAN, email: "berhan@example.test" }],
          cycles: [{ cycleId: CYCLE, name: "Meskerem Equb", totalRounds: 10, contributionAmount: "500.00", nextRound: 1, closed: false }],
          cyclesLoaded: true
        }
      })
    );
    setOnline(false);
    // The group itself comes from the per-device cache a returning treasurer already has.
    window.localStorage.setItem(
      "sened.offline.group.v2",
      JSON.stringify({
        email: "t@example.com",
        groups: { [GROUP]: { role: "treasurer", cashAccountId: POT_CASH, incomeAccountId: CONTRIBUTION_INCOME } }
      })
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByTestId("offline-payers-cached")).toHaveTextContent(copy("offline.drafts.payerCached")));
    await user.type(field(panel, "offline.drafts.amountLabel"), "500.00");
    await user.selectOptions(field(panel, "offline.drafts.payerLabel"), BERHAN);
    await user.click(button(panel, "offline.drafts.queue"));
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    expect((await db.drafts.toArray())[0]!.attribution).toEqual({ memberUserId: BERHAN });
    expect((await db.outbox.toArray())[0]!.payload).toMatchObject({ attribution: { memberUserId: BERHAN } });
  });

  it("with no member list at all says so, and the draft can still be saved without a payer", async () => {
    stubServer({ membersDown: true });
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByTestId("offline-payers-unavailable")).toHaveTextContent(copy("offline.drafts.payerUnavailable")));
    await user.type(field(panel, "offline.drafts.amountLabel"), "10.00");
    await user.click(button(panel, "offline.drafts.save"));
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    expect((await db.drafts.toArray())[0]!.attribution).toBeNull();
  });

  it("refuses a cycle or round with no payer, and saves nothing", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByRole("option", { name: "Meskerem Equb" })).toBeInTheDocument());
    await user.type(field(panel, "offline.drafts.amountLabel"), "10.00");
    await user.selectOptions(field(panel, "offline.drafts.cycleLabel"), CYCLE);
    await user.click(button(panel, "offline.drafts.save"));
    expect(await within(panel).findByTestId("offline-draft-form-error")).toHaveTextContent(copy("offline.drafts.payerRequired"));
    expect(await db.drafts.count()).toBe(0);
  });

  it("refuses a round outside the cycle's rounds", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
    await user.type(field(panel, "offline.drafts.amountLabel"), "10.00");
    await user.selectOptions(field(panel, "offline.drafts.payerLabel"), BERHAN);
    await user.selectOptions(field(panel, "offline.drafts.cycleLabel"), CYCLE);
    await user.type(field(panel, "offline.drafts.roundLabel"), "11");
    await user.click(button(panel, "offline.drafts.save"));
    expect(await within(panel).findByTestId("offline-draft-form-error")).toHaveTextContent(copy("offline.drafts.roundError"));
    expect(await db.drafts.count()).toBe(0);
  });

  it("offers no payer for an entry that is not a contribution", async () => {
    stubServer();
    render(<OfflineConsole database={db} />);
    const user = userEvent.setup();
    const panel = await findPanel();
    await waitFor(() => expect(within(panel).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument());
    await user.selectOptions(field(panel, "offline.drafts.entryTypeLabel"), "journal");
    expect(within(panel).queryByLabelText(copy("offline.drafts.payerLabel"))).toBeNull();
  });
});
