import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContributionFeed, type MemberContribution, type PayerAttribution } from "@/components/contributions/ContributionFeed";
import type { AttributeResult } from "@/lib/ledger/clientAttribution";
import { translate, type MessageKey } from "@/lib/i18n";

afterEach(cleanup);

const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);
const am = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("am", key, vars);

const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A ledger row (a cash entry) with no bank provenance. */
const CASH: MemberContribution = {
  id: "e1",
  name: "Ledger entry 7",
  amountWire: "100.00",
  transactionId: "#7",
  source: "ledger",
  status: "PROVISIONAL"
};

const TREASURER_RECORDED: MemberContribution = {
  ...CASH,
  id: "e2",
  name: "Ledger entry 8",
  transactionId: "#8",
  memberId: PAYER,
  treasurerPayer: { memberId: PAYER, memberLabel: "Berhan", revision: 1, recordedAtLabel: "10/10/2026" }
};

const BANK: MemberContribution = {
  ...CASH,
  id: "e3",
  name: "Ledger entry 9",
  transactionId: "#9",
  channel: "cbe",
  status: "VERIFIED",
  verifiedBy: "CBE Birr",
  verifiedAt: "2026-10-10",
  memberId: PAYER,
  memberLabel: "Berhan"
};

function attribution(result: AttributeResult = { status: "ok", replayed: false, revision: 1 }) {
  const onAttribute = vi.fn(async () => result);
  const value: PayerAttribution = {
    members: [
      { userId: PAYER, label: "Berhan" },
      { userId: OTHER, label: "Chaltu" }
    ],
    onAttribute
  };
  return { value, onAttribute };
}

describe("a payer recorded by the treasurer is never shown as verified", () => {
  it("labels the row 'recorded by the treasurer, not bank-verified' and keeps the plain recorded badge", () => {
    render(<ContributionFeed contributions={[TREASURER_RECORDED]} locale="en" />);

    expect(screen.getByText(en("shell.feed.recorded"))).toBeInTheDocument();
    const line = screen.getByTestId("feed-paid-by-treasurer");
    expect(line).toHaveTextContent("Paid by: Berhan · Recorded by the treasurer · not bank-verified");
    // None of the verified surfaces.
    expect(screen.queryByTestId("feed-paid-by")).toBeNull();
    expect(screen.queryByText(en("shell.feed.verifiedWord"))).toBeNull();
    expect(document.body.textContent).not.toMatch(/Verified/);
  });

  it("stays unverified even if a caller sets status VERIFIED without a verifier", () => {
    render(
      <ContributionFeed contributions={[{ ...TREASURER_RECORDED, status: "VERIFIED" }]} locale="en" />
    );
    expect(screen.queryByTestId("feed-paid-by")).toBeNull();
    expect(screen.getByTestId("feed-paid-by-treasurer")).toBeInTheDocument();
    expect(screen.getByText(en("shell.feed.recorded"))).toBeInTheDocument();
  });

  it("a bank-verified row never carries the treasurer line, even if it was handed one", () => {
    render(<ContributionFeed contributions={[{ ...BANK, treasurerPayer: TREASURER_RECORDED.treasurerPayer }]} locale="en" />);
    expect(screen.getByTestId("feed-paid-by")).toHaveTextContent("Paid by: Berhan");
    expect(screen.queryByTestId("feed-paid-by-treasurer")).toBeNull();
  });

  it("explains in the detail that it is the treasurer's own record, and counts corrections", async () => {
    const user = userEvent.setup();
    const corrected = { ...TREASURER_RECORDED, treasurerPayer: { ...TREASURER_RECORDED.treasurerPayer!, revision: 3 } };
    render(<ContributionFeed contributions={[corrected]} locale="en" />);
    await user.click(screen.getByText("Ledger entry 8"));
    const detail = screen.getByTestId("feed-treasurer-payer");
    expect(detail).toHaveTextContent("Berhan");
    expect(detail).toHaveTextContent("not a bank verification");
    expect(detail).toHaveTextContent("Corrected 2 time(s); every earlier record is kept.");
    expect(screen.getByText(en("shell.feed.ledgerEntryTitle"))).toBeInTheDocument();
    expect(screen.queryByText(en("shell.feed.verifiedTitle"))).toBeNull();
  });

  it("speaks Amharic by default", () => {
    render(<ContributionFeed contributions={[TREASURER_RECORDED]} />);
    expect(screen.getByTestId("feed-paid-by-treasurer")).toHaveTextContent(am("shell.feed.recordedByTreasurer"));
  });
});

