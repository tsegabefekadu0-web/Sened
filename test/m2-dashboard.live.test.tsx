import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in" } as { status: string },
  load: vi.fn()
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientRead", () => ({ loadCorrectionTargets: hoisted.load }));

import { M2Dashboard } from "@/components/ledger/m2-dashboard";

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
      targets: [{ id: "e1", type: "contribution", sequence: "7", amount: "25.00", direction: "inbound", reference: "#7" }]
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
      "multiple-groups",
      "You belong to more than one ledger group. Choosing between groups is not supported here yet, so no live entries are shown."
    ],
    ["error", "We could not load your ledger entries. Try again in a moment."]
  ])("shows the %s state", async (status, message) => {
    hoisted.load.mockResolvedValue({ status });
    const { form } = await openForm();
    expect(await within(form).findByText(message)).toBeInTheDocument();
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

describe("M2 correction form, signed out", () => {
  it("keeps the fixture and never calls the live read", async () => {
    hoisted.session = { status: "signed-out" };
    hoisted.load.mockReset();
    const { form } = await openForm();
    expect(within(form).getByRole("option", { name: /TXN-4281/ })).toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
  });
});
