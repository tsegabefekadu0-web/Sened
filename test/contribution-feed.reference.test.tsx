import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";

const B = "••••";
const PAYER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const VERIFIED: MemberContribution = {
  id: "e1",
  name: "Contribution #8",
  amountWire: "25.00",
  transactionId: "#8",
  source: "ledger",
  channel: "telebirr",
  status: "VERIFIED",
  verifiedBy: "Telebirr",
  verifiedAt: "10/2/2026, 9:00:05 AM",
  memberLabel: "Member bbbbbbbb",
  memberId: PAYER,
  referenceMasked: `${B}2F42`
};

describe("verified badge with the masked transaction reference", () => {
  it("reads \"Telebirr Verified · ••••2F42\"", () => {
    render(<ContributionFeed locale="en" contributions={[VERIFIED]} />);
    const badge = screen.getByTestId("feed-reference-masked").parentElement!;
    expect(badge).toHaveTextContent(`Telebirr Verified · ${B}2F42`);
  });

  it("offers a screen reader plain text instead of bullets", () => {
    render(<ContributionFeed locale="en" contributions={[VERIFIED]} />);
    const badge = screen.getByTestId("feed-reference-masked").parentElement!;
    expect(screen.getByTestId("feed-reference-masked")).toHaveAttribute("aria-hidden", "true");
    expect(within(badge).getByText("bank reference ending 2F42")).toHaveClass("sr-only");
  });

  it("shows the badge without a reference when none is on record", () => {
    render(<ContributionFeed locale="en" contributions={[{ ...VERIFIED, referenceMasked: undefined }]} />);
    expect(screen.queryByTestId("feed-reference-masked")).not.toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("refuses to render anything that is not exactly the masked shape", () => {
    for (const bad of ["FT26280ABCD2F42", `${B}12345`, "2F42", ""]) {
      const { unmount } = render(<ContributionFeed locale="en" contributions={[{ ...VERIFIED, referenceMasked: bad }]} />);
      expect(screen.queryByTestId("feed-reference-masked"), bad).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("FT26280ABCD2F42");
      unmount();
    }
  });

  it("never shows a masked reference on a row that is not verified", () => {
    render(
      <ContributionFeed
        locale="en"
        contributions={[{ ...VERIFIED, status: "PROVISIONAL", verifiedBy: undefined }]}
      />
    );
    expect(screen.queryByTestId("feed-reference-masked")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("2F42");
  });

  it("shows it in the detail's Reference row instead of the ledger sequence", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed locale="en" contributions={[VERIFIED]} />);
    await user.click(screen.getByText("Contribution #8"));
    const row = screen.getByText("Reference:").parentElement!;
    expect(row).toHaveTextContent(`${B}2F42`);
    expect(row).not.toHaveTextContent("#8");
  });

  it("renders in Amharic too", () => {
    render(<ContributionFeed locale="am" contributions={[VERIFIED]} />);
    const badge = screen.getByTestId("feed-reference-masked").parentElement!;
    expect(badge).toHaveTextContent(`የተረጋገጠ · ${B}2F42`);
  });
});

describe("member cards", () => {
  it("draws each row's avatar in a frame chosen from the member id, the same one every render", () => {
    const rows: MemberContribution[] = [
      VERIFIED,
      { ...VERIFIED, id: "e2", name: "Contribution #9", memberId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { id: "e3", name: "Contribution #10", source: "ledger", status: "PROVISIONAL" }
    ];
    const first = render(<ContributionFeed locale="en" contributions={rows} />);
    const frames = screen.getAllByTestId("member-avatar").map((node) => node.getAttribute("data-frame"));
    expect(frames).toHaveLength(3);
    // A row with no known payer gets the neutral default.
    expect(frames[2]).toBe("diamond");
    first.unmount();
    render(<ContributionFeed locale="en" contributions={rows} />);
    expect(screen.getAllByTestId("member-avatar").map((node) => node.getAttribute("data-frame"))).toEqual(frames);
  });

  it("does not choose a shawl from the name: none is drawn unless the member chose one", () => {
    render(
      <ContributionFeed
        locale="en"
        contributions={[
          { ...VERIFIED, name: "Abebech" },
          { ...VERIFIED, id: "e2", name: "Kebede" }
        ]}
      />
    );
    for (const node of screen.getAllByTestId("member-avatar")) {
      expect(node).toHaveAttribute("data-attire", "none");
    }
  });

  it("draws and names a chosen Gabi or Netela", () => {
    render(
      <ContributionFeed
        locale="en"
        contributions={[
          { ...VERIFIED, attire: "gabi" },
          { ...VERIFIED, id: "e2", name: "Contribution #9", attire: "netela" }
        ]}
      />
    );
    expect(screen.getByRole("img", { name: "Contribution #8 — wearing a gabi" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Contribution #9 — wearing a netela" })).toBeInTheDocument();
  });
});
