import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { status: "signed-out" } as Record<string, unknown>,
  community: { mode: "live", role: "member" } as Record<string, unknown>
}));

vi.mock("@/lib/auth/useSession", () => ({ useSession: () => h.session }));
vi.mock("@/lib/ui/useCommunity", () => ({ useCommunity: () => h.community }));
vi.mock("@/components/draw-console/LiveDraw", () => ({ LiveDraw: () => <div data-testid="draw-live" /> }));
vi.mock("@/components/ui/BottomNav", () => ({ BottomNav: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/draw/manage", useRouter: () => ({ push: vi.fn() }) }));

import ManageDrawPage from "@/app/draw/manage/page";

beforeEach(() => {
  h.session = { status: "signed-out" };
  h.community = { mode: "live", role: "member" };
});

describe("/draw/manage role gating", () => {
  it("signed out: asks to sign in and shows no console", () => {
    render(<ManageDrawPage />);
    expect(screen.getByTestId("manage-refusal")).toBeInTheDocument();
    expect(screen.queryByTestId("draw-live")).toBeNull();
    expect(screen.queryByTestId("manage-treasurer")).toBeNull();
  });

  it("a plain member gets the member view, never the treasurer one", () => {
    h.session = { status: "signed-in", accessToken: "t", email: "m@example.com" };
    render(<ManageDrawPage />);
    expect(screen.getByTestId("manage-member")).toBeInTheDocument();
    expect(screen.queryByTestId("manage-treasurer")).toBeNull();
  });

  it.each(["treasurer", "owner"])("%s gets the treasurer console", (role) => {
    h.session = { status: "signed-in", accessToken: "t", email: "t@example.com" };
    h.community = { mode: "live", role };
    render(<ManageDrawPage />);
    expect(screen.getByTestId("manage-treasurer")).toBeInTheDocument();
    expect(screen.getByTestId("draw-live")).toBeInTheDocument();
  });

  it("shows loading screen while session is resolving", () => {
    h.session = { status: "loading" };
    render(<ManageDrawPage />);
    expect(screen.queryByTestId("manage-refusal")).toBeNull();
    expect(screen.queryByTestId("draw-live")).toBeNull();
  });

  it("shows correct treasurer notes for owner and treasurer", () => {
    h.session = { status: "signed-in", accessToken: "t", email: "owner@example.com" };
    h.community = { mode: "live", role: "owner" };
    const { rerender } = render(<ManageDrawPage />);
    expect(screen.getByTestId("manage-treasurer")).toBeInTheDocument();

    h.community = { mode: "live", role: "treasurer" };
    rerender(<ManageDrawPage />);
    expect(screen.getByTestId("manage-treasurer")).toBeInTheDocument();
  });
});
