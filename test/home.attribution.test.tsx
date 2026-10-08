import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-out" } as { status: string; accessToken?: string; email?: string | null },
  load: vi.fn(),
  attribute: vi.fn(),
  supersede: vi.fn()
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientHome", () => ({ loadHomeLedger: hoisted.load }));
vi.mock("@/lib/ledger/clientAttribution", () => ({ attributePayer: hoisted.attribute, supersedePayer: hoisted.supersede }));
vi.mock("@/lib/db", () => ({ getSenedDatabase: () => ({}), isOfflineStorageAvailable: () => true }));
vi.mock("@/lib/db/notes", () => ({ saveSpokenNote: async () => ({ id: "note-1" }) }));
vi.mock("@/components/voice/VoiceModal", () => ({ VoiceModal: () => null }));

import SenedHome from "@/app/page";
import { translate, type MessageKey } from "@/lib/i18n";

const am = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("am", key, vars);
const SIGNED_IN = { status: "signed-in", accessToken: "tok", email: "t@example.com" };

const GROUP = "22222222-2222-4222-8222-222222222222";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function member(userId: string, email: string | null, role: "owner" | "treasurer" | "member" = "member") {
  return { userId, role, joinedAt: "2026-09-01T00:00:00Z", email, attire: "none" as const };
}

const treasurerRecord = {
  source: "treasurer",
  memberUserId: PAYER,
  recordedBy: TREASURER,
  recordedAt: "2026-10-10T09:30:00.000Z",
  cycleId: null,
  round: null,
  revision: 1,
  reason: null
};

function ready(
  role: "owner" | "treasurer" | "member",
  contributions: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) {
  return {
    status: "ready",
    summary: {
      potBalance: "350.00",
      contributions: contributions.map((c) => ({ provenance: null, attribution: null, occurredAt: "2026-10-01T09:00:00.000Z", ...c }))
    },
    memberLabels: { [PAYER]: "berhan@example.test" },
    memberAttire: {},
    feedTruncated: false,
    groupId: GROUP,
    role,
    attributableMembers: role === "member" ? [] : [member(PAYER, "berhan@example.test"), member(OTHER, null)],
    ...extra
  };
}

beforeEach(() => {
  hoisted.session = SIGNED_IN;
  hoisted.load.mockReset();
  hoisted.attribute.mockReset().mockResolvedValue({ status: "ok", replayed: false, revision: 1 });
  hoisted.supersede.mockReset().mockResolvedValue({ status: "ok", replayed: false, revision: 2 });
});

