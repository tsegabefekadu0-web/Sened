import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-out" } as { status: string; accessToken?: string; email?: string | null },
  load: vi.fn(),
  modalProps: [] as Array<Record<string, unknown>>
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/lib/ledger/clientHome", () => ({ loadHomeLedger: hoisted.load }));
vi.mock("@/lib/db", () => ({ getSenedDatabase: () => ({}), isOfflineStorageAvailable: () => true }));
vi.mock("@/lib/db/notes", () => ({ saveSpokenNote: async () => ({ id: "note-1" }) }));
vi.mock("@/components/voice/VoiceModal", () => ({
  VoiceModal: (props: Record<string, unknown>) => {
    hoisted.modalProps.push(props);
    return null;
  }
}));

import SenedHome from "@/app/page";
import { translate, type MessageKey } from "@/lib/i18n";

const am = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("am", key, vars);
const SIGNED_IN = { status: "signed-in", accessToken: "tok", email: "t@example.com" };

type TestContribution = {
  id: string;
  sequence: string;
  amount: string;
  provenance?: { provider: "telebirr" | "cbe" | "awash"; verifiedAt: string; verificationId: string; memberUserId: string };
};

function ready(
  potBalance: string,
  contributions: TestContribution[],
  memberLabels: Record<string, string | null> = {}
) {
  return {
    status: "ready",
    summary: {
      potBalance,
      contributions: contributions.map((c) => ({ provenance: null, ...c, occurredAt: "2026-09-01T09:00:00.000Z" }))
    },
    memberLabels
  };
}

async function digestText(): Promise<string> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: new RegExp(`${am("shell.header.listen")}$`) }));
  return screen.getByLabelText(am("audio.captionLabel")).textContent ?? "";
}

describe("home screen: signed in shows the group ledger", () => {
  beforeEach(() => {
    hoisted.session = SIGNED_IN;
    hoisted.load.mockReset();
    hoisted.modalProps.length = 0;
  });

  it("shows the ledger's pot balance and contributions, not the sample", async () => {
    hoisted.load.mockResolvedValue(ready("42500.75", [
      { id: "e2", sequence: "8", amount: "500.25" },
      { id: "e1", sequence: "7", amount: "42000.50" }
    ]));
    render(<SenedHome />);
    await screen.findByText("42,500.75");
    expect(screen.queryByText("175,000")).not.toBeInTheDocument();
    expect(screen.queryByText(am("home.sample.notice"))).not.toBeInTheDocument();
    expect(screen.queryByText("Gabi Member")).not.toBeInTheDocument();
    const rows = screen.getAllByText(/ልይል ቁጥር/).map((el) => el.textContent);
    expect(rows).toEqual([am("shell.feed.ledgerContribution", { sequence: 8 }), am("shell.feed.ledgerContribution", { sequence: 7 })]);
    // Never a verified badge for a ledger row: nothing here carries provenance.
    expect(screen.getAllByText(am("shell.feed.recorded"))).toHaveLength(2);
    expect(screen.queryByText(am("shell.feed.pending"))).not.toBeInTheDocument();
  });

  it("marks a bank-provenance contribution verified, with its provider and payer, and leaves the others recorded", async () => {
    const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    hoisted.load.mockResolvedValue(
      ready(
        "300.00",
        [
          {
            id: "e2",
            sequence: "8",
            amount: "250.00",
            provenance: {
              provider: "cbe",
              verifiedAt: "2026-09-01T09:00:05.000Z",
              verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              memberUserId: PAYER
            }
          },
          { id: "e1", sequence: "7", amount: "50.00" }
        ],
        { [PAYER]: null }
      )
    );
    render(<SenedHome />);
    await screen.findByText("300.00");
    expect(screen.getAllByText(am("shell.feed.recorded"))).toHaveLength(1);
    expect(screen.getByText(am("shell.feed.channelCbe"))).toBeInTheDocument();
    // The members API showed no email, so the anonymous label is used.
    expect(screen.getByTestId("feed-paid-by")).toHaveTextContent(am("members.anonymous", { id: PAYER.slice(0, 8) }));
    // The digest speaks no verified count: it has nothing to count honestly.
    const script = await digestText();
    expect(script).not.toMatch(/verified|የተረጋገጡ/i);
  });

  it("names the payer by email when the members API already showed it", async () => {
    const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    hoisted.load.mockResolvedValue(
      ready(
        "250.00",
        [
          {
            id: "e2",
            sequence: "8",
            amount: "250.00",
            provenance: {
              provider: "telebirr",
              verifiedAt: "2026-09-01T09:00:05.000Z",
              verificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              memberUserId: PAYER
            }
          }
        ],
        { [PAYER]: "payer@example.test" }
      )
    );
    render(<SenedHome />);
    await screen.findByText("250.00");
    expect(screen.getByTestId("feed-paid-by")).toHaveTextContent("payer@example.test");
  });

  it("speaks the same real numbers the screen shows", async () => {
    hoisted.load.mockResolvedValue(ready("42500.75", []));
    render(<SenedHome />);
    await screen.findByText("42,500.75");
    const script = await digestText();
    expect(script).toContain(am("audio.script.potBalance", { amount: "42,500.75" }));
    expect(script).not.toContain("175,000");
    // Member counts are not derivable from the ledger, so none are spoken.
    expect(script).not.toContain("17");
    expect(script).not.toContain(am("audio.script.sample"));
  });

  it("shows a loading state and no number while the ledger loads", async () => {
    let resolve!: (value: unknown) => void;
    hoisted.load.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SenedHome />);
    expect(screen.getByText(am("home.live.loading"))).toBeInTheDocument();
    expect(screen.queryByText("175,000")).not.toBeInTheDocument();
    expect(await digestText()).toContain(am("audio.script.unavailable"));
    await act(async () => resolve(ready("1.00", [])));
    await screen.findByText("1.00");
    expect(screen.queryByText(am("home.live.loading"))).not.toBeInTheDocument();
  });

  it("shows a zero balance with an empty-ledger message when there are no entries", async () => {
    hoisted.load.mockResolvedValue({ status: "empty" });
    render(<SenedHome />);
    expect(await screen.findByText(am("home.live.empty"))).toBeInTheDocument();
    expect(screen.getByText("0.00")).toBeInTheDocument();
    expect(screen.getByText(am("shell.feed.empty"))).toBeInTheDocument();
  });

  it.each([
    ["error", "home.live.error"],
    ["unauthorized", "home.live.unauthorized"],
    ["no-group", "home.live.noGroup"],
    ["multiple-groups", "home.live.multipleGroups"],
    ["incomplete", "home.live.incomplete"]
  ] as const)("shows %s with no balance and no sample numbers", async (status, key) => {
    hoisted.load.mockResolvedValue({ status });
    render(<SenedHome />);
    expect(await screen.findByRole("alert")).toHaveTextContent(am(key));
    expect(screen.queryByText("175,000")).not.toBeInTheDocument();
    expect(screen.queryByText("Gabi Member")).not.toBeInTheDocument();
    expect(screen.getByText(am("shell.debter.unavailable"))).toBeInTheDocument();
    expect(await digestText()).toContain(am("audio.script.unavailable"));
  });
});

