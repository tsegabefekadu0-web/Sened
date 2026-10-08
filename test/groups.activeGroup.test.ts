import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ActiveGroupStore,
  clearRemembered,
  parseGroupOptions,
  readRemembered,
  resolveActiveGroupId,
  serverDisagreesWithActiveGroup,
  writeRemembered,
  type FetchedGroups,
  type GroupOption
} from "@/lib/groups/activeGroup";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GA: GroupOption = { groupId: A, name: "Bole Equb", role: "owner" };
const GB: GroupOption = { groupId: B, name: "Family Iddir", role: "member" };

function ok(groups: GroupOption[], userId: string | null = "u1"): FetchedGroups {
  return { kind: "ok", groups, userId };
}

function makeStore(results: FetchedGroups[]) {
  const queue = [...results];
  const fetchGroups = vi.fn(async (): Promise<FetchedGroups> => queue.shift() ?? results[results.length - 1] ?? { kind: "error" });
  return { store: new ActiveGroupStore({ fetchGroups, storage: window.localStorage }), fetchGroups };
}

async function settled(store: ActiveGroupStore) {
  await vi.waitFor(() => expect(store.getState().status).not.toBe("loading"));
  return store.getState();
}

beforeEach(() => window.localStorage.clear());

describe("resolveActiveGroupId", () => {
  it("is the only group, with no question asked", () => {
    expect(resolveActiveGroupId([GA], null)).toBe(A);
    expect(resolveActiveGroupId([GA], C)).toBe(A);
  });
  it("is the remembered group when it is still one of several", () => {
    expect(resolveActiveGroupId([GA, GB], B)).toBe(B);
  });
  it("is nothing for several groups without a valid remembered one", () => {
    expect(resolveActiveGroupId([GA, GB], null)).toBeNull();
    expect(resolveActiveGroupId([GA, GB], C)).toBeNull();
    expect(resolveActiveGroupId([], A)).toBeNull();
  });
});

describe("parseGroupOptions", () => {
  it("keeps only well-formed groups and invents no name or role", () => {
    expect(
      parseGroupOptions([
        { groupId: A, name: " Bole ", role: "owner", accounts: [] },
        { groupId: B, role: "king" },
        { groupId: A, name: "dup" },
        { name: "no id" },
        null
      ])
    ).toEqual([
      { groupId: A, name: "Bole", role: "owner" },
      { groupId: B, name: "", role: null }
    ]);
    expect(parseGroupOptions("nope")).toEqual([]);
  });
});

