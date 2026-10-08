import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ session: { status: "unconfigured" } as Record<string, unknown> }));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));

import { SignInPanel } from "@/components/auth/SignInPanel";

describe("SignInPanel", () => {
  it("shows a clear not-configured state and no form when Supabase env is missing", () => {
    hoisted.session = { status: "unconfigured" };
    render(<SignInPanel initialLocale="en" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in is not ready yet");
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  it("offers the email form when signed out", () => {
    hoisted.session = { status: "signed-out" };
    render(<SignInPanel initialLocale="en" />);
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send sign-in link" })).toBeInTheDocument();
  });

  it("offers sign-out when signed in", () => {
    hoisted.session = { status: "signed-in", accessToken: "t", email: "a@b.co" };
    render(<SignInPanel initialLocale="en" />);
    expect(screen.getByTestId("signed-in-as")).toHaveTextContent("Signed in as a@b.co");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("headings: Sign in when signed out, Account when signed in (en and am)", () => {
    hoisted.session = { status: "signed-out" };
    const out = render(<SignInPanel initialLocale="en" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in");
    out.unmount();

    hoisted.session = { status: "signed-in", accessToken: "t", email: "a@b.co" };
    const en = render(<SignInPanel initialLocale="en" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    en.unmount();

    render(<SignInPanel initialLocale="am" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("መለያ");
  });
});
