import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/useSession", () => ({
  useSession: () => ({ status: "signed-in", userId: "u1", email: "a@example.test", accessToken: "t" })
}));

import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";
import type { FetchedGroups } from "@/lib/groups/activeGroup";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => cleanup());

describe("the active group is re-read when membership may have changed", () => {
  it("reloads when the tab becomes visible again and when the connection returns", async () => {
    const fetchGroups = vi.fn(
      async (): Promise<FetchedGroups> => ({ kind: "ok", groups: [{ groupId: A, name: "Bole", role: "owner" }], userId: "u1" })
    );
    render(
      <ActiveGroupProvider fetchGroups={fetchGroups} storage={window.localStorage}>
        <span />
      </ActiveGroupProvider>
    );
    await waitFor(() => expect(fetchGroups).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchGroups).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchGroups).toHaveBeenCalledTimes(2));

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(fetchGroups).toHaveBeenCalledTimes(3));
  });
});
