import { describe, expect, it, vi } from "vitest";

import {
  buildJoinUrl,
  clearPendingInvite,
  createInviteLink,
  loadInvites,
  loadMembers,
  loadMyGroup,
  parseTokenFromHash,
  peekPendingInvite,
  redeemInviteToken,
  revokeInviteLink,
  setTreasurer,
  stashPendingInvite,
  saveMyAttire
} from "@/lib/ledger/clientInvites";

const TOKEN = "b".repeat(64);
const GROUP = "22222222-2222-4222-8222-222222222222";

function deps(status: number, body: unknown = {}) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  return { deps: { getToken: async () => "jwt", fetchImpl: fetchImpl as unknown as typeof fetch }, fetchImpl };
}

describe("join URL", () => {
  it("puts the token in the fragment, never the query", () => {
    const url = buildJoinUrl("https://sened.test", TOKEN);
    expect(url).toBe(`https://sened.test/join#token=${TOKEN}`);
    expect(new URL(url).search).toBe("");
  });

  it("parses a valid fragment and rejects malformed ones", () => {
    expect(parseTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(parseTokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
    expect(parseTokenFromHash("")).toBeNull();
    expect(parseTokenFromHash("#token=short")).toBeNull();
    expect(parseTokenFromHash("#other=1")).toBeNull();
    expect(parseTokenFromHash("#token=" + "x".repeat(300))).toBeNull();
  });
});

describe("redeemInviteToken", () => {
  it("sends the token in the POST body with a Bearer header", async () => {
    const { deps: d, fetchImpl } = deps(200, { outcome: "joined", groupId: GROUP, role: "member" });
    expect(await redeemInviteToken(TOKEN, d)).toEqual({ status: "joined", groupId: GROUP });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ledger/invites/redeem");
    expect(url).not.toContain(TOKEN);
    expect(init.body).toBe(JSON.stringify({ token: TOKEN }));
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt");
  });

  it("maps every outcome", async () => {
    expect(await redeemInviteToken(TOKEN, deps(200, { outcome: "already_member", groupId: GROUP }).deps)).toEqual({
      status: "already_member",
      groupId: GROUP
    });
    expect(await redeemInviteToken(TOKEN, deps(410, { error: "invite_expired" }).deps)).toEqual({ status: "expired" });
    expect(await redeemInviteToken(TOKEN, deps(410, { error: "invite_revoked" }).deps)).toEqual({ status: "revoked" });
    expect(await redeemInviteToken(TOKEN, deps(410, { error: "invite_exhausted" }).deps)).toEqual({ status: "exhausted" });
    expect(await redeemInviteToken(TOKEN, deps(404, { error: "not_found" }).deps)).toEqual({ status: "invalid" });
    expect(await redeemInviteToken(TOKEN, deps(401).deps)).toEqual({ status: "unauthorized" });
    expect(await redeemInviteToken(TOKEN, deps(429).deps)).toEqual({ status: "rate-limited" });
    expect(await redeemInviteToken(TOKEN, deps(502).deps)).toEqual({ status: "error" });
    expect(await redeemInviteToken(TOKEN, deps(200, { nope: 1 }).deps)).toEqual({ status: "error" });
  });

  it("is unauthorized, sending nothing, when signed out", async () => {
    const fetchImpl = vi.fn();
    const result = await redeemInviteToken(TOKEN, { getToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ status: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure as error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await redeemInviteToken(TOKEN, { getToken: async () => "jwt", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      status: "error"
    });
  });
});

describe("createInviteLink", () => {
  it("returns the created invite", async () => {
    const body = { inviteId: "i", token: TOKEN, expiresAt: "2026-10-08T00:00:00Z", maxUses: 3 };
    const { deps: d, fetchImpl } = deps(201, body);
    expect(await createInviteLink({ groupId: GROUP, expiresInHours: 24, maxUses: 3 }, d)).toEqual({ status: "created", ...body });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe(
      JSON.stringify({ groupId: GROUP, expiresInHours: 24, maxUses: 3 })
    );
  });

  it("maps failures", async () => {
    const input = { groupId: GROUP, expiresInHours: 24, maxUses: 1 };
    expect((await createInviteLink(input, deps(403).deps)).status).toBe("forbidden");
    expect((await createInviteLink(input, deps(400).deps)).status).toBe("invalid");
    expect((await createInviteLink(input, deps(429).deps)).status).toBe("rate-limited");
    expect((await createInviteLink(input, deps(201, {}).deps)).status).toBe("error");
  });
});

describe("loadInvites, loadMembers, loadMyGroup", () => {
  it("parses invites and rejects malformed rows", async () => {
    const row = { inviteId: "i", expiresAt: "x", maxUses: 2, useCount: 1, status: "active" };
    expect(await loadInvites(GROUP, deps(200, { invites: [row] }).deps)).toEqual({ status: "ready", invites: [row] });
    expect((await loadInvites(GROUP, deps(200, { invites: [{ inviteId: 1 }] }).deps)).status).toBe("error");
    expect((await loadInvites(GROUP, deps(403).deps)).status).toBe("forbidden");
  });

  it("parses members", async () => {
    const row = { userId: "u", role: "member", joinedAt: "x", email: null };
    // An absent attire (a database one migration behind) reads as none.
    expect(await loadMembers(GROUP, deps(200, { members: [row] }).deps)).toEqual({ status: "ready", members: [{ ...row, attire: "none" }] });
    const shawled = { ...row, attire: "netela" };
    expect(await loadMembers(GROUP, deps(200, { members: [shawled] }).deps)).toEqual({ status: "ready", members: [shawled] });
    // An unknown value fails the read rather than drawing a guessed shawl.
    for (const bad of ["female", "", 3, "GABI"]) {
      expect((await loadMembers(GROUP, deps(200, { members: [{ ...row, attire: bad }] }).deps)).status, String(bad)).toBe("error");
    }
    expect((await loadMembers(GROUP, deps(200, { members: [{ ...row, role: "king" }] }).deps)).status).toBe("error");
    expect((await loadMembers(GROUP, deps(403).deps)).status).toBe("forbidden");
  });

  it("picks the single group and refuses to guess among several", async () => {
    const group = { groupId: GROUP, name: "Equb", role: "owner" };
    expect(await loadMyGroup(deps(200, { groups: [group] }).deps)).toEqual({
      status: "ready",
      groupId: GROUP,
      name: "Equb",
      role: "owner",
      attire: "none",
      userId: null
    });
    expect(await loadMyGroup(deps(200, { groups: [{ ...group, attire: "gabi", userId: "u1" }] }).deps)).toMatchObject({ attire: "gabi", userId: "u1" });
    expect((await loadMyGroup(deps(200, { groups: [{ ...group, attire: "male" }] }).deps)).status).toBe("error");
    expect(await loadMyGroup(deps(200, { groups: [] }).deps)).toEqual({ status: "no-group" });
    expect(await loadMyGroup(deps(200, { groups: [group, group] }).deps)).toEqual({ status: "multiple-groups" });
  });
});

describe("saveMyAttire", () => {
  it("PUTs only the group and the value, with the session's token", async () => {
    const a = deps(200, { groupId: GROUP, attire: "gabi", changed: true });
    expect(await saveMyAttire({ groupId: GROUP, attire: "gabi" }, a.deps)).toEqual({ status: "saved", attire: "gabi" });
    const [url, init] = a.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ledger/member-attire");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ groupId: GROUP, attire: "gabi" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt");
  });

  it("maps each failure to a closed status, and a malformed success to error", async () => {
    const input = { groupId: GROUP, attire: "gabi" as const };
    expect((await saveMyAttire(input, deps(403).deps)).status).toBe("forbidden");
    expect((await saveMyAttire(input, deps(401).deps)).status).toBe("unauthorized");
    expect((await saveMyAttire(input, deps(429).deps)).status).toBe("rate-limited");
    expect((await saveMyAttire(input, deps(400).deps)).status).toBe("invalid");
    expect((await saveMyAttire(input, deps(503).deps)).status).toBe("unavailable");
    expect((await saveMyAttire(input, deps(502).deps)).status).toBe("error");
    expect((await saveMyAttire(input, deps(200, { attire: "female" }).deps)).status).toBe("error");
    expect((await saveMyAttire(input, deps(200, {}).deps)).status).toBe("error");
  });

  it("sends nothing when signed out", async () => {
    const fetchImpl = vi.fn();
    const outcome = await saveMyAttire(
      { groupId: GROUP, attire: "gabi" },
      { getToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(outcome.status).toBe("unauthorized");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("mutations", () => {
  it("revokes and sets the treasurer role through the right routes", async () => {
    const a = deps(200);
    expect(await revokeInviteLink("i", a.deps)).toEqual({ status: "ok" });
    expect((a.fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/api/ledger/invites/revoke");
    const b = deps(200);
    expect(await setTreasurer({ groupId: GROUP, userId: "u", role: "treasurer" }, b.deps)).toEqual({ status: "ok" });
    expect((b.fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/api/ledger/member-roles");
    expect((await revokeInviteLink("i", deps(403).deps)).status).toBe("forbidden");
    expect((await revokeInviteLink("i", deps(404).deps)).status).toBe("not-found");
  });
});

describe("pending invite across sign-in", () => {
  it("stashes, peeks and clears; ignores a malformed value", () => {
    clearPendingInvite();
    expect(peekPendingInvite()).toBeNull();
    stashPendingInvite(TOKEN);
    expect(peekPendingInvite()).toBe(TOKEN);
    clearPendingInvite();
    expect(peekPendingInvite()).toBeNull();
    window.localStorage.setItem("sened.pendingInvite", "bad value");
    expect(peekPendingInvite()).toBeNull();
    clearPendingInvite();
  });
});
