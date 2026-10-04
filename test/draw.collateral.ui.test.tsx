import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollateralPanel, type CollateralOutcome, type CollateralState } from "@/components/draw/CollateralPanel";
import { parseCycleCollateral } from "@/lib/draw/collateral";
import type { GuaranteeCommand } from "@/lib/draw/clientDraw";
import { dictionaries, translate, type Locale, type MessageKey } from "@/lib/i18n";

afterEach(cleanup);

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // winner of round 1
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // guarantor (proposed)
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // guarantor (accepted)
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // plain member
const ENTRY = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-10-10T09:00:00.000Z";
const NAMES: Record<string, string> = { [TREASURER]: "Treasurer", [A]: "Alem", [B]: "Berhan", [C]: "Chaltu", [D]: "Dawit" };

const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);

function guarantee(id: string, guarantor: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    guaranteeId: id,
    cycleId: CYCLE,
    winnerMemberId: A,
    guarantorMemberId: guarantor,
    proposedBy: TREASURER,
    proposedAt: T0,
    state,
    stateAt: T0,
    stateBy: TREASURER,
    acceptedAt: state === "accepted" ? T0 : null,
    reason: null,
    successorGuaranteeId: null,
    ...extra
  };
}

const G_B = "11111111-aaaa-4aaa-8aaa-111111111111";
const G_C = "22222222-aaaa-4aaa-8aaa-222222222222";
const G_OLD = "33333333-aaaa-4aaa-8aaa-333333333333";

function wire(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 4,
    contributionAmount: "100.00",
    potAmount: "500.00",
    reserveRatioBps: 1000,
    startedAt: T0,
    nextRound: 3,
    eligibleCount: 4,
    reserveRetained: "50.00",
    flaggedCount: 1,
    winners: [
      {
        memberId: A,
        round: 1,
        revealedAt: T0,
        owed: [
          { round: 2, status: "met", dueAt: T0, entryId: ENTRY, source: "treasurer" },
          { round: 3, status: "flagged", dueAt: T0, entryId: null, source: null },
          { round: 4, status: "not_due", dueAt: null, entryId: null, source: null }
        ],
        guarantees: [
          guarantee(G_B, B, "proposed"),
          guarantee(G_C, C, "accepted"),
          guarantee(G_OLD, D, "released", { reason: "Moved to another city" })
        ]
      }
    ],
    ...overrides
  };
}

function ready(overrides: Record<string, unknown> = {}): CollateralState {
  const view = parseCycleCollateral(wire(overrides));
  if (view === null) throw new Error("fixture invalid");
  return { kind: "ready", view };
}

function mount(options: {
  me: string;
  isTreasurer?: boolean;
  state?: CollateralState;
  locale?: Locale;
  onCommand?: (command: GuaranteeCommand) => Promise<CollateralOutcome>;
}) {
  const onCommand = options.onCommand ?? vi.fn(async () => ({ ok: true }) as CollateralOutcome);
  render(
    <CollateralPanel
      locale={options.locale ?? "en"}
      state={options.state ?? ready()}
      currencyLabel="ETB"
      myUserId={options.me}
      isTreasurer={options.isTreasurer ?? false}
      members={[TREASURER, A, B, C, D].map((userId) => ({ userId }))}
      labelFor={(id) => NAMES[id] ?? id}
      onCommand={onCommand}
    />
  );
  return onCommand;
}

