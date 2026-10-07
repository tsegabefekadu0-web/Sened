import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in" } as { status: string }
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));

import { RecordContributionForm } from "@/components/ledger/RecordContributionForm";
import { translate, type MessageKey } from "@/lib/i18n";
import {
  buildContributionRequest,
  ContributionBuildError,
  newContributionIdempotencyKey
} from "@/lib/ledger/clientContribution";

const GROUP = "22222222-2222-4222-8222-222222222222";
const CASH = "33333333-3333-4333-8333-333333333333";
const INCOME = "44444444-4444-4444-8444-444444444444";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const BERHAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELAM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CYCLE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ENTRY = "55555555-5555-4555-8555-555555555555";

const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);
const am = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("am", key, vars);

function myGroups(role: string, accounts = true) {
  return {
    groups: [
      {
        groupId: GROUP,
        role,
        accounts: accounts
          ? [
              { id: CASH, code: "POT_CASH" },
              { id: INCOME, code: "CONTRIBUTION_INCOME" }
            ]
          : []
      }
    ]
  };
}

const members = {
  members: [
    { userId: TREASURER, role: "treasurer", joinedAt: "2026-09-01T00:00:00Z", email: "treasurer@example.test", attire: "none" },
    { userId: BERHAN, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: "berhan@example.test", attire: "none" },
    { userId: SELAM, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: null, attire: "none" }
  ]
};

function cycleRow(overrides: Record<string, unknown> = {}) {
  return {
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
    roundsRevealed: 2,
    roundsPaid: 2,
    nextRound: 3,
    ...overrides
  };
}

interface Server {
  role: string;
  accounts: boolean;
  cycles: "ok" | "down";
  /** Responses for POST /api/ledger/entries, consumed in order; the last repeats. */
  entryResponses: (() => Response)[];
  /** Responses for POST /api/ledger/attributions. */
  attributionResponses: (() => Response)[];
  posts: Record<string, unknown>[];
  attributions: Record<string, unknown>[];
}

function makeServer(overrides: Partial<Server> = {}): Server {
  return {
    role: "treasurer",
    accounts: true,
    cycles: "ok",
    entryResponses: [() => created("recorded")],
    attributionResponses: [() => Response.json({ attribution: { revision: 1 }, replayed: false }, { status: 201 })],
    posts: [],
    attributions: [],
    ...overrides
  };
}

function created(attribution: "recorded" | "refused" | "failed" | "none", replayed = false): Response {
  const body: Record<string, unknown> = {
    entry: { id: ENTRY, sequence: "12", groupId: GROUP },
    replayed
  };
  if (attribution === "recorded") body.attribution = { status: "recorded", replayed: false };
  if (attribution === "refused") body.attribution = { status: "refused", error: "attribution_bank_verified" };
  if (attribution === "failed") body.attribution = { status: "failed" };
  return Response.json(body, { status: replayed ? 200 : 201 });
}