describe("ActiveGroupStore", () => {
  it("auto-selects the only group", async () => {
    const { store } = makeStore([ok([GA])]);
    store.setIdentity("u1", "u1");
    expect(store.getState().status).toBe("loading");
    expect(await settled(store)).toMatchObject({ status: "ready", activeGroupId: A, needsChoice: false });
  });

  it("asks when there are several groups and nothing is remembered", async () => {
    const { store } = makeStore([ok([GA, GB])]);
    store.setIdentity("u1", "u1");
    expect(await settled(store)).toMatchObject({ status: "ready", activeGroupId: null, needsChoice: true });
  });

  it("uses the remembered choice, and remembers a new one per user", async () => {
    writeRemembered("u1", B, window.localStorage);
    const first = makeStore([ok([GA, GB])]);
    first.store.setIdentity("u1", "u1");
    expect(await settled(first.store)).toMatchObject({ activeGroupId: B, needsChoice: false });

    first.store.select(A);
    expect(first.store.getState()).toMatchObject({ activeGroupId: A, needsChoice: false });
    expect(readRemembered("u1", window.localStorage)).toBe(A);

    // A fresh store (a reload) comes back to the same choice.
    const second = makeStore([ok([GA, GB])]);
    second.store.setIdentity("u1", "u1");
    expect(await settled(second.store)).toMatchObject({ activeGroupId: A });
  });

  it("ignores a stale remembered id that is no longer one of the user's groups", async () => {
    writeRemembered("u1", C, window.localStorage);
    const { store } = makeStore([ok([GA, GB])]);
    store.setIdentity("u1", "u1");
    expect(await settled(store)).toMatchObject({ activeGroupId: null, needsChoice: true });
  });

  it("ignores a select of a group the user does not belong to", async () => {
    const { store } = makeStore([ok([GA, GB])]);
    store.setIdentity("u1", "u1");
    await settled(store);
    store.select(C);
    expect(store.getState()).toMatchObject({ activeGroupId: null, needsChoice: true });
    expect(readRemembered("u1", window.localStorage)).toBeNull();
  });

  it("never puts another user's choice in effect", async () => {
    writeRemembered("u1", B, window.localStorage);
    const { store } = makeStore([ok([GA, GB], "u2")]);
    store.setIdentity("u2", "u2");
    expect(await settled(store)).toMatchObject({ activeGroupId: null, needsChoice: true });
    // ...and u2's own choice does not overwrite u1's.
    store.select(A);
    expect(readRemembered("u1", window.localStorage)).toBe(B);
    expect(readRemembered("u2", window.localStorage)).toBe(A);
  });

  it("discards the previous identity's state when another user signs in, even before the read returns", async () => {
    let release!: (value: FetchedGroups) => void;
    const fetchGroups = vi
      .fn()
      .mockResolvedValueOnce(ok([GA, GB], "u1"))
      .mockImplementationOnce(() => new Promise<FetchedGroups>((resolve) => (release = resolve)));
    const store = new ActiveGroupStore({ fetchGroups, storage: window.localStorage });
    store.setIdentity("u1", "u1");
    await settled(store);
    store.select(B);

    store.setIdentity("u2", "u2");
    expect(store.getState()).toMatchObject({ status: "loading", identity: "u2", activeGroupId: null, groups: [] });
    release(ok([GA], "u2"));
    expect(await settled(store)).toMatchObject({ identity: "u2", activeGroupId: A });
  });

  it("drops a read that was overtaken by a sign-out", async () => {
    let release!: (value: FetchedGroups) => void;
    const fetchGroups = vi.fn(() => new Promise<FetchedGroups>((resolve) => (release = resolve)));
    const store = new ActiveGroupStore({ fetchGroups, storage: window.localStorage });
    store.setIdentity("u1", "u1");
    store.setIdentity(null);
    release(ok([GA]));
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ status: "idle", identity: null, activeGroupId: null, groups: [] });
  });

  it("clears the choice and the cached list on sign-out", async () => {
    const { store } = makeStore([ok([GA, GB])]);
    store.setIdentity("u1", "u1");
    await settled(store);
    store.select(B);
    expect(readRemembered("u1", window.localStorage)).toBe(B);
    expect(window.localStorage.getItem("sened.groups.v1.u1")).not.toBeNull();

    store.setIdentity(null);
    expect(store.getState()).toMatchObject({ status: "idle", groups: [], activeGroupId: null });
    expect(readRemembered("u1", window.localStorage)).toBeNull();
    expect(window.localStorage.getItem("sened.groups.v1.u1")).toBeNull();
  });

  it("learns the user id from the server when the session has none, and still isolates users", async () => {
    const { store } = makeStore([ok([GA, GB], "server-user")]);
    store.setIdentity("t@example.test", null);
    await settled(store);
    store.select(A);
    expect(readRemembered("server-user", window.localStorage)).toBe(A);
    store.setIdentity(null);
    expect(readRemembered("server-user", window.localStorage)).toBeNull();
  });

  it("reports no-group, unauthorized and error as their own states", async () => {
    for (const [result, status] of [
      [ok([]), "no-group"],
      [{ kind: "unauthorized" }, "unauthorized"],
      [{ kind: "error" }, "error"]
    ] as const) {
      const { store } = makeStore([result as FetchedGroups]);
      store.setIdentity("u1", "u1");
      expect(await settled(store)).toMatchObject({ status, activeGroupId: null, groups: [] });
    }
  });

  it("falls back to the last list saved on this device when the server cannot be reached", async () => {
    const online = makeStore([ok([GA, GB])]);
    online.store.setIdentity("u1", "u1");
    await settled(online.store);
    online.store.select(B);

    const offline = makeStore([{ kind: "error" }]);
    offline.store.setIdentity("u1", "u1");
    expect(await settled(offline.store)).toMatchObject({ status: "ready", activeGroupId: B, stale: true });
  });

  it("does not use another user's cached list offline", async () => {
    const online = makeStore([ok([GA, GB], "u1")]);
    online.store.setIdentity("u1", "u1");
    await settled(online.store);

    const offline = makeStore([{ kind: "error" }]);
    offline.store.setIdentity("u2", "u2");
    expect(await settled(offline.store)).toMatchObject({ status: "error", groups: [], activeGroupId: null });
  });

  it("reload can adopt a group that was just joined", async () => {
    const { store } = makeStore([ok([GA]), ok([GA, GB])]);
    store.setIdentity("u1", "u1");
    await settled(store);
    expect(store.getState().activeGroupId).toBe(A);
    store.reload(B);
    await vi.waitFor(() => expect(store.getState().groups).toHaveLength(2));
    expect(store.getState()).toMatchObject({ activeGroupId: B, needsChoice: false });
  });

  it("notifies subscribers on every change and stops after unsubscribe", async () => {
    const { store } = makeStore([ok([GA, GB])]);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setIdentity("u1", "u1");
    await settled(store);
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    store.select(A);
    expect(listener.mock.calls.length).toBe(calls + 1);
    off();
    store.select(B);
    expect(listener.mock.calls.length).toBe(calls + 1);
  });

  it("works when localStorage throws: the choice just is not remembered", async () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      }
    } as unknown as Storage;
    const store = new ActiveGroupStore({ fetchGroups: async () => ok([GA, GB]), storage: broken });
    store.setIdentity("u1", "u1");
    await settled(store);
    expect(store.getState().needsChoice).toBe(true);
    store.select(B);
    expect(store.getState().activeGroupId).toBe(B);
    store.setIdentity(null);
    expect(clearRemembered("u1", broken)).toBeUndefined();
  });
});