describe("CollateralPanel: what everyone sees", () => {
  it("says it is advisory first, and that nothing moves money", () => {
    mount({ me: D });
    const note = screen.getByTestId("collateral-advisory");
    expect(note).toHaveTextContent("Advisory only");
    expect(note).toHaveTextContent("Nothing here moves money or debits anyone");
    expect(note).toHaveTextContent("the group's decision");
  });

  it("shows each winner, the rounds they owe with their derived status, and the flag's honest explanation", () => {
    mount({ me: D });
    const winner = screen.getByTestId("collateral-winner");
    expect(winner).toHaveTextContent("Alem · won round 1");
    expect(within(winner).getByTestId("collateral-remaining")).toHaveTextContent("3 later round(s): 1 met, 1 flagged, 1 not yet due.");
    const rounds = within(winner).getAllByTestId("collateral-round");
    expect(rounds.map((entry) => entry.getAttribute("data-round-status"))).toEqual(["met", "flagged", "not_due"]);
    expect(rounds[0]).toHaveTextContent("Round 2: Met (recorded by the treasurer)");
    expect(rounds[1]).toHaveTextContent("Round 3: Flagged");
    expect(rounds[2]).toHaveTextContent("Round 4: Not yet due");
    const explain = screen.getByTestId("collateral-flag-explain");
    expect(explain).toHaveTextContent("a flag, not a verdict");
    expect(explain).toHaveTextContent("they may have paid in a way not yet recorded");
  });

  it("puts the reserve retained next to the exposure, in exact amounts, with the planned next reserve", () => {
    mount({ me: D });
    expect(screen.getByTestId("collateral-retained")).toHaveTextContent("50.00 ETB");
    // Unmet rounds: 3 (flagged) and 4 (not yet due) = 200.00; overdue = 100.00.
    expect(screen.getByTestId("collateral-outstanding")).toHaveTextContent("200.00 ETB");
    expect(screen.getByTestId("collateral-overdue")).toHaveTextContent("100.00 ETB");
    expect(screen.getByTestId("collateral-next-reserve")).toBeInTheDocument();
    // 50.00 retained does not cover 100.00 overdue.
    expect(screen.getByTestId("collateral-covers")).toHaveTextContent("does not cover the flagged amount");
  });

  it("lists every guarantee with the guarantor's own state, and never calls a proposal confirmed", () => {
    mount({ me: D });
    const rows = screen.getAllByTestId("guarantee-row");
    expect(rows.map((row) => row.getAttribute("data-guarantee-state"))).toEqual(["proposed", "accepted", "released"]);
    expect(rows[0]).toHaveTextContent("Berhan vouches for Alem");
    expect(rows[0]).toHaveTextContent("Waiting for the guarantor's own confirmation");
    expect(rows[0]).not.toHaveTextContent("Confirmed by the guarantor");
    expect(rows[1]).toHaveTextContent("Confirmed by the guarantor");
    expect(rows[2]).toHaveTextContent("Released");
    expect(rows[2]).toHaveTextContent("Reason: Moved to another city");
    expect(screen.getByText(/only counts once the guarantor confirms it themselves/)).toBeInTheDocument();
  });

  it("offers a plain member no control at all", () => {
    mount({ me: D });
    for (const id of ["guarantee-accept", "guarantee-decline", "guarantee-release", "guarantee-supersede", "guarantee-propose"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("says nothing was won yet, and never shows a guess while loading or unavailable", () => {
    mount({ me: D, state: ready({ winners: [], flaggedCount: 0 }) });
    expect(screen.getByTestId("collateral-empty")).toHaveTextContent("Nobody has won a round of this cycle yet");
    cleanup();
    mount({ me: D, state: { kind: "loading" } });
    expect(screen.getByTestId("collateral-status")).toHaveTextContent("Reading the collateral record");
    expect(screen.queryByTestId("collateral-winner")).toBeNull();
    cleanup();
    mount({ me: D, state: { kind: "unavailable" } });
    expect(screen.getByTestId("collateral-status")).toHaveTextContent("could not be read");
    expect(screen.getByTestId("collateral-advisory")).toBeInTheDocument();
  });

  it("invents no amount for a cycle with no contribution on record", () => {
    mount({ me: D, state: ready({ contributionAmount: null }) });
    expect(screen.queryByTestId("collateral-figures")).toBeNull();
    expect(screen.getByText(/no contribution amount on record/)).toBeInTheDocument();
    // The counts are still shown.
    expect(screen.getByTestId("collateral-remaining")).toHaveTextContent("1 flagged");
  });

  it("marks the final-round winner as owing nothing", () => {
    mount({ me: D, state: ready({ winners: [{ memberId: A, round: 4, revealedAt: T0, owed: [], guarantees: [] }], flaggedCount: 0 }) });
    expect(screen.getByTestId("collateral-winner")).toHaveTextContent("Won the final round: nothing left to owe.");
    expect(screen.queryByTestId("guarantee-propose")).toBeNull();
  });

  it("speaks Amharic with no raw keys, and every collateral key exists in both languages", () => {
    mount({ me: D, locale: "am" });
    const panel = screen.getByTestId("collateral-panel");
    expect(panel).toHaveTextContent(translate("am", "collateral.title"));
    expect(panel).toHaveTextContent(translate("am", "collateral.status.flagged"));
    expect(panel.textContent).not.toMatch(/collateral\.[a-z_.]+/);
    const keys = Object.keys(dictionaries.en).filter((key) => key.startsWith("collateral") || key.startsWith("shell.feed.attribute") || key === "drawLive.ledgerTreasurerMark");
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) {
      expect(dictionaries.am[key as MessageKey], key).toBeTruthy();
      expect(dictionaries.am[key as MessageKey], key).not.toBe(dictionaries.en[key as MessageKey]);
      // Same placeholders in both languages.
      const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(holes(dictionaries.am[key as MessageKey]), key).toEqual(holes(dictionaries.en[key as MessageKey]));
    }
  });
});

describe("CollateralPanel: the guarantor's own consent", () => {
  it("shows confirm and decline ONLY to the guarantor of a proposed guarantee, and sends only the guarantee id", async () => {
    const user = userEvent.setup();
    const onCommand = mount({ me: B });
    const rows = screen.getAllByTestId("guarantee-row");
    expect(within(rows[0]!).getByTestId("guarantee-accept")).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId("guarantee-decline")).toBeInTheDocument();
    // Not on a guarantee that names someone else, nor on one already accepted.
    expect(within(rows[1]!).queryByTestId("guarantee-accept")).toBeNull();
    expect(within(rows[2]!).queryByTestId("guarantee-accept")).toBeNull();

    await user.click(within(rows[0]!).getByTestId("guarantee-accept"));
    expect(onCommand).toHaveBeenCalledWith({ action: "accept", guaranteeId: G_B });
    expect(await screen.findByTestId("collateral-message")).toHaveTextContent("Recorded.");
  });

  it("never offers the owner or treasurer a way to confirm or decline for someone else", () => {
    mount({ me: TREASURER, isTreasurer: true });
    expect(screen.queryByTestId("guarantee-accept")).toBeNull();
    expect(screen.queryByTestId("guarantee-decline")).toBeNull();
  });

  it("never offers the winner a way to confirm their own guarantee", () => {
    mount({ me: A });
    expect(screen.queryByTestId("guarantee-accept")).toBeNull();
  });

  it("declines with an optional reason", async () => {
    const user = userEvent.setup();
    const onCommand = mount({ me: B });
    await user.click(screen.getByTestId("guarantee-decline"));
    await user.type(within(screen.getByTestId("guarantee-decline-form")).getByRole("textbox"), "Cannot take this on");
    await user.click(within(screen.getByTestId("guarantee-decline-form")).getByRole("button", { name: "Decline" }));
    expect(onCommand).toHaveBeenCalledWith({ action: "decline", guaranteeId: G_B, reason: "Cannot take this on" });
  });

  it("lets a guarantor release their own accepted guarantee, with a reason of at least 10 characters", async () => {
    const user = userEvent.setup();
    const onCommand = mount({ me: C });
    const row = screen.getAllByTestId("guarantee-row")[1]!;
    expect(within(row).queryByTestId("guarantee-supersede")).toBeNull();
    await user.click(within(row).getByTestId("guarantee-release"));
    await user.type(within(screen.getByTestId("guarantee-release-form")).getByRole("textbox"), "too short");
    await user.click(screen.getByTestId("guarantee-release-confirm"));
    expect(await screen.findByTestId("collateral-message")).toHaveTextContent("at least 10 characters");
    expect(onCommand).not.toHaveBeenCalled();
    await user.type(within(screen.getByTestId("guarantee-release-form")).getByRole("textbox"), " reason now");
    await user.click(screen.getByTestId("guarantee-release-confirm"));
    expect(onCommand).toHaveBeenCalledWith({ action: "release", guaranteeId: G_C, reason: "too short reason now" });
  });

  it("shows the server's refusal in the member's language and keeps the form", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => ({ ok: false, key: "collateralLive.error.stateConflict" as MessageKey, detail: null }) as CollateralOutcome);
    mount({ me: B, onCommand });
    await user.click(screen.getByTestId("guarantee-accept"));
    expect(await screen.findByRole("alert")).toHaveTextContent("already moved on");
  });
});