function fetchFor(server: Server) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/my-groups") return Response.json(myGroups(server.role, server.accounts));
    if (url.startsWith("/api/ledger/members")) return Response.json(members);
    if (url.startsWith("/api/draw/cycles")) {
      return server.cycles === "ok" ? Response.json({ cycles: [cycleRow(), cycleRow({ cycleId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Old Equb", closedAt: "2026-08-01T00:00:00Z", nextRound: null })] }) : new Response("{}", { status: 500 });
    }
    if (url === "/api/ledger/entries") {
      server.posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const next = server.entryResponses.length > 1 ? server.entryResponses.shift()! : server.entryResponses[0];
      return next();
    }
    if (url === "/api/ledger/attributions") {
      server.attributions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const next = server.attributionResponses.length > 1 ? server.attributionResponses.shift()! : server.attributionResponses[0];
      return next();
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function mount(server: Server, locale: "en" | "am" = "en") {
  const fetchImpl = fetchFor(server);
  render(<RecordContributionForm locale={locale} deps={{ getToken: async () => "tok", fetchImpl: fetchImpl as never }} />);
  return fetchImpl;
}

async function readyForm() {
  return screen.findByRole("form", { name: en("record.title") });
}

async function fill(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, values: { amount?: string; payer?: string; date?: string; cycle?: string; round?: string } = {}) {
  const amount = within(form).getByLabelText(en("record.amountLabel"), { exact: false });
  if (values.amount !== undefined) {
    await user.clear(amount);
    if (values.amount !== "") await user.type(amount, values.amount);
  }
  if (values.payer) await user.selectOptions(within(form).getByLabelText(en("record.payerLabel"), { exact: false }), values.payer);
  if (values.date) {
    const date = within(form).getByLabelText(en("record.dateLabel"), { exact: false });
    await user.clear(date);
    await user.type(date, values.date);
  }
  if (values.cycle) await user.selectOptions(within(form).getByLabelText(en("record.cycleLabel"), { exact: false }), values.cycle);
  if (values.round) {
    const round = within(form).getByLabelText(en("record.roundLabel"), { exact: false });
    await user.clear(round);
    await user.type(round, values.round);
  }
}

const submitButton = (form: HTMLElement) => form.querySelector<HTMLButtonElement>("button[type=submit]")!;

beforeEach(() => {
  hoisted.session = { status: "signed-in" };
});

afterEach(() => {
  cleanup();
});

describe("record-contribution form: who sees it", () => {
  it("shows a signed-out visitor sign-in text and no controls, and fetches nothing", () => {
    hoisted.session = { status: "signed-out" };
    const fetchImpl = mount(makeServer());
    expect(screen.getByTestId("record-state")).toHaveTextContent(en("record.signIn"));
    expect(screen.queryByRole("form")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows a plain member read-only text and no controls, and never loads members", async () => {
    const fetchImpl = mount(makeServer({ role: "member" }));
    expect(await screen.findByTestId("record-state")).toHaveTextContent(en("record.readOnly"));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: en("record.submit") })).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["/api/my-groups"]);
  });

  it.each(["owner", "treasurer"])("offers the form to the group's %s", async (role) => {
    mount(makeServer({ role }));
    const form = await readyForm();
    expect(within(form).getByLabelText(en("record.amountLabel"), { exact: false })).toBeInTheDocument();
  });

  it("says so when the group has no cash / income account, instead of posting against a guess", async () => {
    mount(makeServer({ accounts: false }));
    expect(await screen.findByTestId("record-state")).toHaveTextContent(en("record.noAccounts"));
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("shows the Amharic copy", async () => {
    mount(makeServer({ role: "member" }), "am");
    expect(await screen.findByTestId("record-state")).toHaveTextContent(am("record.readOnly"));
    expect(screen.getByRole("heading", { name: am("record.title") })).toBeInTheDocument();
  });
});

describe("record-contribution form: validation", () => {
  it.each(["", "0", "0.00", "-5", "12.345", "1e3", "abc", "1,000"])("refuses the amount %j before anything is sent", async (amount) => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount, payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.amount"))).toBeInTheDocument();
    expect(server.posts).toHaveLength(0);
  });

  it("asks for a payer", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250" });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.payer"))).toBeInTheDocument();
    expect(server.posts).toHaveLength(0);
  });

  it("refuses a date in the future", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN, date: "2999-01-01" });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.date"))).toBeInTheDocument();
    expect(server.posts).toHaveLength(0);
  });

  it("keeps the round within the cycle's 1..totalRounds and needs a cycle for one", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    expect(within(form).getByLabelText(en("record.roundLabel"), { exact: false })).toBeDisabled();
    await fill(user, form, { amount: "250", payer: BERHAN, cycle: CYCLE, round: "11" });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.round", { total: 10 }))).toBeInTheDocument();
    await fill(user, form, { round: "0" });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.round", { total: 10 }))).toBeInTheDocument();
    expect(server.posts).toHaveLength(0);
  });

  it("prefills the amount from the chosen cycle without overwriting what was typed", async () => {
    mount(makeServer());
    const form = await readyForm();
    const user = userEvent.setup();
    const amount = within(form).getByLabelText(en("record.amountLabel"), { exact: false });
    await user.selectOptions(within(form).getByLabelText(en("record.cycleLabel"), { exact: false }), CYCLE);
    expect(amount).toHaveValue("500.00");
    await user.selectOptions(within(form).getByLabelText(en("record.cycleLabel"), { exact: false }), "");
    await user.clear(amount);
    await user.type(amount, "75");
    await user.selectOptions(within(form).getByLabelText(en("record.cycleLabel"), { exact: false }), CYCLE);
    expect(amount).toHaveValue("75");
  });

  it("labels members by email, or anonymously when the members API hid it, and marks closed cycles", async () => {
    mount(makeServer());
    const form = await readyForm();
    const payer = within(form).getByLabelText(en("record.payerLabel"), { exact: false });
    expect(within(payer).getByRole("option", { name: "berhan@example.test" })).toBeInTheDocument();
    expect(within(payer).getByRole("option", { name: en("members.anonymous", { id: SELAM.slice(0, 8) }) })).toBeInTheDocument();
    const cycle = within(form).getByLabelText(en("record.cycleLabel"), { exact: false });
    expect(within(cycle).getByRole("option", { name: en("record.cycleClosed", { name: "Old Equb" }) })).toBeInTheDocument();
  });

  it("still works without a cycle when the cycles could not be loaded, and says so", async () => {
    const server = makeServer({ cycles: "down" });
    mount(server);
    const form = await readyForm();
    expect(within(form).getByTestId("record-cycles-unavailable")).toHaveTextContent(en("record.cyclesUnavailable"));
    expect(within(form).queryByLabelText(en("record.cycleLabel"), { exact: false })).toBeNull();
    const user = userEvent.setup();
    await fill(user, form, { amount: "100", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-attributed")).toBeInTheDocument();
    expect(server.posts[0]).not.toHaveProperty("attribution.cycleId");
  });
});