describe("the owner's / treasurer's 'attribute payer' action", () => {
  it("is absent without the prop (a plain member), and absent on a verified row", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed contributions={[CASH]} locale="en" />);
    await user.click(screen.getByText("Ledger entry 7"));
    expect(screen.queryByTestId("feed-attribute-payer")).toBeNull();
    cleanup();

    const { value } = attribution();
    render(<ContributionFeed contributions={[BANK]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 9"));
    expect(screen.queryByTestId("feed-attribute-payer")).toBeNull();
  });

  it("is absent on a row that is not a ledger entry (an on-device note)", async () => {
    const user = userEvent.setup();
    const { value } = attribution();
    render(<ContributionFeed contributions={[{ ...CASH, source: undefined }]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 7"));
    expect(screen.queryByTestId("feed-attribute-payer")).toBeNull();
  });

  it("records the chosen member for the entry, says it is recorded by the treasurer, and sends no reason on a first record", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[CASH]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 7"));
    const panel = screen.getByTestId("feed-attribute-payer");
    expect(panel).toHaveTextContent("never as bank-verified");
    expect(within(panel).queryByTestId("feed-attribute-reason")).toBeNull();

    // Nothing chosen: no call.
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(screen.getByTestId("feed-attribute-message")).toHaveTextContent("Choose the member who paid.");
    expect(onAttribute).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).toHaveBeenCalledWith({ entryId: "e1", memberUserId: PAYER });
    expect(await screen.findByTestId("feed-attribute-message")).toHaveTextContent("Recorded. It now shows as recorded by the treasurer.");
  });

  it("corrects an existing record only with a reason of at least 10 characters", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[TREASURER_RECORDED]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 8"));
    expect(screen.getByTestId("feed-attribute-payer")).toHaveTextContent("The earlier record stays");

    await user.selectOptions(screen.getByTestId("feed-attribute-member"), OTHER);
    await user.type(screen.getByTestId("feed-attribute-reason"), "too short");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).not.toHaveBeenCalled();
    expect(screen.getByTestId("feed-attribute-message")).toHaveTextContent("at least 10 characters");

    await user.type(screen.getByTestId("feed-attribute-reason"), " enough now");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).toHaveBeenCalledWith({ entryId: "e2", memberUserId: OTHER, reason: "too short enough now" });
  });

  it("says why a refusal happened, for each way the database can refuse", async () => {
    const user = userEvent.setup();
    const cases: Array<[AttributeResult, MessageKey]> = [
      [{ status: "refused", code: "bank_verified" }, "shell.feed.attribute.error.bank_verified"],
      [{ status: "refused", code: "corrected" }, "shell.feed.attribute.error.corrected"],
      [{ status: "refused", code: "exists" }, "shell.feed.attribute.error.exists"],
      [{ status: "refused", code: "member_not_found" }, "shell.feed.attribute.error.member_not_found"],
      [{ status: "forbidden" }, "shell.feed.attribute.error.forbidden"],
      [{ status: "unauthorized" }, "shell.feed.attribute.error.unauthorized"],
      [{ status: "rate-limited" }, "shell.feed.attribute.error.rate_limited"],
      [{ status: "error" }, "shell.feed.attribute.error.error"]
    ];
    for (const [result, key] of cases) {
      const { value } = attribution(result);
      const view = render(<ContributionFeed contributions={[CASH]} locale="en" attribution={value} />);
      await user.click(screen.getByText("Ledger entry 7"));
      await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
      await user.click(screen.getByTestId("feed-attribute-submit"));
      expect(await screen.findByTestId("feed-attribute-message")).toHaveTextContent(en(key));
      expect(screen.getByTestId("feed-attribute-message")).toHaveAttribute("role", "alert");
      view.unmount();
    }
  });

  it("shows the new record on the open detail once the list re-reads, without closing it", async () => {
    const user = userEvent.setup();
    const { value } = attribution();
    const view = render(<ContributionFeed contributions={[CASH]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 7"));
    expect(screen.queryByTestId("feed-treasurer-payer")).toBeNull();

    view.rerender(
      <ContributionFeed
        contributions={[{ ...CASH, memberId: PAYER, treasurerPayer: { memberId: PAYER, memberLabel: "Berhan", revision: 1, recordedAtLabel: "now" } }]}
        locale="en"
        attribution={value}
      />
    );
    await waitFor(() => expect(screen.getByTestId("feed-treasurer-payer")).toHaveTextContent("Berhan"));
    // It is now a correction form.
    expect(screen.getByTestId("feed-attribute-reason")).toBeInTheDocument();
  });
});

