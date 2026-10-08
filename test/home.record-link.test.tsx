import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-out" } as { status: string; accessToken?: string; email?: string | null },
  load: vi.fn()
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientHome", () => ({ loadHomeLedger: hoisted.load }));
vi.mock("@/lib/db", () => ({ getSenedDatabase: () => ({}), isOfflineStorageAvailable: () => true }));
vi.mock("@/lib/db/notes", () => ({ saveSpokenNote: async () => ({ id: "note-1" }) }));
vi.mock("@/components/voice/VoiceModal", () => ({ VoiceModal: () => null }));

import SenedHome from "@/app/page";
import { translate } from "@/lib/i18n";

const GROUP = "22222222-2222-4222-8222-222222222222";
const SIGNED_IN = { status: "signed-in", accessToken: "tok", email: "t@example.com" };

function ready(role: "owner" | "treasurer" | "member") {
  return {
    status: "ready",
    summary: { potBalance: "350.00", contributions: [] },
    memberLabels: {},
    memberAttire: {},
    feedTruncated: false,
    groupId: GROUP,
    role,
    attributableMembers: []
  };
}

beforeEach(() => {
  hoisted.session = SIGNED_IN;
  hoisted.load.mockReset();
});

describe("home feed: quick entry to record a contribution", () => {
  it.each(["owner", "treasurer"] as const)("is offered to the group's %s and goes to the form on the ledger page", async (role) => {
    hoisted.load.mockResolvedValue(ready(role));
    render(<SenedHome />);
    const link = await screen.findByTestId("home-record-contribution");
    expect(link).toHaveAttribute("href", "/ledger#record-contribution");
    expect(link).toHaveTextContent(translate("am", "home.record.cta"));
  });

  it("is not offered to a plain member", async () => {
    hoisted.load.mockResolvedValue(ready("member"));
    render(<SenedHome />);
    await waitFor(() => expect(hoisted.load).toHaveBeenCalled());
    await screen.findByText("350", { exact: false });
    expect(screen.queryByTestId("home-record-contribution")).toBeNull();
  });

  it("is not offered to a signed-out visitor", () => {
    hoisted.session = { status: "signed-out" };
    render(<SenedHome />);
    expect(screen.queryByTestId("home-record-contribution")).toBeNull();
  });
});
