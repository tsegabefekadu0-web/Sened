import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  pref: { ready: true, groupId: "a" as string | null, reload: vi.fn() },
  result: { status: "choose-group" } as Record<string, unknown>,
  load: vi.fn()
}));

vi.mock("@/lib/groups/useActiveGroup", () => ({ useActiveGroupPreference: () => hoisted.pref }));
vi.mock("@/lib/ledger/clientHome", () => ({ loadHomeLedger: (...args: unknown[]) => hoisted.load(...args) }));

import { useHomeLedger } from "@/lib/ledger/useHomeLedger";
import { translate } from "@/lib/i18n";
import { render, screen } from "@testing-library/react";
import { WorkspaceLinks } from "@/components/shell/WorkspaceLinks";

const session = { status: "signed-in", accessToken: "t", email: "a@example.test", userId: "u" } as never;

beforeEach(() => {
  hoisted.pref = { ready: true, groupId: "a", reload: vi.fn() };
  hoisted.load.mockReset().mockImplementation(async () => hoisted.result);
});

describe("the home ledger and the active group", () => {
  it("reloads the active group when the server says choose-group", async () => {
    hoisted.result = { status: "choose-group" };
    renderHook(() => useHomeLedger(session));
    await waitFor(() => expect(hoisted.pref.reload).toHaveBeenCalled());
  });

  it("reloads when the server resolved a different group than the active one", async () => {
    hoisted.result = { status: "empty", groupId: "b" };
    renderHook(() => useHomeLedger(session));
    await waitFor(() => expect(hoisted.pref.reload).toHaveBeenCalled());
  });

  it("does not reload when the server agrees", async () => {
    hoisted.result = { status: "empty", groupId: "a" };
    const { result } = renderHook(() => useHomeLedger(session));
    await waitFor(() => expect(result.current.kind).toBe("live"));
    expect(hoisted.pref.reload).not.toHaveBeenCalled();
  });
});

describe("hardcoded labels now come from the dictionary", () => {
  it("labels the tools navigation in both languages", () => {
    const { unmount } = render(<WorkspaceLinks locale="en" />);
    expect(screen.getByRole("navigation", { name: translate("en", "shell.builtTools") })).toBeInTheDocument();
    unmount();
    render(<WorkspaceLinks locale="am" />);
    expect(screen.getByRole("navigation", { name: translate("am", "shell.builtTools") })).toBeInTheDocument();
    expect(translate("am", "shell.builtTools")).not.toBe(translate("en", "shell.builtTools"));
  });
});