describe("record-contribution form: posting", () => {
  it("posts one balanced contribution with the payer, cycle and round, and says it is attributed", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250.5", payer: BERHAN, date: "2026-10-01", cycle: CYCLE, round: "3" });
    await user.click(submitButton(form));

    expect(await within(form).findByTestId("record-attributed")).toHaveTextContent(
      en("record.result.attributed", { payer: "berhan@example.test" })
    );
    expect(within(form).getByTestId("record-posted")).toHaveTextContent(en("record.result.posted", { sequence: "12" }));
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toMatchObject({
      groupId: GROUP,
      entryType: "contribution",
      idempotencyKey: expect.stringMatching(/^contrib-/),
      postings: [
        { accountId: CASH, direction: "debit", amount: "250.50" },
        { accountId: INCOME, direction: "credit", amount: "250.50" }
      ],
      attribution: { memberUserId: BERHAN, cycleId: CYCLE, round: 3 }
    });
    expect(new Date(server.posts[0].occurredAt as string).getFullYear()).toBe(2026);
    // The form is ready for the next one.
    expect(within(form).getByLabelText(en("record.amountLabel"), { exact: false })).toHaveValue("");
    expect(within(form).queryByRole("button", { name: en("record.retry") })).toBeNull();
  });

  it("shows a replay as already recorded, not as a second posting", async () => {
    const server = makeServer({ entryResponses: [() => created("recorded", true)] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "10", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-posted")).toHaveTextContent(en("record.result.replayed", { sequence: "12" }));
  });

  it("posted but the attribution was refused: shows the reason and retries ONLY the attribution", async () => {
    const server = makeServer({ entryResponses: [() => created("refused")] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN, cycle: CYCLE, round: "2" });
    await user.click(submitButton(form));

    const refused = await within(form).findByTestId("record-attribution-refused");
    expect(refused).toHaveTextContent(
      en("record.result.refused", { reason: en("shell.feed.attribute.error.bank_verified") })
    );
    expect(within(form).getByTestId("record-posted")).toBeInTheDocument();
    expect(within(form).queryByTestId("record-attributed")).toBeNull();

    await user.click(within(form).getByRole("button", { name: en("record.retry") }));
    expect(await within(form).findByTestId("record-attributed")).toBeInTheDocument();
    // The entry was posted once; the retry went to the attribute action with the entry id and the same payer.
    expect(server.posts).toHaveLength(1);
    expect(server.attributions).toEqual([{ groupId: GROUP, entryId: ENTRY, memberUserId: BERHAN, cycleId: CYCLE, round: 2 }]);
    expect(within(form).queryByRole("button", { name: en("record.retry") })).toBeNull();
  });

  it("a retry that is refused again keeps the entry posted and shows the new reason", async () => {
    const server = makeServer({
      entryResponses: [() => created("refused")],
      attributionResponses: [() => Response.json({ error: "attribution_exists" }, { status: 409 })]
    });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    await user.click(await within(form).findByRole("button", { name: en("record.retry") }));
    expect(await within(form).findByText(new RegExp(en("shell.feed.attribute.error.exists")))).toBeInTheDocument();
    expect(within(form).getByTestId("record-posted")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: en("record.retry") })).toBeEnabled();
  });

  it("a retry that cannot reach the server says so without changing the result", async () => {
    const server = makeServer({
      entryResponses: [() => created("failed")],
      attributionResponses: [() => new Response("{}", { status: 500 })]
    });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-attribution-failed")).toHaveTextContent(en("record.result.failed"));
    await user.click(within(form).getByRole("button", { name: en("record.retry") }));
    expect(await within(form).findByTestId("record-retry-error")).toHaveTextContent(en("shell.feed.attribute.error.error"));
    expect(within(form).getByTestId("record-attribution-failed")).toBeInTheDocument();
  });

  it("treats a response that says nothing about the attribution as not recorded, never as recorded", async () => {
    const server = makeServer({ entryResponses: [() => created("none")] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-attribution-failed")).toBeInTheDocument();
    expect(within(form).queryByTestId("record-attributed")).toBeNull();
  });

  it.each([
    [403, "record.fail.forbidden"],
    [422, "record.fail.invalid"],
    [400, "record.fail.invalid"],
    [409, "record.fail.conflict"],
    [429, "record.fail.rate_limited"],
    [401, "record.fail.unauthorized"],
    [502, "record.fail.error"]
  ] as const)("a %s from the ledger is a failure and nothing is shown as recorded", async (status, key) => {
    const server = makeServer({ entryResponses: [() => Response.json({ error: "x" }, { status })] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-failure")).toHaveTextContent(en(key));
    expect(within(form).queryByTestId("record-result")).toBeNull();
    // The typed values are kept so the person can fix and resend.
    expect(within(form).getByLabelText(en("record.amountLabel"), { exact: false })).toHaveValue("250");
  });

  it("a network failure is a failure with an unknown outcome", async () => {
    const server = makeServer({
      entryResponses: [
        () => {
          throw new TypeError("network down");
        }
      ]
    });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    expect(await within(form).findByTestId("record-failure")).toHaveTextContent(en("record.fail.error"));
  });

  it("resubmitting the same attempt after an unknown outcome reuses the idempotency key and timestamp", async () => {
    const server = makeServer({ entryResponses: [() => new Response("{}", { status: 502 }), () => created("recorded", true)] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    await within(form).findByTestId("record-failure");
    await user.click(submitButton(form));
    await within(form).findByTestId("record-result");

    expect(server.posts).toHaveLength(2);
    expect(server.posts[1].idempotencyKey).toBe(server.posts[0].idempotencyKey);
    expect(server.posts[1].occurredAt).toBe(server.posts[0].occurredAt);
    expect(server.posts[1]).toEqual(server.posts[0]);
  });

  it("a changed value is a different attempt with a different key", async () => {
    const server = makeServer({ entryResponses: [() => new Response("{}", { status: 502 }), () => created("recorded")] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    await within(form).findByTestId("record-failure");
    await fill(user, form, { amount: "260" });
    await user.click(submitButton(form));
    await within(form).findByTestId("record-result");
    expect(server.posts[1].idempotencyKey).not.toBe(server.posts[0].idempotencyKey);
  });

  it("a double click posts once while the first request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = makeServer();
    server.entryResponses = [
      () => {
        throw new Error("replaced below");
      }
    ];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/ledger/entries") {
        server.posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        await gate;
        return created("recorded");
      }
      return fetchFor(server)(url, init);
    });
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchImpl as never }} />);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.click(submitButton(form));
    await waitFor(() => expect(submitButton(form)).toBeDisabled());
    await user.click(submitButton(form));
    release();
    await within(form).findByTestId("record-result");
    expect(server.posts).toHaveLength(1);
  });
});