describe("how it was paid, and the treasurer's note", () => {
  const WITH_DETAILS: MemberContribution = {
    ...TREASURER_RECORDED,
    id: "e4",
    name: "Ledger entry 10",
    transactionId: "#10",
    treasurerPayer: {
      ...TREASURER_RECORDED.treasurerPayer!,
      channel: "cash",
      note: "<script>alert(1)</script> brought by his brother"
    }
  };

  it("shows the recorded channel and note on the row, as plain text, beside 'recorded by the treasurer'", () => {
    render(<ContributionFeed contributions={[WITH_DETAILS]} locale="en" />);
    expect(screen.getByTestId("feed-channel")).toHaveTextContent("Cash");
    const note = screen.getByTestId("feed-note");
    expect(note).toHaveTextContent("<script>alert(1)</script> brought by his brother");
    expect(note.querySelector("script")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    // Still the treasurer's own record: no verified badge, no verified payer line.
    expect(screen.getByTestId("feed-paid-by-treasurer")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-paid-by")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Verified/);
  });

  it("shows them in the detail too, with 'Other' labelled, and 'Not stated' when no channel was recorded", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed contributions={[{ ...WITH_DETAILS, treasurerPayer: { ...WITH_DETAILS.treasurerPayer!, channel: "other" } }, TREASURER_RECORDED]} locale="en" />);
    await user.click(screen.getByText("Ledger entry 10"));
    expect(screen.getByText(`${en("shell.feed.channel")}:`).nextSibling).toHaveTextContent("Other");
    expect(screen.getByTestId("feed-detail-note")).toHaveTextContent("brought by his brother");
    await user.click(screen.getAllByText(en("shell.feed.close"))[0]!);
    await user.click(screen.getByText("Ledger entry 8"));
    expect(screen.getByText(`${en("shell.feed.channel")}:`).nextSibling).toHaveTextContent(en("shell.feed.channelNone"));
    expect(screen.queryByTestId("feed-detail-note")).toBeNull();
  });

  it("a bank-verified row shows its provider as the channel and never a treasurer's note, even if handed one", async () => {
    const user = userEvent.setup();
    render(
      <ContributionFeed
        contributions={[{ ...BANK, treasurerPayer: { ...TREASURER_RECORDED.treasurerPayer!, channel: "cash", note: "I paid in cash" } }]}
        locale="en"
      />
    );
    expect(screen.queryByTestId("feed-note")).toBeNull();
    expect(screen.queryByTestId("feed-channel-note")).toBeNull();
    await user.click(screen.getByText("Ledger entry 9"));
    expect(screen.getByText(`${en("shell.feed.channel")}:`).nextSibling).toHaveTextContent("CBE Birr");
    expect(screen.queryByTestId("feed-detail-note")).toBeNull();
    expect(document.body.textContent).not.toContain("I paid in cash");
  });

  it("records a channel and note with a first payer, sending only what was filled in", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[CASH]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 7"));
    await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "awash");
    await user.type(screen.getByTestId("feed-attribute-note"), "  Branch transfer  ");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).toHaveBeenCalledWith({ entryId: "e1", memberUserId: PAYER, channel: "awash", note: "Branch transfer" });
  });

  it("refuses a note with a control character or over 280 characters before calling anything", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[CASH]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 7"));
    await user.selectOptions(screen.getByTestId("feed-attribute-member"), PAYER);
    for (const bad of ["bell\u0007", "x".repeat(281)]) {
      fireEvent.change(screen.getByTestId("feed-attribute-note"), { target: { value: bad } });
      await user.click(screen.getByTestId("feed-attribute-submit"));
      expect(screen.getByTestId("feed-attribute-message")).toHaveTextContent(en("shell.feed.attribute.noteError"));
    }
    expect(onAttribute).not.toHaveBeenCalled();
  });

  it("corrects only the channel: the form starts from what is recorded, the payer stays, and only the change is sent with the reason", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[WITH_DETAILS]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 10"));
    expect(screen.getByTestId("feed-attribute-channel")).toHaveValue("cash");
    expect(screen.getByTestId("feed-attribute-note")).toHaveValue("<script>alert(1)</script> brought by his brother");

    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "telebirr");
    await user.type(screen.getByTestId("feed-attribute-reason"), "It was sent by Telebirr, not paid in cash");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).toHaveBeenCalledWith({
      entryId: "e4",
      memberUserId: PAYER,
      reason: "It was sent by Telebirr, not paid in cash",
      channel: "telebirr"
    });
  });

  it("clears the note and the channel on request (null), and still needs the reason", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[WITH_DETAILS]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 10"));
    await user.selectOptions(screen.getByTestId("feed-attribute-channel"), "");
    await user.clear(screen.getByTestId("feed-attribute-note"));
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).not.toHaveBeenCalled();
    expect(screen.getByTestId("feed-attribute-message")).toHaveTextContent("at least 10 characters");

    await user.type(screen.getByTestId("feed-attribute-reason"), "Neither was right, removing both");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).toHaveBeenCalledWith({
      entryId: "e4",
      memberUserId: PAYER,
      reason: "Neither was right, removing both",
      channel: null,
      note: null
    });
  });

  it("changing nothing is not a correction: it asks for a member, as it always did", async () => {
    const user = userEvent.setup();
    const { value, onAttribute } = attribution();
    render(<ContributionFeed contributions={[WITH_DETAILS]} locale="en" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 10"));
    await user.type(screen.getByTestId("feed-attribute-reason"), "Nothing to change but a long reason");
    await user.click(screen.getByTestId("feed-attribute-submit"));
    expect(onAttribute).not.toHaveBeenCalled();
    expect(screen.getByTestId("feed-attribute-message")).toHaveTextContent(en("shell.feed.attribute.pickMember"));
  });

  it("offers the channel and note controls only where the payer control is offered", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed contributions={[CASH, BANK]} locale="en" />);
    await user.click(screen.getByText("Ledger entry 7"));
    expect(screen.queryByTestId("feed-attribute-channel")).toBeNull();
    expect(screen.queryByTestId("feed-attribute-note")).toBeNull();
  });

  it("is available in Amharic", async () => {
    const user = userEvent.setup();
    const { value } = attribution();
    render(<ContributionFeed contributions={[WITH_DETAILS]} locale="am" attribution={value} />);
    await user.click(screen.getByText("Ledger entry 10"));
    expect(screen.getByText(am("shell.feed.attribute.channelLabel"))).toBeInTheDocument();
    expect(screen.getByText(am("shell.feed.attribute.noteLabel"))).toBeInTheDocument();
    expect(screen.getByTestId("feed-channel")).toHaveTextContent(am("shell.feed.channelCash"));
  });
});
