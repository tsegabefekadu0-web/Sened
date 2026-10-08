import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in", accessToken: "t", email: "o@example.test" } as Record<string, unknown>,
  api: {
    loadMyGroup: vi.fn(),
    loadMembers: vi.fn(),
    loadInvites: vi.fn(),
    createInviteLink: vi.fn(),
    revokeInviteLink: vi.fn(),
    setTreasurer: vi.fn()
  }
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientInvites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger/clientInvites")>()),
  ...hoisted.api
}));

import { GroupMembersPanel } from "@/components/ledger/GroupMembersPanel";
import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";

const GROUP = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "d".repeat(64);

const ownerList: Array<{ userId: string; role: string; joinedAt: string; email: string | null }> = [
  { userId: OWNER, role: "owner", joinedAt: "2026-10-01T00:00:00Z", email: "o@example.test" },
  { userId: MEMBER, role: "member", joinedAt: "2026-10-02T00:00:00Z", email: "m@example.test" }
];
const memberList = ownerList.map((entry) => ({ ...entry, email: null }));

function asRole(role: "owner" | "treasurer" | "member", members = ownerList) {
  hoisted.api.loadMyGroup.mockResolvedValue({ status: "ready", groupId: GROUP, name: "Equb", role });
  hoisted.api.loadMembers.mockResolvedValue({ status: "ready", members });
  hoisted.api.loadInvites.mockResolvedValue({ status: "ready", invites: [] });
}

beforeEach(() => {
  hoisted.session = { status: "signed-in", accessToken: "t", email: "o@example.test" };
  for (const fn of Object.values(hoisted.api)) fn.mockReset();
  asRole("owner");
});