describe("CollateralPanel: the owner's and treasurer's controls", () => {
  it("proposes a guarantor from members who are not the winner and not already guaranteeing", async () => {
    const user = userEvent.setup();
    const onCommand = mount({ me: TREASURER, isTreasurer: true });
    await user.click(screen.getByTestId("guarantee-propose"));
    const select = screen.getByTestId("guarantee-propose-member") as HTMLSelectElement;
    const offered = [...select.options].map((option) => option.textContent);
    // Not the winner (Alem), not Berhan or Chaltu (open guarantees); Dawit's was released, so he is offered.
    expect(offered).toEqual(["Choose a member", "Treasurer", "Dawit"]);
    expect(screen.getByText(/must confirm it themselves/)).toBeInTheDocument();

    await user.click(screen.getByTestId("guarantee-propose-confirm"));
    expect(await screen.findByTestId("collateral-message")).toHaveTextContent("Choose a member first");
    expect(onCommand).not.toHaveBeenCalled();

    await user.selectOptions(select, D);
    await user.click(screen.getByTestId("guarantee-propose-confirm"));
    expect(onCommand).toHaveBeenCalledWith({ action: "propose", cycleId: CYCLE, winnerMemberId: A, guarantorMemberId: D });
  });

  it("releases and replaces an open guarantee with a reason, and offers neither on an ended one", async () => {
    const user = userEvent.setup();
    const onCommand = mount({ me: TREASURER, isTreasurer: true });
    const rows = screen.getAllByTestId("guarantee-row");
    expect(within(rows[2]!).queryByTestId("guarantee-release")).toBeNull();
    expect(within(rows[2]!).queryByTestId("guarantee-supersede")).toBeNull();

    await user.click(within(rows[1]!).getByTestId("guarantee-supersede"));
    const form = screen.getByTestId("guarantee-supersede-form");
    await user.selectOptions(within(form).getByTestId("guarantee-supersede-member"), D);
    await user.type(within(form).getAllByRole("textbox")[0]!, "Chaltu is moving away from town");
    await user.click(screen.getByTestId("guarantee-supersede-confirm"));
    expect(onCommand).toHaveBeenCalledWith({
      action: "supersede",
      guaranteeId: G_C,
      newGuarantorMemberId: D,
      reason: "Chaltu is moving away from town"
    });
  });

  it("closes the form and reports success only when the command succeeded", async () => {
    const user = userEvent.setup();
    mount({ me: TREASURER, isTreasurer: true });
    await user.click(screen.getByTestId("guarantee-propose"));
    await user.selectOptions(screen.getByTestId("guarantee-propose-member"), D);
    await user.click(screen.getByTestId("guarantee-propose-confirm"));
    await waitFor(() => expect(screen.queryByTestId("guarantee-propose-form")).toBeNull());
    expect(screen.getByTestId("collateral-message")).toHaveTextContent("Recorded.");
  });
});
