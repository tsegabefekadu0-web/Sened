import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SenedShell } from "@/components/sened-shell";

describe("Sened shell", () => {
  it("renders the Milestone 2 dashboard with accessible navigation", () => {
    render(<SenedShell />);

    expect(screen.getByRole("heading", { level: 1, name: "The ledger tells the whole story." })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("Append-only history")).toBeInTheDocument();
  });

  it("switches the dashboard copy to Amharic", async () => {
    const user = userEvent.setup();
    render(<SenedShell />);

    await user.click(screen.getByRole("button", { name: "Change language" }));

    expect(screen.getByRole("heading", { level: 1, name: "መዝገቡ ሙሉ ታሪክን ይናገራል።" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ቋንቋ ቀይር" })).toHaveAttribute("aria-pressed", "true");
  });
});
