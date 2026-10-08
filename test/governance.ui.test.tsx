import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import GovernancePage from "@/app/governance/page";
import { GovernanceCopilot, type CitationConfirmationState } from "@/components/governance/GovernanceCopilot";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";
import { createTranslator } from "@/lib/i18n";

const en = createTranslator("en");
const am = createTranslator("am");

const bundled = async (): Promise<CitationConfirmationState> => ({ kind: "bundled" });

async function fill(user: ReturnType<typeof userEvent.setup>, label: string | RegExp, value: string) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  await user.type(input, value);
}

async function next(user: ReturnType<typeof userEvent.setup>, name = en("governance.next")) {
  await user.click(screen.getByRole("button", { name }));
}

async function answerEqub(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /Equb/ }));
  await next(user);
  await fill(user, en("governance.q.memberCount"), "12");
  await next(user);
  await fill(user, en("governance.q.contribution"), "1000");
  await next(user);
  await fill(user, en("governance.q.cycleLength"), "30");
  await next(user);
  await user.click(screen.getByRole("radio", { name: new RegExp(en("governance.trust.mixed")) }));
  await next(user, en("governance.seeResults"));
}

describe("GovernanceCopilot dialog", () => {
  it("walks an Equb treasurer from questions to cited clauses", async () => {
    const user = userEvent.setup();
    render(<GovernanceCopilot locale="en" loadConfirmations={bundled} />);

    expect(screen.getByTestId("governance-progress")).toHaveTextContent("Question 1 of 5");
    await answerEqub(user);

    const results = document.querySelector('[data-governance-panel="results"]') as HTMLElement;
    expect(results).not.toBeNull();
    expect(screen.getByTestId("governance-summary")).toHaveTextContent(
      "Equb: 12 members, 1,000.00 ETB every 30 days"
    );
    for (const id of ["late.equb", "replacement.equb", "default.reserve"]) {
      expect(results.querySelector(`[data-clause="${id}"]`)).not.toBeNull();
    }
    // The late penalty is 3% of 1,000.00 for a mixed group.
    const late = within(results.querySelector('[data-clause="late.equb"]') as HTMLElement);
    expect(late.getByText(/3% of the contribution \(30\.00 ETB\)/)).toBeInTheDocument();

    // Citation chips link to arXiv.
    const chip = within(results.querySelector('[data-clause="default.reserve"]') as HTMLElement)
      .getAllByRole("link")
      .find((link) => link.getAttribute("data-citation") === "abebe2022") as HTMLAnchorElement;
    expect(chip).toHaveAttribute("href", "https://arxiv.org/abs/2203.12486");
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip.getAttribute("rel")).toContain("noopener");

    // Journal articles are shown but not linked.
    expect(results.querySelector('span[data-citation="besley1993"]')).not.toBeNull();

    await waitFor(() =>
      expect(screen.getByTestId("governance-source-status")).toHaveTextContent(
        "Citations come from the list bundled with Sened"
      )
    );
    expect(screen.getByText(en("governance.advisory"), { selector: "p" })).toBeInTheDocument();
  });

  it("asks the two extra Iddir questions and builds the emergency fund clause", async () => {
    const user = userEvent.setup();
    render(<GovernanceCopilot locale="en" loadConfirmations={bundled} />);
    await user.click(screen.getByRole("radio", { name: /Iddir/ }));
    expect(screen.getByTestId("governance-progress")).toHaveTextContent("Question 1 of 7");
    await next(user);
    await fill(user, en("governance.q.memberCount"), "40");
    await next(user);
    await fill(user, en("governance.q.contribution"), "100");
    await next(user);
    await fill(user, en("governance.q.cycleLength"), "30");
    await next(user);
    await user.click(screen.getByRole("radio", { name: new RegExp(en("governance.trust.close")) }));
    await next(user);
    await fill(user, en("governance.q.typicalClaim"), "20000");
    await next(user);
    await fill(user, en("governance.q.fundBalance"), "0");
    await next(user, en("governance.seeResults"));

    const fund = document.querySelector('[data-clause="emergency.fund"]') as HTMLElement;
    expect(fund).not.toBeNull();
    expect(within(fund).getByText(/40,000\.00 ETB/, { selector: "p" })).toBeInTheDocument();
    expect(document.querySelector('[data-clause="default.reserve"]')).toBeNull();
  });

  it("blocks each step until it has a valid answer and explains why", async () => {
    const user = userEvent.setup();
    render(<GovernanceCopilot locale="en" loadConfirmations={bundled} />);

    await next(user);
    expect(screen.getByRole("alert")).toHaveTextContent(en("governance.q.groupType"));
    await user.click(screen.getByRole("radio", { name: /Equb/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    await next(user);

    await fill(user, en("governance.q.memberCount"), "1");
    await next(user);
    expect(screen.getByRole("alert")).toHaveTextContent(en("governance.error.memberCount"));
    expect(screen.getByLabelText(en("governance.q.memberCount"))).toHaveAttribute("aria-invalid", "true");
    await fill(user, en("governance.q.memberCount"), "8");
    await next(user);

    await fill(user, en("governance.q.contribution"), "0");
    await next(user);
    expect(screen.getByRole("alert")).toHaveTextContent(en("governance.error.amount"));
    await fill(user, en("governance.q.contribution"), "12.345");
    await next(user);
    expect(screen.getByRole("alert")).toHaveTextContent(en("governance.error.amount"));
  });

  it("lets the treasurer go back, keeps answers, and starts over", async () => {
    const user = userEvent.setup();
    render(<GovernanceCopilot locale="en" loadConfirmations={bundled} />);
    await user.click(screen.getByRole("radio", { name: /Equb/ }));
    await next(user);
    await fill(user, en("governance.q.memberCount"), "9");
    await user.click(screen.getByRole("button", { name: en("governance.back") }));
    expect(screen.getByRole("radio", { name: /Equb/ })).toHaveAttribute("aria-checked", "true");
    await next(user);
    expect(screen.getByLabelText(en("governance.q.memberCount"))).toHaveValue("9");

    await next(user);
    await fill(user, en("governance.q.contribution"), "500");
    await next(user);
    await fill(user, en("governance.q.cycleLength"), "7");
    await next(user);
    await user.click(screen.getByRole("radio", { name: new RegExp(en("governance.trust.new")) }));
    await next(user, en("governance.seeResults"));
    await user.click(screen.getByRole("button", { name: en("governance.startOver") }));
    expect(screen.getByTestId("governance-progress")).toHaveTextContent("Question 1 of 5");
    expect(screen.getByRole("radio", { name: /Equb/ })).toHaveAttribute("aria-checked", "false");
  });

  it("renders in Amharic", async () => {
    const user = userEvent.setup();
    render(<GovernanceCopilot locale="am" loadConfirmations={bundled} />);
    expect(screen.getByText(am("governance.q.groupType"))).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: am("governance.option.equb") }));
    await next(user, am("governance.next"));
    expect(screen.getByText(am("governance.q.memberCount"))).toBeInTheDocument();
  });

  it("marks citations found / not found only when ScholarXIV actually confirmed them", async () => {
    const user = userEvent.setup();
    const confirmed = vi.fn(
      async (): Promise<CitationConfirmationState> => ({
        kind: "scholarxiv",
        found: new Set(["abebe2022"]),
        total: 6
      })
    );
    render(<GovernanceCopilot locale="en" loadConfirmations={confirmed} />);
    await answerEqub(user);

    await waitFor(() =>
      expect(screen.getByTestId("governance-source-status")).toHaveTextContent(
        "Checked against the ScholarXIV Papers API: 1 of 6 found"
      )
    );
    expect(confirmed).toHaveBeenCalledTimes(1);
    const abebe = document.querySelector('a[data-citation="abebe2022"]') as HTMLElement;
    expect(abebe).toHaveTextContent("✓");
    expect(abebe).toHaveTextContent(en("governance.cite.confirmed"));
    const wang = document.querySelector('a[data-citation="wang2021"]') as HTMLElement;
    expect(wang).toHaveTextContent(en("governance.cite.notFound"));
    expect(wang).not.toHaveTextContent("✓");
  });

  it("says so when ScholarXIV could not be reached, and keeps the bundled chips", async () => {
    const user = userEvent.setup();
    render(
      <GovernanceCopilot
        locale="en"
        loadConfirmations={async () => {
          throw new Error("network");
        }}
      />
    );
    await answerEqub(user);
    await waitFor(() =>
      expect(screen.getByTestId("governance-source-status")).toHaveTextContent(en("governance.source.unavailable"))
    );
    expect(document.querySelector('a[data-citation="abebe2022"]')).not.toBeNull();
    expect(document.body).not.toHaveTextContent(en("governance.cite.confirmed"));
  });
});

describe("/governance page and navigation", () => {
  it("defaults to Amharic and toggles to English", async () => {
    const user = userEvent.setup();
    render(<GovernancePage />);
    expect(screen.getByText(am("governance.q.groupType"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: am("shell.switchToEnglish") }));
    expect(screen.getByText(en("governance.q.groupType"))).toBeInTheDocument();
  });

  it("is linked from the workspace links", () => {
    render(<WorkspaceLinks />);
    expect(screen.getByRole("link", { name: /Bylaws/ })).toHaveAttribute("href", "/governance");
  });
});