describe("home screen: signed out shows labelled sample data", () => {
  beforeEach(() => {
    hoisted.load.mockReset();
    hoisted.modalProps.length = 0;
  });

  it.each(["signed-out", "unconfigured"])("labels the sample and never reads the ledger when %s", async (status) => {
    hoisted.session = { status };
    render(<SenedHome />);
    expect(screen.getByText(am("home.sample.notice"))).toBeInTheDocument();
    expect(screen.getByText("175,000")).toBeInTheDocument();
    expect(screen.getByText("Gabi Member")).toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
    const script = await digestText();
    expect(script).toContain(am("audio.script.sample"));
    expect(script).toContain(am("audio.script.potBalance", { amount: "175,000" }));
  });

  it("does not show the sample balance while the session is still resolving", () => {
    hoisted.session = { status: "loading" };
    render(<SenedHome />);
    expect(screen.queryByText("175,000")).not.toBeInTheDocument();
    expect(screen.queryByText(am("home.sample.notice"))).not.toBeInTheDocument();
    expect(within(document.body).getByText(am("home.live.loading"))).toBeInTheDocument();
  });

  it("keeps a spoken note out of the pot balance", async () => {
    hoisted.session = { status: "signed-out" };
    render(<SenedHome />);
    const record = hoisted.modalProps[hoisted.modalProps.length - 1].onRecordLocally as (d: unknown, o: unknown) => Promise<void>;
    await act(async () => {
      await record(
        { utterance: "x", language: "am", amount: 9999, amountWire: "9999.00", provider: "telebirr", txRef: "T1" },
        { transcriptSource: "human-typed" }
      );
    });
    // The provisional note is listed, the balance did not move.
    await waitFor(() => expect(screen.getByText("T1", { exact: false })).toBeInTheDocument());
    expect(screen.getByText("175,000")).toBeInTheDocument();
    expect(screen.queryByText("184,999")).not.toBeInTheDocument();
    expect(await digestText()).toContain(am("audio.script.potBalance", { amount: "175,000" }));
  });
});
