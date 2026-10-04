import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