describe("GroupMembersPanel", () => {
  it("a plain member sees members and roles but no owner controls", async () => {
    asRole("member", memberList);
    render(<GroupMembersPanel locale="en" />);

    const list = await screen.findByTestId("member-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Owner");
    expect(list).toHaveTextContent("Member 33333333");
    expect(screen.queryByRole("button", { name: "Create invite link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make treasurer" })).toBeNull();
    expect(hoisted.api.loadInvites).not.toHaveBeenCalled();
  });

  it("a treasurer gets no owner controls either", async () => {
    asRole("treasurer", memberList);
    render(<GroupMembersPanel locale="en" />);
    await screen.findByTestId("member-list");
    expect(screen.queryByRole("button", { name: "Create invite link" })).toBeNull();
  });

  it("the owner can create an invite, see the link once, and copy it", async () => {
    hoisted.api.createInviteLink.mockResolvedValue({
      status: "created",
      inviteId: "i1",
      token: TOKEN,
      expiresAt: "2026-10-08T00:00:00Z",
      maxUses: 3
    });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<GroupMembersPanel locale="en" />);
    await screen.findByTestId("member-list");

    await user.clear(screen.getByLabelText("Maximum uses"));
    await user.type(screen.getByLabelText("Maximum uses"), "3");
    await user.selectOptions(screen.getByLabelText("Link expires after"), "24");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));

    expect(hoisted.api.createInviteLink).toHaveBeenCalledWith({ groupId: GROUP, expiresInHours: 24, maxUses: 3 });
    const link = (await screen.findByLabelText("Invite link")) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/join#token=${TOKEN}`);
    const card = screen.getByTestId("created-invite");
    expect(card).toHaveTextContent("0 of 3 uses");
    expect(card).toHaveTextContent("Expires");

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(link.value);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says so when copying fails", async () => {
    hoisted.api.createInviteLink.mockResolvedValue({
      status: "created", inviteId: "i1", token: TOKEN, expiresAt: "2026-10-08T00:00:00Z", maxUses: 1
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true
    });
    render(<GroupMembersPanel locale="en" />);
    await screen.findByTestId("member-list");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
  });

  it("shows a create failure", async () => {
    hoisted.api.createInviteLink.mockResolvedValue({ status: "forbidden" });
    const user = userEvent.setup();
    render(<GroupMembersPanel locale="en" />);
    await screen.findByTestId("member-list");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByText("The invite link could not be created. Try again.")).toBeInTheDocument();
  });

  it("lists active invites and revokes one", async () => {
    hoisted.api.loadInvites.mockResolvedValue({
      status: "ready",
      invites: [
        { inviteId: "i1", expiresAt: "2026-10-08T00:00:00Z", maxUses: 5, useCount: 2, status: "active" },
        { inviteId: "i2", expiresAt: "2026-10-08T00:00:00Z", maxUses: 1, useCount: 1, status: "used_up" }
      ]
    });
    hoisted.api.revokeInviteLink.mockResolvedValue({ status: "ok" });
    const user = userEvent.setup();
    render(<GroupMembersPanel locale="en" />);

    const list = await screen.findByTestId("invite-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("2 of 5 uses");

    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    expect(hoisted.api.revokeInviteLink).toHaveBeenCalledWith("i1");
    await waitFor(() => expect(screen.queryByTestId("invite-list")).toBeNull());
    expect(screen.getByText(/No active invite links/)).toBeInTheDocument();
  });

  it("the owner toggles the treasurer role per member, never on the owner", async () => {
    hoisted.api.setTreasurer.mockResolvedValue({ status: "ok" });
    const user = userEvent.setup();
    render(<GroupMembersPanel locale="en" />);
    await screen.findByTestId("member-list");

    expect(screen.getAllByRole("button", { name: "Make treasurer" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Make treasurer" }));

    expect(hoisted.api.setTreasurer).toHaveBeenCalledWith({ groupId: GROUP, userId: MEMBER, role: "treasurer" });
  });

  it("offers to remove the role from a treasurer", async () => {
    asRole("owner", [ownerList[0], { ...ownerList[1], role: "treasurer" }]);
    hoisted.api.setTreasurer.mockResolvedValue({ status: "ok" });
    const user = userEvent.setup();
    render(<GroupMembersPanel locale="en" />);
    await user.click(await screen.findByRole("button", { name: "Remove treasurer" }));
    expect(hoisted.api.setTreasurer).toHaveBeenCalledWith({ groupId: GROUP, userId: MEMBER, role: "member" });
  });

  it("shows a role change failure", async () => {
    hoisted.api.setTreasurer.mockResolvedValue({ status: "forbidden" });
    const user = userEvent.setup();
    render(<GroupMembersPanel locale="en" />);
    await user.click(await screen.findByRole("button", { name: "Make treasurer" }));
    expect(await screen.findByText("The role could not be changed. Try again.")).toBeInTheDocument();
  });

  it("covers the non-list states: signed out, no group, several groups, load error", async () => {
    hoisted.session = { status: "signed-out" };
    const out = render(<GroupMembersPanel locale="en" />);
    expect(screen.getByText("Sign in to see the members of your group.")).toBeInTheDocument();
    expect(hoisted.api.loadMyGroup).not.toHaveBeenCalled();
    out.unmount();

    hoisted.session = { status: "signed-in" };
    hoisted.api.loadMyGroup.mockResolvedValue({ status: "no-group" });
    const none = render(<GroupMembersPanel locale="en" />);
    expect(await screen.findByText(/not in a group yet/)).toBeInTheDocument();
    none.unmount();

    hoisted.api.loadMyGroup.mockResolvedValue({ status: "choose-group" });
    const many = render(<GroupMembersPanel locale="en" />);
    expect(await screen.findByText(/more than one group. Choose one with the group switcher/)).toBeInTheDocument();
    many.unmount();

    hoisted.api.loadMyGroup.mockResolvedValue({ status: "ready", groupId: GROUP, name: "E", role: "member" });
    hoisted.api.loadMembers.mockResolvedValue({ status: "error" });
    render(<GroupMembersPanel locale="en" />);
    expect(await screen.findByText("The member list could not be loaded. Try again later.")).toBeInTheDocument();
  });

  it("renders in Amharic", async () => {
    render(<GroupMembersPanel locale="am" />);
    expect(await screen.findByRole("heading", { name: "የቡድን አባላት" })).toBeInTheDocument();
  });

  it("follows the group switcher: each group's members and invites are read when it is chosen", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    hoisted.session = { status: "signed-in", accessToken: "t", email: "o@example.test", userId: OWNER };
    hoisted.api.loadMyGroup.mockImplementation(async (_deps: unknown, options?: { groupId?: string | null }) =>
      options?.groupId === OTHER
        ? { status: "ready", groupId: OTHER, name: "Iddir", role: "member" }
        : options?.groupId === GROUP
          ? { status: "ready", groupId: GROUP, name: "Equb", role: "owner" }
          : { status: "choose-group" }
    );
    window.localStorage.clear();
    const user = userEvent.setup();
    render(
      <ActiveGroupProvider
        storage={window.localStorage}
        fetchGroups={async () => ({
          kind: "ok",
          userId: OWNER,
          groups: [
            { groupId: GROUP, name: "Equb", role: "owner" },
            { groupId: OTHER, name: "Iddir", role: "member" }
          ]
        })}
      >
        <GroupSwitcher locale="en" />
        <GroupMembersPanel locale="en" />
      </ActiveGroupProvider>
    );
    // Several groups and none chosen: no members are loaded on a guess.
    expect(await screen.findByText(/Choose one with the group switcher/, { selector: "p[role='status'].text-base" })).toBeInTheDocument();
    expect(hoisted.api.loadMembers).not.toHaveBeenCalled();

    const switcher = screen.getByRole("combobox", { name: "Group" });
    await user.selectOptions(switcher, GROUP);
    await screen.findByTestId("member-list");
    expect(hoisted.api.loadMembers).toHaveBeenLastCalledWith(GROUP);
    expect(hoisted.api.loadInvites).toHaveBeenLastCalledWith(GROUP);
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeInTheDocument();

    // The other group: a plain member there, so the owner controls go away.
    hoisted.api.loadInvites.mockClear();
    await user.selectOptions(switcher, OTHER);
    await waitFor(() => expect(hoisted.api.loadMembers).toHaveBeenLastCalledWith(OTHER));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create invite link" })).toBeNull());
    expect(hoisted.api.loadInvites).not.toHaveBeenCalled();
  });
});