describe("record-contribution form: how it was paid and a note", () => {
  const channelField = (form: HTMLElement) => within(form).getByLabelText(en("record.channelLabel"), { exact: false });
  const noteField = (form: HTMLElement) => within(form).getByLabelText(en("record.noteLabel"), { exact: false });

  it("offers the five channels plus 'not stated', defaulting to not stated", async () => {
    mount(makeServer());
    const form = await readyForm();
    const options = within(channelField(form)).getAllByRole("option").map((option) => [option.getAttribute("value"), option.textContent]);
    expect(options).toEqual([
      ["", en("record.channelNone")],
      ["telebirr", "Telebirr"],
      ["cbe", "CBE Birr"],
      ["awash", "Awash Bank"],
      ["cash", "Cash"],
      ["other", "Other"]
    ]);
    expect(channelField(form)).toHaveValue("");
    expect(noteField(form)).toHaveValue("");
  });

  it("posts the channel and the trimmed note with the payer, beside the entry and not inside it, and shows them back as text", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.selectOptions(channelField(form), "telebirr");
    await user.type(noteField(form), "  <b>Sent</b> by his wife  ");
    await user.click(submitButton(form));

    expect(await within(form).findByTestId("record-attributed")).toBeInTheDocument();
    expect(server.posts[0]!.attribution).toEqual({ memberUserId: BERHAN, channel: "telebirr", note: "<b>Sent</b> by his wife" });
    // Nothing of them in the ledger entry's own fields.
    const { attribution: _a, ...entry } = server.posts[0]!;
    expect(JSON.stringify(entry)).not.toMatch(/telebirr|Sent|channel|note/);
    expect(within(form).getByTestId("record-channel")).toHaveTextContent(en("record.result.channel", { channel: "Telebirr" }));
    const shown = within(form).getByTestId("record-note");
    expect(shown).toHaveTextContent("Note: <b>Sent</b> by his wife");
    expect(shown.querySelector("b")).toBeNull();
    // The form is clear for the next one.
    expect(channelField(form)).toHaveValue("");
    expect(noteField(form)).toHaveValue("");
  });

  it("sends neither key when they are left empty, exactly as before", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.type(noteField(form), "    ");
    await user.click(submitButton(form));
    await within(form).findByTestId("record-attributed");
    expect(server.posts[0]!.attribution).toEqual({ memberUserId: BERHAN });
    expect(within(form).queryByTestId("record-channel")).toBeNull();
    expect(within(form).queryByTestId("record-note")).toBeNull();
  });

  it("refuses a note over 280 characters or with a control character, and posts nothing", async () => {
    const server = makeServer();
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    fireEvent.change(noteField(form), { target: { value: "n".repeat(281) } });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.note"))).toBeInTheDocument();
    fireEvent.change(noteField(form), { target: { value: "bell\u0007" } });
    await user.click(submitButton(form));
    expect(await within(form).findByText(en("record.error.note"))).toBeInTheDocument();
    expect(server.posts).toHaveLength(0);
    // 280 characters of Ethiopic is fine.
    fireEvent.change(noteField(form), { target: { value: "\u1220".repeat(280) } });
    await user.click(submitButton(form));
    await within(form).findByTestId("record-attributed");
    expect((server.posts[0]!.attribution as { note: string }).note).toHaveLength(280);
  });

  it("the retry of a refused payer carries the same channel and note", async () => {
    const server = makeServer({ entryResponses: [() => created("refused")] });
    mount(server);
    const form = await readyForm();
    const user = userEvent.setup();
    await fill(user, form, { amount: "250", payer: BERHAN });
    await user.selectOptions(channelField(form), "cash");
    await user.type(noteField(form), "Hand to hand");
    await user.click(submitButton(form));
    await within(form).findByTestId("record-attribution-refused");
    await user.click(within(form).getByRole("button", { name: en("record.retry") }));
    expect(await within(form).findByTestId("record-attributed")).toBeInTheDocument();
    expect(server.posts).toHaveLength(1);
    expect(server.attributions).toEqual([
      { groupId: GROUP, entryId: ENTRY, memberUserId: BERHAN, channel: "cash", note: "Hand to hand" }
    ]);
  });

  it("speaks Amharic", async () => {
    mount(makeServer(), "am");
    await screen.findByRole("form", { name: am("record.title") });
    expect(screen.getByLabelText(am("record.channelLabel"), { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(am("record.noteLabel"), { exact: false })).toBeInTheDocument();
  });
});

