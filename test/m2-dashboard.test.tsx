import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { M2Dashboard } from "@/components/ledger/m2-dashboard";
import { SenedShell } from "@/components/sened-shell";

describe("Milestone 2 dashboard", () => {
  it("renders integrity, verified, pending, rejected, and manual-review states", () => {
    render(<M2Dashboard />);

    expect(screen.getByText("Ledger integrity")).toBeInTheDocument();
    expect(screen.getByText("Chain intact")).toBeInTheDocument();
    expect(screen.getByText("Ledger verified")).toBeInTheDocument();
    expect(screen.getAllByText("Pending reconciliation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Manual review required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rejected").length).toBeGreaterThan(0);
    expect(screen.getByText("Append-only history")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("No live bank connection. Configure the provider before requesting bank evidence.")).toBeInTheDocument();
  });

  it("keeps the pending reconciliation amount outside the trusted balance", () => {
    render(<M2Dashboard />);

    const trustedBalance = screen.getByTestId("trusted-balance");
    const pendingBalance = screen.getByTestId("pending-excluded");

    expect(trustedBalance).toHaveTextContent("186,450.00 ETB");
    expect(pendingBalance).toHaveTextContent("12,500.00 ETB");
    expect(trustedBalance).not.toHaveTextContent("12,500.00 ETB");
    expect(screen.getByTestId("pending-exclusion-note")).toHaveTextContent("excluded from the trusted balance");
  });

  it("requires a rationale before creating a compensating entry", async () => {
    const user = userEvent.setup();
    render(<M2Dashboard />);

    await user.click(screen.getAllByRole("button", { name: "Start a correction" })[0]);
    const form = screen.getByRole("form", { name: "Create a compensating entry" });
    const submit = within(form).getByRole("button", { name: "Create compensating entry" });

    await user.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Add a correction rationale before creating the entry.");

    await user.type(within(form).getByRole("textbox", { name: /Correction rationale/ }), "Duplicate contribution recorded");
    await user.click(submit);

    expect(screen.getByText("Demo compensating entry created")).toBeInTheDocument();
    expect(screen.getAllByText("Original TXN-4281 is preserved.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Compensating entry").length).toBeGreaterThan(0);
  });

  it("switches the dashboard between English and Amharic", async () => {
    const user = userEvent.setup();
    render(<SenedShell />);

    await user.click(screen.getByRole("button", { name: "Change language" }));

    expect(screen.getByRole("heading", { level: 1, name: "መዝገቡ ሙሉ ታሪክን ይናገራል።" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "የተረጋገጠ ቀሪ ሂሳብ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ቋንቋ ቀይር" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not expose edit or delete controls", () => {
    render(<M2Dashboard />);

    expect(screen.queryByRole("button", { name: /edit|delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /edit|delete/i })).not.toBeInTheDocument();
  });
});
