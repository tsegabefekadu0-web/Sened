import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  pref: { ready: true, groupId: null as string | null, reload: vi.fn() }
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => ({ status: "signed-in" }) }));
vi.mock("@/lib/groups/useActiveGroup", () => ({ useActiveGroupPreference: () => hoisted.pref }));

import { RecordContributionForm } from "@/components/ledger/RecordContributionForm";
import { translate, type MessageKey } from "@/lib/i18n";

const GROUP_A = "22222222-2222-4222-8222-222222222222";
const GROUP_B = "77777777-7777-4777-8777-777777777777";
const CASH = "33333333-3333-4333-8333-333333333333";
const INCOME = "44444444-4444-4444-8444-444444444444";
const BERHAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY = "55555555-5555-4555-8555-555555555555";

const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);

const accounts = [
  { id: CASH, code: "POT_CASH" },
  { id: INCOME, code: "CONTRIBUTION_INCOME" }
];

interface Harness {
  posts: Record<string, unknown>[];
  gate: Promise<void> | null;
  responses: (() => Response)[];
  groups: { groupId: string; name: string; role: string; accounts: typeof accounts }[];
}

function harness(): Harness {
  return {
    posts: [],
    gate: null,
    responses: [() => Response.json({ entry: { id: ENTRY, sequence: "7" }, replayed: false, attribution: { status: "recorded", replayed: false } }, { status: 201 })],
    groups: [
      { groupId: GROUP_A, name: "Mesfin Equb", role: "treasurer", accounts },
      { groupId: GROUP_B, name: "Selam Iddir", role: "treasurer", accounts }
    ]
  };
}

function fetchFor(h: Harness) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/my-groups") return Response.json({ groups: h.groups });
    if (url.startsWith("/api/ledger/members")) {
      return Response.json({ members: [{ userId: BERHAN, role: "member", joinedAt: "2026-09-01T00:00:00Z", email: "berhan@example.test", attire: "none" }] });
    }
    if (url.startsWith("/api/draw/cycles")) return Response.json({ cycles: [] });
    if (url === "/api/ledger/entries") {
      h.posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (h.gate) await h.gate;
      const next = h.responses.length > 1 ? h.responses.shift()! : h.responses[0];
      return next();
    }
    throw new Error(`unexpected request ${url}`);
  });
}

const submit = (form: HTMLElement) => form.querySelector<HTMLButtonElement>("button[type=submit]")!;

async function fill(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, amount: string) {
  await user.clear(within(form).getByLabelText(en("record.amountLabel"), { exact: false }));
  await user.type(within(form).getByLabelText(en("record.amountLabel"), { exact: false }), amount);
  await user.selectOptions(within(form).getByLabelText(en("record.payerLabel"), { exact: false }), BERHAN);
}

beforeEach(() => {
  hoisted.pref = { ready: true, groupId: GROUP_A, reload: vi.fn() };
});
afterEach(() => cleanup());

describe("record-contribution form: which group it records to", () => {
  it("names the target group in the form", async () => {
    const h = harness();
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchFor(h) as never }} />);
    const form = await screen.findByRole("form", { name: en("record.title") });
    expect(within(form).getByTestId("record-target-group")).toHaveTextContent(en("record.targetGroup", { group: "Mesfin Equb" }));
  });

  it("asks the active-group store to reload when the server does not have the preferred group", async () => {
    const h = harness();
    hoisted.pref = { ready: true, groupId: "99999999-9999-4999-8999-999999999999", reload: vi.fn() };
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchFor(h) as never }} />);
    expect(await screen.findByTestId("record-state")).toHaveTextContent(en("record.chooseGroup"));
    expect(hoisted.pref.reload).toHaveBeenCalled();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("asks for a reload when the server resolved a group that is not the active one", async () => {
    const h = harness();
    h.groups = [h.groups[0]];
    hoisted.pref = { ready: true, groupId: null, reload: vi.fn() };
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchFor(h) as never }} />);
    await screen.findByRole("form", { name: en("record.title") });
    expect(hoisted.pref.reload).toHaveBeenCalled();
  });

  it("does not reload when the server agrees", async () => {
    const h = harness();
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchFor(h) as never }} />);
    await screen.findByRole("form", { name: en("record.title") });
    expect(hoisted.pref.reload).not.toHaveBeenCalled();
  });
});

describe("record-contribution form: the resubmit fingerprint", () => {
  it("a changed channel or note is a different attempt with a different key", async () => {
    const h = harness();
    h.responses = [() => new Response("{}", { status: 502 }), () => new Response("{}", { status: 502 }), () => new Response("{}", { status: 502 })];
    render(<RecordContributionForm deps={{ getToken: async () => "tok", fetchImpl: fetchFor(h) as never }} />);
    const form = await screen.findByRole("form", { name: en("record.title") });
    const user = userEvent.setup();
    await fill(user, form, "250");
    await user.click(submit(form));
    await within(form).findByTestId("record-failure");

    await user.selectOptions(within(form).getByLabelText(en("record.channelLabel"), { exact: false }), "cash");
    await user.click(submit(form));
    await waitFor(() => expect(h.posts).toHaveLength(2));
    expect(h.posts[1].idempotencyKey).not.toBe(h.posts[0].idempotencyKey);

    await user.type(within(form).getByLabelText(en("record.noteLabel"), { exact: false }), "paid at the office");
    await user.click(submit(form));
    await waitFor(() => expect(h.posts).toHaveLength(3));
    expect(h.posts[2].idempotencyKey).not.toBe(h.posts[1].idempotencyKey);

    // Resubmitting with nothing changed still reuses the key.
    await user.click(submit(form));
    await waitFor(() => expect(h.posts).toHaveLength(4));
    expect(h.posts[3].idempotencyKey).toBe(h.posts[2].idempotencyKey);
  });
});

describe("record-contribution form: a group switch while a post is in flight", () => {
  it("does not clear, mark posted or disable the new group's form, and says where the money went", async () => {
    const h = harness();
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = { getToken: async () => "tok", fetchImpl: fetchFor(h) as never };
    const { rerender } = render(<RecordContributionForm deps={deps} />);
    const form = await screen.findByRole("form", { name: en("record.title") });
    const user = userEvent.setup();
    await fill(user, form, "250");
    await user.click(submit(form));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].groupId).toBe(GROUP_A);

    hoisted.pref = { ready: true, groupId: GROUP_B, reload: vi.fn() };
    rerender(<RecordContributionForm deps={deps} />);
    expect(await screen.findByText(en("record.targetGroup", { group: "Selam Iddir" }))).toBeInTheDocument();
    const newForm = screen.getByRole("form", { name: en("record.title") });
    const amount = within(newForm).getByLabelText(en("record.amountLabel"), { exact: false });
    await user.clear(amount);
    await user.type(amount, "90");

    release();
    expect(await screen.findByTestId("record-late-result")).toHaveTextContent(en("record.lateSaved", { group: "Mesfin Equb" }));
    expect(screen.queryByTestId("record-result")).toBeNull();
    expect(amount).toHaveValue("90");
    expect(submit(newForm)).not.toBeDisabled();
  });
});
