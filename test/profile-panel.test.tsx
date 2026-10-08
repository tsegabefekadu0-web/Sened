import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({
  session: { status: "signed-in", accessToken: "jwt", email: "me@example.test", userId: "11111111-1111-4111-8111-111111111111" } as Record<string, unknown>
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => sessionMock.session }));

import { ProfilePanel } from "@/components/shell/ProfilePanel";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";
import { translate } from "@/lib/i18n";
import { pickTibebFrame } from "@/lib/memberAvatarStyle";

const GROUP = "22222222-2222-4222-8222-222222222222";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function deps(handler: Handler) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { fetchImpl, deps: { getToken: async () => "jwt", fetchImpl: fetchImpl as unknown as typeof fetch } };
}

const group = (attire = "none") => ({ groups: [{ groupId: GROUP, name: "Equb", role: "member", attire, userId: ME }] });

describe("ProfilePanel", () => {
  it("shows the three choices as one labelled radio group, none selected by default", async () => {
    const d = deps(() => respond(group()));
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Your avatar shawl" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /No shawl/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Gabi/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Netela/ })).not.toBeChecked();
    // Each option says in words what it draws, not only in colour.
    expect(screen.getByText(/White cotton shawl/)).toBeInTheDocument();
    expect(screen.getByText(/woven border/)).toBeInTheDocument();
  });

  it("previews the member's own avatar frame, and starts from the stored choice", async () => {
    const d = deps(() => respond(group("netela")));
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);

    await screen.findAllByRole("radio");
    expect(screen.getByRole("radio", { name: /Netela/ })).toBeChecked();
    const avatar = screen.getByTestId("member-avatar");
    expect(avatar).toHaveAttribute("data-attire", "netela");
    expect(avatar).toHaveAttribute("data-frame", pickTibebFrame(ME));
    expect(screen.getByRole("img", { name: "You — wearing a netela" })).toBeInTheDocument();
  });

  it("saves a choice to the route with the group and value only, and says so", async () => {
    const user = userEvent.setup();
    const d = deps((url, init) =>
      url === "/api/my-groups" ? respond(group()) : respond({ groupId: GROUP, attire: JSON.parse(init!.body as string).attire, changed: true })
    );
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);
    await screen.findAllByRole("radio");

    await user.click(screen.getByRole("radio", { name: /Gabi/ }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
    expect(screen.getByRole("radio", { name: /Gabi/ })).toBeChecked();
    expect(screen.getByTestId("member-avatar")).toHaveAttribute("data-attire", "gabi");
    const save = d.fetchImpl.mock.calls.find(([url]) => url === "/api/ledger/member-attire")!;
    expect(save[1]!.method).toBe("PUT");
    expect(JSON.parse(save[1]!.body as string)).toEqual({ groupId: GROUP, attire: "gabi" });
  });

  it("goes back to what is stored, and says so, when saving fails", async () => {
    const user = userEvent.setup();
    const d = deps((url) => (url === "/api/my-groups" ? respond(group("gabi")) : respond({ error: "x" }, 502)));
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);
    await screen.findAllByRole("radio");

    await user.click(screen.getByRole("radio", { name: /Netela/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save. Your choice was not changed."));
    expect(screen.getByRole("radio", { name: /Gabi/ })).toBeChecked();
    expect(screen.getByTestId("member-avatar")).toHaveAttribute("data-attire", "gabi");
  });

  it("does not save when the same choice is clicked again", async () => {
    const user = userEvent.setup();
    const d = deps(() => respond(group()));
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);
    await screen.findAllByRole("radio");
    await user.click(screen.getByRole("radio", { name: /No shawl/ }));
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no group", () => respond({ groups: [] }), "profile.noGroup"],
    ["several groups and none chosen", () => respond({ groups: [group().groups[0], { ...group().groups[0], groupId: OTHER }] }), "profile.chooseGroup"],
    ["an ended session", () => respond({}, 401), "profile.unauthorized"],
    ["a server error", () => respond({}, 502), "profile.error"]
  ] as const)("shows an honest notice and no choices for %s", async (_name, handler, key) => {
    const d = deps(handler);
    render(<ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />);
    expect(await screen.findByText(translate("en", key))).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("sends nothing and offers no choices when there is no session", async () => {
    const fetchImpl = vi.fn();
    render(
      <ProfilePanel
        locale="en"
        onBack={() => undefined}
        deps={{ getToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch }}
      />
    );
    expect(await screen.findByText(translate("en", "profile.unauthorized"))).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("renders in Amharic with the same structure", async () => {
    const d = deps(() => respond(group()));
    render(<ProfilePanel locale="am" onBack={() => undefined} deps={d.deps} />);
    expect(await screen.findAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("group", { name: translate("am", "profile.attire.legend") })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /ጋቢ/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /ነጠላ/ })).toBeInTheDocument();
  });

  it("has a way back", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const d = deps(() => respond(group()));
    render(<ProfilePanel locale="en" onBack={onBack} deps={d.deps} />);
    await screen.findAllByRole("radio");
    await user.click(screen.getByRole("button", { name: translate("en", "tab.panels.back") }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("ProfilePanel with several groups", () => {
  const two = (attireA: string, attireB: string) => ({
    groups: [
      { groupId: GROUP, name: "Equb", role: "member", attire: attireA, userId: ME },
      { groupId: OTHER, name: "Iddir", role: "member", attire: attireB, userId: ME }
    ]
  });

  it("shows and saves the attire of the group chosen in the switcher, and nothing leaks between them", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const d = deps((url, init) =>
      url === "/api/my-groups"
        ? respond(two("gabi", "netela"))
        : respond({ groupId: JSON.parse(init!.body as string).groupId, attire: JSON.parse(init!.body as string).attire, changed: true })
    );
    render(
      <ActiveGroupProvider
        storage={window.localStorage}
        fetchGroups={async () => ({
          kind: "ok",
          userId: ME,
          groups: [
            { groupId: GROUP, name: "Equb", role: "member" },
            { groupId: OTHER, name: "Iddir", role: "member" }
          ]
        })}
      >
        <ProfilePanel locale="en" onBack={() => undefined} deps={d.deps} />
      </ActiveGroupProvider>
    );

    // Nothing is chosen yet: no attire is shown or saved on a guess.
    expect(await screen.findByText(translate("en", "profile.chooseGroup"))).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    const switcher = screen.getByRole("combobox", { name: "Group" });
    await user.selectOptions(switcher, GROUP);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gabi/ })).toBeChecked());

    await user.selectOptions(switcher, OTHER);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Netela/ })).toBeChecked());
    expect(screen.getByRole("radio", { name: /Gabi/ })).not.toBeChecked();

    await user.click(screen.getByRole("radio", { name: /No shawl/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
    const save = d.fetchImpl.mock.calls.filter(([url]) => url === "/api/ledger/member-attire").at(-1)!;
    expect(JSON.parse(save[1]!.body as string)).toEqual({ groupId: OTHER, attire: "none" });

    // Back to the first group: its own stored choice, not the one just saved elsewhere.
    await user.selectOptions(switcher, GROUP);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gabi/ })).toBeChecked());
  });
});
