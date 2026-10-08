import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in", accessToken: "t", email: "t@example.test", userId: "u1" } as Record<string, unknown>
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));

import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { Header } from "@/components/shell/Header";
import { readRemembered, type FetchedGroups, type GroupOption } from "@/lib/groups/activeGroup";
import { ActiveGroupProvider, useActiveGroup } from "@/lib/groups/useActiveGroup";
import { translate } from "@/lib/i18n";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GA: GroupOption = { groupId: A, name: "Bole Equb", role: "owner" };
const GB: GroupOption = { groupId: B, name: "Family Iddir", role: "member" };

const ok = (groups: GroupOption[]): (() => Promise<FetchedGroups>) => async () => ({ kind: "ok", groups, userId: "u1" });

function Probe() {
  const { activeGroupId, status } = useActiveGroup();
  return <div data-testid="probe">{`${status}:${activeGroupId ?? "none"}`}</div>;
}

function mount(groups: GroupOption[], locale: "en" | "am" = "en", tone: "dark" | "light" = "light") {
  return render(
    <ActiveGroupProvider fetchGroups={ok(groups)} storage={window.localStorage}>
      <GroupSwitcher locale={locale} tone={tone} />
      <Probe />
    </ActiveGroupProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  hoisted.session = { status: "signed-in", accessToken: "t", email: "t@example.test", userId: "u1" };
});

describe("GroupSwitcher", () => {
  it("renders nothing without a provider, while loading, and for a user with no group", async () => {
    const alone = render(<GroupSwitcher locale="en" />);
    expect(alone.container).toBeEmptyDOMElement();
    alone.unmount();

    const none = mount([]);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("no-group:none"));
    expect(screen.queryByTestId("group-switcher")).toBeNull();
    none.unmount();

    hoisted.session = { status: "signed-out" };
    mount([GA, GB]);
    expect(screen.queryByTestId("group-switcher")).toBeNull();
  });

  it("with one group shows its name and the user's role as text, with nothing to choose", async () => {
    mount([GA]);
    expect(await screen.findByText("Group: Bole Equb, Owner")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("probe")).toHaveTextContent(`ready:${A}`);
  });

  it("with several groups and no choice shows a labelled select with a placeholder and says why", async () => {
    mount([GA, GB]);
    const select = await screen.findByRole("combobox", { name: "Group" });
    expect(select).toHaveValue("");
    expect(within(select).getByRole("option", { name: "Choose a group" })).toBeDisabled();
    expect(within(select).getByRole("option", { name: "Bole Equb · Owner" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Family Iddir · Member" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You are in more than one group. Choose one to continue.");
    expect(select).toHaveAccessibleDescription("You are in more than one group. Choose one to continue.");
    expect(screen.getByTestId("probe")).toHaveTextContent("ready:none");
  });

  it("is reachable and operable from the keyboard and changes the active group everywhere", async () => {
    const user = userEvent.setup();
    mount([GA, GB]);
    const select = await screen.findByRole("combobox", { name: "Group" });
    // The native select is the only tab stop and is named by its visible label.
    await user.tab();
    expect(select).toHaveFocus();

    // Choosing an option is the platform's own keyboard/picker behaviour; user-event
    // models it as selecting the option on the focused select.
    await user.selectOptions(select, A);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(`ready:${A}`));
    expect(select).toHaveValue(A);
    expect(select).toHaveFocus();
    expect(screen.queryByRole("status")).toBeNull();
    expect(readRemembered("u1", window.localStorage)).toBe(A);

    await user.selectOptions(select, B);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(`ready:${B}`));
    expect(readRemembered("u1", window.localStorage)).toBe(B);
  });

  it("two switchers on one page stay in step", async () => {
    const user = userEvent.setup();
    render(
      <ActiveGroupProvider fetchGroups={ok([GA, GB])} storage={window.localStorage}>
        <GroupSwitcher locale="en" />
        <GroupSwitcher locale="en" tone="dark" />
      </ActiveGroupProvider>
    );
    const [first, second] = await screen.findAllByRole("combobox", { name: "Group" });
    await user.selectOptions(first, B);
    expect(second).toHaveValue(B);
  });

  it("restores the remembered group and tells a duplicate name apart by a piece of the id", async () => {
    window.localStorage.setItem("sened.activeGroup.v1.u1", B);
    mount([GA, { ...GB, name: "Bole Equb" }]);
    const select = await screen.findByRole("combobox", { name: "Group" });
    expect(select).toHaveValue(B);
    expect(within(select).getByRole("option", { name: "Bole Equb (aaaaaaaa) · Owner" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Bole Equb (bbbbbbbb) · Member" })).toBeInTheDocument();
  });

  it("falls back to a short id for an unnamed group instead of inventing a name", async () => {
    mount([{ ...GA, name: "" }, GB]);
    const select = await screen.findByRole("combobox", { name: "Group" });
    expect(within(select).getByRole("option", { name: "Group aaaaaaaa · Owner" })).toBeInTheDocument();
  });

  it("is fully translated in Amharic", async () => {
    mount([GA, GB], "am");
    const select = await screen.findByRole("combobox", { name: translate("am", "groups.switcher.label") });
    expect(within(select).getByRole("option", { name: translate("am", "groups.switcher.choose") })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Bole Equb · ባለቤት" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Family Iddir · አባል" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(translate("am", "groups.switcher.chooseHint"));
  });

  it("has Amharic text for every switcher key", () => {
    for (const key of [
      "groups.switcher.label",
      "groups.switcher.choose",
      "groups.switcher.chooseHint",
      "groups.switcher.single",
      "groups.switcher.stale",
      "groups.unnamed",
      "groups.role.owner",
      "groups.role.treasurer",
      "groups.role.member"
    ] as const) {
      expect(translate("am", key, { name: "x", role: "y", id: "z" })).not.toBe(translate("en", key, { name: "x", role: "y", id: "z" }));
    }
  });

  it("goes away on sign-out and does not carry the choice to the next user", async () => {
    const user = userEvent.setup();
    const view = mount([GA, GB]);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Group" }), B);
    expect(readRemembered("u1", window.localStorage)).toBe(B);

    hoisted.session = { status: "signed-out" };
    view.rerender(
      <ActiveGroupProvider fetchGroups={ok([GA, GB])} storage={window.localStorage}>
        <GroupSwitcher locale="en" />
        <Probe />
      </ActiveGroupProvider>
    );
    await waitFor(() => expect(screen.queryByTestId("group-switcher")).toBeNull());
    expect(screen.getByTestId("probe")).toHaveTextContent("idle:none");
    expect(readRemembered("u1", window.localStorage)).toBeNull();

    hoisted.session = { status: "signed-in", accessToken: "t2", email: "o@example.test", userId: "u2" };
    await act(async () => {
      view.rerender(
        <ActiveGroupProvider fetchGroups={ok([GA, GB])} storage={window.localStorage}>
          <GroupSwitcher locale="en" />
          <Probe />
        </ActiveGroupProvider>
      );
    });
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveValue("");
    expect(screen.getByTestId("probe")).toHaveTextContent("ready:none");
  });
});

describe("Header", () => {
  it("carries the switcher at phone width without a fixed-width control", async () => {
    render(
      <ActiveGroupProvider fetchGroups={ok([GA, GB])} storage={window.localStorage}>
        <Header onOpenDigest={() => undefined} locale="en" />
      </ActiveGroupProvider>
    );
    const select = await screen.findByRole("combobox", { name: "Group" });
    expect(select.className).toContain("w-full");
    expect(select.className).toContain("min-h-12");
  });
});