describe("buildContributionRequest", () => {
  const base = {
    groupId: GROUP,
    cashAccountId: CASH,
    incomeAccountId: INCOME,
    occurredAt: new Date("2026-10-01T09:00:00.000Z"),
    idempotencyKey: "contrib-1"
  };

  it("builds a balanced debit-cash / credit-income contribution with exact decimals", () => {
    expect(buildContributionRequest({ ...base, amount: " 1250.5 " })).toEqual({
      groupId: GROUP,
      idempotencyKey: "contrib-1",
      occurredAt: "2026-10-01T09:00:00.000Z",
      entryType: "contribution",
      postings: [
        { accountId: CASH, direction: "debit", amount: "1250.50" },
        { accountId: INCOME, direction: "credit", amount: "1250.50" }
      ]
    });
  });

  it("refuses a bad amount, date or account pair", () => {
    for (const [patch, code] of [
      [{ amount: "0" }, "amount"],
      [{ amount: "1.234" }, "amount"],
      [{ amount: "5", occurredAt: new Date("nope") }, "date"],
      [{ amount: "5", incomeAccountId: CASH }, "accounts"]
    ] as const) {
      expect(() => buildContributionRequest({ ...base, ...patch })).toThrow(ContributionBuildError);
      try {
        buildContributionRequest({ ...base, ...patch });
      } catch (error) {
        expect((error as ContributionBuildError).code).toBe(code);
      }
    }
  });

  it("makes keys that match the server's pattern and are distinct", () => {
    const a = newContributionIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(newContributionIdempotencyKey()).not.toBe(a);
  });
});