describe("home feed: who paid a cash contribution", () => {
  it("shows a treasurer-attributed row as paid by that member, recorded by the treasurer, and never as verified", async () => {
    hoisted.load.mockResolvedValue(
      ready("member", [
        { id: "e2", sequence: "8", amount: "250.00", attribution: treasurerRecord },
        { id: "e1", sequence: "7", amount: "100.00" }
      ])
    );
    render(<SenedHome />);
    await screen.findByText("350.00");

    const line = screen.getByTestId("feed-paid-by-treasurer");
    expect(line).toHaveTextContent(`${am("shell.feed.paidBy")}: berhan@example.test · ${am("shell.feed.recordedByTreasurer")}`);
    // Both rows are plain "recorded in ledger": no verified badge anywhere.
    expect(screen.getAllByText(am("shell.feed.recorded"))).toHaveLength(2);
    expect(screen.queryByTestId("feed-paid-by")).toBeNull();
    expect(screen.queryByText(am("shell.feed.verifiedWord"))).toBeNull();
  });

  it("falls back to the anonymous label when the members could not be read", async () => {
    hoisted.load.mockResolvedValue(ready("member", [{ id: "e2", sequence: "8", amount: "250.00", attribution: treasurerRecord }], { memberLabels: {} }));
    render(<SenedHome />);
    await screen.findByText("350.00");
    expect(screen.getByTestId("feed-paid-by-treasurer")).toHaveTextContent(am("members.anonymous", { id: PAYER.slice(0, 8) }));
  });

  it("keeps a bank-verified row verified, even if a treasurer record also came with it", async () => {
    hoisted.load.mockResolvedValue(
      ready("member", [
        {
          id: "e2",
          sequence: "8",
          amount: "250.00",
          provenance: {
            provider: "cbe",
            verifiedAt: "2026-10-10T09:00:05.000Z",
            verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            memberUserId: PAYER
          },
          attribution: { ...treasurerRecord, source: "bank_verification" }
        }
      ])
    );
    render(<SenedHome />);
    await screen.findByText("350.00");
    expect(screen.getByTestId("feed-paid-by")).toHaveTextContent("berhan@example.test");
    expect(screen.queryByTestId("feed-paid-by-treasurer")).toBeNull();
  });

  it("offers a plain member no way to record a payer", async () => {
    const user = userEvent.setup();
    hoisted.load.mockResolvedValue(ready("member", [{ id: "e1", sequence: "7", amount: "100.00" }]));
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 7 })));
    expect(screen.queryByTestId("feed-attribute-payer")).toBeNull();
  });

  it("offers the treasurer the action, records the payer for the entry in the signed-in group, and re-reads the ledger", async () => {
    const user = userEvent.setup();
    hoisted.load.mockResolvedValue(ready("treasurer", [{ id: "e1", sequence: "7", amount: "100.00" }]));
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 7 })));

    const select = screen.getByTestId("feed-attribute-member") as HTMLSelectElement;
    // Members are named the way the members screen names them.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      am("shell.feed.attribute.choose"),
      "berhan@example.test",
      am("members.anonymous", { id: OTHER.slice(0, 8) })
    ]);
    await user.selectOptions(select, PAYER);
    await user.click(screen.getByTestId("feed-attribute-submit"));

    expect(hoisted.attribute).toHaveBeenCalledWith({ groupId: GROUP, entryId: "e1", memberUserId: PAYER });
    expect(hoisted.supersede).not.toHaveBeenCalled();
    await waitFor(() => expect(hoisted.load).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("feed-attribute-message")).toHaveTextContent(am("shell.feed.attribute.done"));
  });

  it("corrects a recorded payer through the superseding call, with the reason", async () => {
    const user = userEvent.setup();
    hoisted.load.mockResolvedValue(ready("owner", [{ id: "e2", sequence: "8", amount: "250.00", attribution: treasurerRecord }]));
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 8 })));
    await user.selectOptions(screen.getByTestId("feed-attribute-member"), OTHER);
    await user.type(screen.getByTestId("feed-attribute-reason"), "The receipt book names Chaltu");
    await user.click(screen.getByTestId("feed-attribute-submit"));

    expect(hoisted.supersede).toHaveBeenCalledWith({
      groupId: GROUP,
      entryId: "e2",
      memberUserId: OTHER,
      reason: "The receipt book names Chaltu"
    });
    expect(hoisted.attribute).not.toHaveBeenCalled();
  });

  it("shows the treasurer's channel and note on the home feed row, as text", async () => {
    hoisted.load.mockResolvedValue(
      ready("member", [
        {
          id: "e2",
          sequence: "8",
          amount: "250.00",
          attribution: { ...treasurerRecord, channel: "telebirr", note: "<i>from his wife's phone</i>" }
        }
      ])
    );
    render(<SenedHome />);
    await screen.findByText("350.00");
    expect(screen.getByTestId("feed-channel")).toHaveTextContent(am("shell.feed.channelTelebirr"));
    expect(screen.getByTestId("feed-note")).toHaveTextContent("<i>from his wife's phone</i>");
    expect(screen.getByTestId("feed-note").querySelector("i")).toBeNull();
    // Still the treasurer's own record, never a bank verification.
    expect(screen.queryByText(am("shell.feed.verifiedWord"))).toBeNull();
  });

  it("records a first payer with a channel and note through the attribute call", async () => {
    const user = userEvent.setup();
    hoisted.load.mockResolvedValue(ready("treasurer", [{ id: "e1", sequence: "7", amount: "100.00" }]));
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 7 })));
    await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "cash");
    await user.type(screen.getByTestId("feed-attribute-note"), "Hand to hand");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(hoisted.attribute).toHaveBeenCalledWith({ groupId: GROUP, entryId: "e1", memberUserId: PAYER, channel: "cash", note: "Hand to hand" });
  });

  it("corrects only the channel through the superseding call: absent keeps the note, null clears", async () => {
    const user = userEvent.setup();
    hoisted.load.mockResolvedValue(
      ready("owner", [{ id: "e2", sequence: "8", amount: "250.00", attribution: { ...treasurerRecord, channel: "cash", note: "Hand to hand" } }])
    );
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 8 })));
    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "cbe");
    await user.type(screen.getByTestId("feed-attribute-reason"), "It was a CBE Birr transfer");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(hoisted.supersede).toHaveBeenCalledWith({
      groupId: GROUP,
      entryId: "e2",
      memberUserId: PAYER,
      reason: "It was a CBE Birr transfer",
      channel: "cbe"
    });

    hoisted.supersede.mockClear();
    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "");
    await user.clear(screen.getByTestId("feed-attribute-note"));
    await user.clear(screen.getByTestId("feed-attribute-reason"));
    await user.type(screen.getByTestId("feed-attribute-reason"), "Removing what was recorded");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(hoisted.supersede).toHaveBeenCalledWith({
      groupId: GROUP,
      entryId: "e2",
      memberUserId: PAYER,
      reason: "Removing what was recorded",
      channel: null,
      note: null
    });
  });

  it("does not re-read the ledger when the record was refused, and says why", async () => {
    const user = userEvent.setup();
    hoisted.attribute.mockResolvedValue({ status: "refused", code: "bank_verified" });
    hoisted.load.mockResolvedValue(ready("treasurer", [{ id: "e1", sequence: "7", amount: "100.00" }]));
    render(<SenedHome />);
    await screen.findByText("350.00");
    await user.click(screen.getByText(am("shell.feed.ledgerContribution", { sequence: 7 })));
    await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(await screen.findByTestId("feed-attribute-message")).toHaveTextContent(am("shell.feed.attribute.error.bank_verified"));
    expect(hoisted.load).toHaveBeenCalledTimes(1);
  });
});