describe("review fixes: payer cache and server disagreement", () => {
  it("clears the cached payer lists on sign-out and when the account changes", async () => {
    window.localStorage.setItem("sened.payers.v1", JSON.stringify({ [A]: { members: [], cycles: [] } }));
    const { store } = makeStore([ok([GA])]);
    store.setIdentity("alice", "u1");
    await settled(store);
    expect(window.localStorage.getItem("sened.payers.v1")).not.toBeNull();
    store.setIdentity(null);
    expect(window.localStorage.getItem("sened.payers.v1")).toBeNull();

    window.localStorage.setItem("sened.payers.v1", "{}");
    const second = makeStore([ok([GA]), ok([GB], "u2")]).store;
    second.setIdentity("alice", "u1");
    await settled(second);
    second.setIdentity("bob", "u2");
    expect(window.localStorage.getItem("sened.payers.v1")).toBeNull();
  });

  it("serverDisagreesWithActiveGroup is true for choose-group and for a different resolved group", () => {
    expect(serverDisagreesWithActiveGroup({ status: "choose-group" }, A)).toBe(true);
    expect(serverDisagreesWithActiveGroup({ status: "ready", groupId: B }, A)).toBe(true);
    expect(serverDisagreesWithActiveGroup({ status: "ready", groupId: A }, A)).toBe(false);
    expect(serverDisagreesWithActiveGroup({ status: "ok", groupId: A }, null)).toBe(true);
    expect(serverDisagreesWithActiveGroup({ status: "error" }, A)).toBe(false);
  });

  it("reload re-reads the groups and drops a group the user has left", async () => {
    const { store, fetchGroups } = makeStore([ok([GA, GB]), ok([GA])]);
    store.setIdentity("alice", "u1");
    await settled(store);
    store.select(B);
    expect(store.getState().activeGroupId).toBe(B);
    store.reload();
    await vi.waitFor(() => expect(fetchGroups).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().activeGroupId).toBe(A));
  });
});
