import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in" } as { status: string },
  load: vi.fn(),
  post: vi.fn()
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientRead", () => ({ loadCorrectionTargets: hoisted.load }));
vi.mock("@/lib/ledger/clientCorrect", () => ({ postCorrection: hoisted.post }));

import { M2Dashboard } from "@/components/ledger/m2-dashboard";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";

const GROUP = "22222222-2222-4222-8222-222222222222";

function target(id: string, sequence: string) {
  return {
    id,
    groupId: GROUP,
    occurredAt: "2026-09-01T09:00:00.000Z",
    type: "contribution",
    sequence,
    amount: "25.00",
    direction: "inbound",
    reference: "#" + sequence,
    postings: [
      { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", direction: "debit", amount: "25.00" },
      { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", direction: "credit", amount: "25.00" }
    ]
  };
}

async function openForm() {
  const user = userEvent.setup();
  render(<M2Dashboard />);
  await user.click(screen.getAllByRole("button", { name: "Start a correction" })[0]);
  return { user, form: screen.getByRole("form", { name: "Create a compensating entry" }) };
}

describe("M2 correction form, signed in", () => {
  beforeEach(() => {
    hoisted.session = { status: "signed-in" };
    hoisted.load.mockReset();
  });

  it("shows a loading state, then the live entries instead of the fixture", async () => {
    let resolve!: (value: unknown) => void;
    hoisted.load.mockReturnValue(new Promise((r) => (resolve = r)));
    const { form } = await openForm();
    expect(within(form).getByText("Loading your ledger entries…")).toBeInTheDocument();

    resolve({
      status: "ready",
      targets: [target("e1", "7")]
    });
    const select = within(form).getByLabelText("Original entry");
    await waitFor(() => expect(within(select).getByRole("option", { name: /sequence 7/ })).toBeInTheDocument());
    expect(within(select).queryByRole("option", { name: /TXN-4281/ })).toBeNull();
    expect(within(form).getByText(/read from your live ledger/)).toBeInTheDocument();
  });

  it.each([
    ["empty", "Your ledger has no entries to correct yet."],
    ["unauthorized", "Your session ended. Sign in again to load your ledger entries."],
    ["no-group", "You are not a member of a ledger group, so there are no entries to show."],
    [
      "choose-group",
      "You belong to more than one ledger group. Choose one with the group switcher to see its entries."
    ],
    ["read-only", "Only the group owner or treasurer can record corrections. Ask them to make this correction."],
    ["error", "We could not load your ledger entries. Try again in a moment."]
  ])("shows the %s state", async (status, message) => {
    hoisted.load.mockResolvedValue({ status });
    const { form } = await openForm();
    expect(await within(form).findByText(message)).toBeInTheDocument();
  });

  it("disables the submit button for a plain member (read-only), so nothing can be sent", async () => {
    hoisted.load.mockResolvedValue({ status: "read-only" });
    const { form } = await openForm();
    await within(form).findByText(/Only the group owner or treasurer/);
    expect(within(form).getByRole("button", { name: "Create compensating entry" })).toBeDisabled();
  });

  it("does not fetch while the form is closed", () => {
    render(<M2Dashboard />);
    expect(hoisted.load).not.toHaveBeenCalled();
  });

  it("refuses to submit with no original chosen", async () => {
    hoisted.load.mockResolvedValue({ status: "empty" });
    const { user, form } = await openForm();
    await within(form).findByText("Your ledger has no entries to correct yet.");
    await user.type(within(form).getByLabelText(/Correction rationale/), "Wrong member credited");
    await user.click(within(form).getByRole("button", { name: "Create compensating entry" }));
    expect(await within(form).findByText("Choose an original entry first.")).toBeInTheDocument();
  });
});

describe("M2 correction form, signed in: submitting", () => {
  const RATIONALE = "Wrong member was credited";

  beforeEach(() => {
    hoisted.session = { status: "signed-in" };
    hoisted.load.mockReset();
    hoisted.post.mockReset();
    hoisted.load.mockResolvedValue({ status: "ready", targets: [target("e1", "7"), target("e2", "6")] });
  });

  async function fill(choose = "e1") {
    const ctx = await openForm();
    const select = await within(ctx.form).findByLabelText("Original entry");
    await waitFor(() => expect(within(select).getByRole("option", { name: /sequence 7/ })).toBeInTheDocument());
    await ctx.user.selectOptions(select, choose);
    await ctx.user.type(within(ctx.form).getByLabelText(/Correction rationale/), RATIONALE);
    return { ...ctx, submit: within(ctx.form).getByRole("button", { name: "Create compensating entry" }) };
  }

  it("posts the reversal, then refreshes the list and resets the form", async () => {
    hoisted.post.mockResolvedValue({ status: "created", sequence: "9", replayed: false });
    const { user, form, submit } = await fill();
    hoisted.load.mockResolvedValue({ status: "ready", targets: [target("e2", "6")] });
    await user.click(submit);

    expect(await within(form).findByText("Compensating entry recorded")).toBeInTheDocument();
    expect(within(form).getByText("New entry: sequence 9")).toBeInTheDocument();
    expect(hoisted.post).toHaveBeenCalledTimes(1);
    const request = hoisted.post.mock.calls[0][0];
    expect(request).toMatchObject({
      groupId: GROUP,
      entryType: "correction",
      correctsEntryId: "e1",
      rationale: RATIONALE,
      postings: [
        { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", direction: "credit", amount: "25.00" },
        { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", direction: "debit", amount: "25.00" }
      ]
    });
    expect(request.idempotencyKey).toMatch(/^corr-/);
    await waitFor(() => expect(hoisted.load).toHaveBeenCalledTimes(2));
    const select = within(form).getByLabelText("Original entry");
    await waitFor(() => expect(within(select).queryByRole("option", { name: /sequence 7/ })).toBeNull());
    expect(within(form).getByLabelText(/Correction rationale/)).toHaveValue("");
    expect(within(form).queryByText(/nothing is written/)).toBeNull();
  });

  it("says so when the server replayed an earlier post of the same correction", async () => {
    hoisted.post.mockResolvedValue({ status: "created", sequence: "9", replayed: true });
    const { user, form, submit } = await fill();
    await user.click(submit);
    expect(await within(form).findByText("This correction was already recorded earlier. Nothing new was added.")).toBeInTheDocument();
  });

  it("disables submit in flight and posts once for a double-click", async () => {
    let resolve!: (value: unknown) => void;
    hoisted.post.mockReturnValue(new Promise((r) => (resolve = r)));
    const { user, form, submit } = await fill();
    await user.dblClick(submit);
    expect(hoisted.post).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(within(form).getByText("Recording the compensating entry…")).toBeInTheDocument();
    resolve({ status: "created", sequence: "9", replayed: false });
    await within(form).findByText("Compensating entry recorded");
    expect(hoisted.post).toHaveBeenCalledTimes(1);
  });

  it("reuses the same idempotency key and body when retrying after an unconfirmed failure", async () => {
    hoisted.post.mockResolvedValueOnce({ status: "error" }).mockResolvedValueOnce({ status: "created", sequence: "9", replayed: true });
    const { user, form, submit } = await fill();
    await user.click(submit);
    expect(await within(form).findByText(/could not confirm that the correction was recorded/)).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.click(submit);
    await within(form).findByText("Compensating entry recorded");
    expect(hoisted.post).toHaveBeenCalledTimes(2);
    expect(hoisted.post.mock.calls[1][0]).toEqual(hoisted.post.mock.calls[0][0]);
  });

  it("uses a new key when the rationale is edited after a failure", async () => {
    hoisted.post.mockResolvedValue({ status: "error" });
    const { user, form, submit } = await fill();
    await user.click(submit);
    await within(form).findByRole("alert");
    await user.type(within(form).getByLabelText(/Correction rationale/), " today");
    await user.click(submit);
    await waitFor(() => expect(hoisted.post).toHaveBeenCalledTimes(2));
    expect(hoisted.post.mock.calls[1][0].idempotencyKey).not.toBe(hoisted.post.mock.calls[0][0].idempotencyKey);
  });

  it.each([
    ["unauthorized", "Your session ended. Sign in again, then submit the correction."],
    ["forbidden", "Your role is not allowed to record ledger entries."],
    ["rate-limited", "Too many requests. Wait a moment, then submit again."],
    ["error", "We could not confirm that the correction was recorded. Submit again: it will not be recorded twice."]
  ])("shows %s and keeps the form so it can be retried", async (status, message) => {
    hoisted.post.mockResolvedValue({ status });
    const { user, form, submit } = await fill();
    await user.click(submit);
    expect(await within(form).findByText(message)).toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(within(form).getByLabelText(/Correction rationale/)).toHaveValue(RATIONALE);
    expect(hoisted.load).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid", /The ledger refused this correction/],
    ["conflict", /clashes with an earlier attempt/]
  ])("on %s shows the message and refreshes the list", async (status, message) => {
    hoisted.post.mockResolvedValue({ status });
    const { user, form, submit } = await fill();
    await user.click(submit);
    expect(await within(form).findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(hoisted.load).toHaveBeenCalledTimes(2));
    expect(within(form).queryByText("Compensating entry recorded")).toBeNull();
  });

  it("does not post when the rationale is too short", async () => {
    const { user, form, submit } = await fill();
    const box = within(form).getByLabelText(/Correction rationale/);
    await user.clear(box);
    await user.type(box, "short");
    await user.click(submit);
    expect(hoisted.post).not.toHaveBeenCalled();
    expect(await within(form).findByRole("alert")).toBeInTheDocument();
  });

  it("refuses to post an original with no postings and says why", async () => {
    hoisted.load.mockResolvedValue({ status: "ready", targets: [{ ...target("e1", "7"), postings: [] }] });
    const { user, form, submit } = await fill();
    await user.click(submit);
    expect(hoisted.post).not.toHaveBeenCalled();
    expect(await within(form).findByText(/postings are incomplete/)).toBeInTheDocument();
  });
});

describe("M2 correction form, signed out", () => {
  it("keeps the fixture and never calls the live read", async () => {
    hoisted.session = { status: "signed-out" };
    hoisted.load.mockReset();
    const { form } = await openForm();
    expect(within(form).getByRole("option", { name: /TXN-4281/ })).toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
  });

  it("still creates the local demo entry and never posts", async () => {
    hoisted.session = { status: "signed-out" };
    hoisted.load.mockReset();
    hoisted.post.mockReset();
    const { user, form } = await openForm();
    await user.type(within(form).getByLabelText(/Correction rationale/), "Wrong member was credited");
    await user.click(within(form).getByRole("button", { name: "Create compensating entry" }));
    expect(await within(form).findByText("Demo compensating entry created")).toBeInTheDocument();
    expect(within(form).getByText(/Demo only/)).toBeInTheDocument();
    expect(hoisted.post).not.toHaveBeenCalled();
  });

  it("follows the group switcher: the chosen group is the one that is read", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    hoisted.session = { status: "signed-in", userId: "user-1", email: "t@example.test", accessToken: "t" } as never;
    hoisted.load.mockResolvedValue({ status: "ready", targets: [target("e1", "7")] });
    const user = userEvent.setup();
    const storage = window.localStorage;
    storage.clear();
    render(
      <ActiveGroupProvider
        storage={storage}
        fetchGroups={async () => ({
          kind: "ok",
          userId: "user-1",
          groups: [
            { groupId: GROUP, name: "Bole Equb", role: "owner" },
            { groupId: OTHER, name: "Family Iddir", role: "treasurer" }
          ]
        })}
      >
        <M2Dashboard />
      </ActiveGroupProvider>
    );
    // Several groups and nothing chosen yet: the form is not opened on a guess.
    const switcher = await screen.findByRole("combobox", { name: "Group" });
    await user.click(screen.getAllByRole("button", { name: "Start a correction" })[0]);
    await waitFor(() => expect(hoisted.load).toHaveBeenCalled());
    expect(hoisted.load).toHaveBeenLastCalledWith({}, { groupId: null });

    await user.selectOptions(switcher, OTHER);
    await waitFor(() => expect(hoisted.load).toHaveBeenLastCalledWith({}, { groupId: OTHER }));
    await user.selectOptions(switcher, GROUP);
    await waitFor(() => expect(hoisted.load).toHaveBeenLastCalledWith({}, { groupId: GROUP }));
  });
});
