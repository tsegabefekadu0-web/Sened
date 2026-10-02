import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-in", accessToken: "t", email: "a@b.co" } as Record<string, unknown>,
  redeem: vi.fn()
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientInvites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger/clientInvites")>()),
  redeemInviteToken: hoisted.redeem
}));

import { JoinPanel } from "@/components/ledger/JoinPanel";

const TOKEN = "c".repeat(64);

function openWith(hash: string) {
  window.history.replaceState(null, "", "/join" + hash);
}

beforeEach(() => {
  hoisted.session = { status: "signed-in", accessToken: "t", email: "a@b.co" };
  hoisted.redeem.mockReset();
  window.localStorage.clear();
  openWith("");
});

describe("JoinPanel", () => {
  it.each([
    ["joined", { status: "joined", groupId: "g" }, "You have joined the group."],
    ["already_member", { status: "already_member", groupId: "g" }, "You are already a member of this group."],
    ["expired", { status: "expired" }, "This invite link has expired. Ask the group owner for a new one."],
    ["exhausted", { status: "exhausted" }, "This invite link has already been used the maximum number of times."],
    ["revoked", { status: "revoked" }, "The group owner has revoked this invite link."],
    ["invalid", { status: "invalid" }, "This invite link is not valid."],
    ["error", { status: "error" }, "Something went wrong. Try again in a moment."]
  ])("shows the %s outcome and links to /ledger", async (key, outcome, copy) => {
    hoisted.redeem.mockResolvedValue(outcome);
    openWith(`#token=${TOKEN}`);

    render(<JoinPanel initialLocale="en" />);

    const result = await screen.findByTestId("join-outcome");
    expect(result).toHaveTextContent(copy);
    expect(result).toHaveAttribute("data-outcome", key);
    expect(screen.getByRole("link", { name: "Open the ledger" })).toHaveAttribute("href", "/ledger");
    expect(hoisted.redeem).toHaveBeenCalledTimes(1);
    expect(hoisted.redeem).toHaveBeenCalledWith(TOKEN);
  });

  it("removes the token from the address bar once it has been read", async () => {
    hoisted.redeem.mockResolvedValue({ status: "joined", groupId: "g" });
    openWith(`#token=${TOKEN}`);

    render(<JoinPanel initialLocale="en" />);
    await screen.findByTestId("join-outcome");

    expect(window.location.hash).toBe("");
  });

  it("offers a retry when rate limited and redeems again", async () => {
    hoisted.redeem
      .mockResolvedValueOnce({ status: "rate-limited" })
      .mockResolvedValueOnce({ status: "joined", groupId: "g" });
    openWith(`#token=${TOKEN}`);

    render(<JoinPanel initialLocale="en" />);
    await screen.findByText("Too many attempts. Wait a minute and try again.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("You have joined the group.")).toBeInTheDocument();
    expect(hoisted.redeem).toHaveBeenCalledTimes(2);
  });

  it("signed out: parks the token, links to /sign-in, and does not redeem", async () => {
    hoisted.session = { status: "signed-out" };
    openWith(`#token=${TOKEN}`);

    render(<JoinPanel initialLocale="en" />);

    expect(await screen.findByRole("link", { name: "Sign in to continue" })).toHaveAttribute("href", "/sign-in");
    await waitFor(() => expect(window.localStorage.getItem("sened.pendingInvite")).toBe(TOKEN));
    expect(hoisted.redeem).not.toHaveBeenCalled();
  });

  it("after sign-in it picks the parked token back up, redeems and clears it", async () => {
    window.localStorage.setItem("sened.pendingInvite", TOKEN);
    hoisted.redeem.mockResolvedValue({ status: "joined", groupId: "g" });

    render(<JoinPanel initialLocale="en" />);

    expect(await screen.findByText("You have joined the group.")).toBeInTheDocument();
    expect(hoisted.redeem).toHaveBeenCalledWith(TOKEN);
    expect(window.localStorage.getItem("sened.pendingInvite")).toBeNull();
  });

  it("says so when there is no token, and when sign-in is not configured", async () => {
    render(<JoinPanel initialLocale="en" />);
    expect(await screen.findByText("This page needs an invite link. Open the full link you were sent.")).toBeInTheDocument();
    expect(hoisted.redeem).not.toHaveBeenCalled();
  });

  it("is not configured when there is no Supabase", async () => {
    hoisted.session = { status: "unconfigured" };
    openWith(`#token=${TOKEN}`);
    render(<JoinPanel initialLocale="en" />);
    expect(await screen.findByText(/Sign-in is not configured in this build/)).toBeInTheDocument();
  });

  it("renders in Amharic", async () => {
    hoisted.redeem.mockResolvedValue({ status: "joined", groupId: "g" });
    openWith(`#token=${TOKEN}`);
    render(<JoinPanel initialLocale="am" />);
    expect(await screen.findByText("ቡድኑን ተቀላቅለዋል።")).toBeInTheDocument();
  });
});
