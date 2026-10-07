import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const hoisted = vi.hoisted(() => ({
  userId: "",
  session: { status: "signed-out" } as Record<string, unknown>
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: { id: hoisted.userId } }, error: null }) } }))
}));

import { LiveDraw } from "@/components/draw/LiveDraw";
import type { DrawContributionGate } from "@/lib/draw/types";
import { dictionaries, translate, type Locale, type MessageKey } from "@/lib/i18n";

/**
 * The treasurer's Commit control against a scripted fetch: the gate is checked again at commit, so the
 * control shows the flagged pairs and, when the override given at open does not cover them, a reason box.
 */

afterEach(cleanup);

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";
const REASON = "Members agreed to pay on Friday";
const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);

function tokenFor(userId: string): string {
  return `h.${btoa(JSON.stringify({ sub: userId }))}.s`;
}

interface Script {
  gate: DrawContributionGate;
  /** Members whose round 1 is flagged on the grid. */
  flagged: string[];
  /** Members the override given when the draw was opened named (none = opened without one). */
  openOverride?: string[];
  /** Overrides given at commit, as the grid lists them. */
  commitOverride?: string[];
  /** The next commit is refused with 409 and this list. */
  refuseCommit?: { memberId: string; round: number }[];
}

const cycleWire = (script: Script) => ({
  cycleId: CYCLE,
  groupId: GROUP,
  name: "Meskerem equb",
  contributionAmount: "100.00",
  potAmount: "300.00",
  totalRounds: 3,
  reserveRatioBps: 1000,
  startedAt: T0,
  closedAt: null,
  createdAt: T0,
  roundsRevealed: 1,
  roundsPaid: 0,
  nextRound: 2,
  contributionGate: script.gate
});

const cell = (round: number, flagged: boolean) => ({
  round,
  status: round === 1 ? (flagged ? "flagged" : "met") : round === 2 ? "flagged" : "not_due",
  entryId: round === 1 && !flagged ? ENTRY : null,
  source: round === 1 && !flagged ? "treasurer" : null
});

function gridWire(script: Script) {
  const flags = (ids: string[]) => ids.map((memberId) => ({ memberId, round: 1 }));
  const overrides = [
    ...(script.openOverride === undefined
      ? []
      : [{ at: T0, actorId: TREASURER, round: 2, drawId: DRAW, reason: REASON, flagged: flags(script.openOverride), stage: "open" }]),
    ...(script.commitOverride === undefined
      ? []
      : [{ at: T0, actorId: TREASURER, round: 2, drawId: DRAW, reason: REASON, flagged: flags(script.commitOverride), stage: "commit" }])
  ];
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 3,
    contributionAmount: "100.00",
    startedAt: T0,
    contributionGate: script.gate,
    nextRound: 2,
    flaggedCount: script.flagged.length,
    rounds: [1, 2, 3].map((round) => ({ round, dueAt: round <= 2 ? T0 : null, revealedAt: round === 1 ? T0 : null })),
    members: [TREASURER, B, C].map((memberId) => ({
      memberId,
      active: true,
      winRound: null,
      cells: [1, 2, 3].map((round) => cell(round, script.flagged.includes(memberId)))
    })),
    gateEvents: [],
    overrides
  };
}

const sessionWire = (script: Script) => ({
  drawId: DRAW,
  groupId: GROUP,
  cycleId: CYCLE,
  round: 2,
  state: "sealing",
  openedBy: TREASURER,
  openedAt: T0,
  committedAt: null,
  cycle: cycleWire(script),
  eligible: [TREASURER, B, C],
  seals: [{ memberId: B, sealed: "a".repeat(64), sealedAt: T0 }],
  nonces: [],
  revealRequested: false
});

const wireRound = {
  drawId: DRAW,
  groupId: GROUP,
  cycleId: CYCLE,
  round: 2,
  commitment: "a".repeat(64),
  rosterDigest: "b".repeat(64),
  participantCount: 3,
  potAmount: "300.00",
  totalRounds: 3,
  reserveRatioBps: 1000,
  state: "committed",
  revealed: false
};

function createScriptedServer(script: Script) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).split("?")[0]!;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (path === "/api/my-groups") {
      return Response.json({
        groups: [{ groupId: GROUP, role: hoisted.userId === TREASURER ? "owner" : "member", accounts: [{ id: "a", code: "POT_CASH" }, { id: "b", code: "PAYOUT_EXPENSE" }] }]
      });
    }
    if (path === "/api/ledger/members") {
      return Response.json({
        members: [
          { userId: TREASURER, role: "owner", joinedAt: "2026-09-01T00:00:00Z", email: "treasurer@example.test" },
          { userId: B, role: "member", joinedAt: "2026-09-02T00:00:00Z", email: "berhan@example.test" },
          { userId: C, role: "member", joinedAt: "2026-09-03T00:00:00Z", email: "chaltu@example.test" }
        ]
      });
    }
    if (path === "/api/ledger/entries") return Response.json({ entries: [] });
    if (path === "/api/draw/cycles" && method === "GET") return Response.json({ cycles: [cycleWire(script)] });
    if (path === `/api/draw/cycles/${CYCLE}`) {
      return Response.json({
        cycle: cycleWire(script),
        draws: [{ drawId: DRAW, round: 2, state: "sealing", openedAt: T0, committedAt: null, revealedAt: null, winnerMemberId: null, sealCount: 1, nonceCount: 0, revealRequested: false, superseded: false, legacy: false }]
      });
    }
    if (path === `/api/draw/draws/${DRAW}`) return Response.json({ session: sessionWire(script) });
    if (path === "/api/draw/contributions") return Response.json({ contributions: gridWire(script) });
    if (path === "/api/draw/commits" && method === "POST") {
      if (script.refuseCommit) {
        return Response.json({ error: "contribution_gate_blocked", message: "draw_contribution_gate_blocked", flagged: script.refuseCommit }, { status: 409 });
      }
      return Response.json({ round: wireRound, replayed: false, transcript: {}, contributionGate: null }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, script };
}

function renderLive(server: ReturnType<typeof createScriptedServer>, userId: string, locale: Locale = "en") {
  cleanup();
  hoisted.userId = userId;
  return render(<LiveDraw locale={locale} accessToken={tokenFor(userId)} deps={{ getToken: async () => tokenFor(userId), fetchImpl: server.fetchImpl }} />);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  globalThis.localStorage?.clear();
  hoisted.session = { status: "signed-out" };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const commits = (server: ReturnType<typeof createScriptedServer>) => server.calls.filter((call) => call.method === "POST" && call.path === "/api/draw/commits");

describe("/draw: the Commit control and the gate", () => {
  it("block, a flagged pair the open override did not name: an alert listing who, a reason box, and a held button", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer({ gate: "block", flagged: [B, C] });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("commit-gate");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveAttribute("data-gate-state", "blocked");
    expect(notice).toHaveTextContent("Committing this draw is blocked");
    expect(notice).toHaveTextContent("2 earlier round(s) are flagged and were not covered");
    expect(notice).toHaveTextContent("The seals members have already made stay valid");
    const list = screen.getByTestId("commit-gate-flagged");
    expect(list).toHaveTextContent("berhan@example.test: round(s) 1");
    expect(list).toHaveTextContent("chaltu@example.test: round(s) 1");
    expect(list).not.toHaveTextContent("treasurer@example.test");
    const commit = screen.getByTestId("commit-button");
    expect(commit).toHaveTextContent("Commit the draw with this reason");
    expect(commit).toBeDisabled();

    await user.type(screen.getByTestId("commit-gate-reason"), "too short");
    expect(commit).toBeDisabled();
    await user.clear(screen.getByTestId("commit-gate-reason"));
    await user.type(screen.getByTestId("commit-gate-reason"), `  ${REASON}  `);
    expect(commit).toBeEnabled();
    await user.click(commit);
    await waitFor(() => expect(commits(server)).toHaveLength(1));
    expect(commits(server)[0]!.body).toMatchObject({ drawId: DRAW, overrideReason: REASON });
    expect(commits(server)[0]!.body).toHaveProperty("idempotencyKey");
  });

  it("block, every flagged pair named by the override given at open (the set is the same or smaller): no new reason, none is sent", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer({ gate: "block", flagged: [B], openOverride: [B, C] });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("commit-gate");
    expect(notice).toHaveAttribute("data-gate-state", "carried");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("Already accepted when the draw was opened");
    expect(screen.queryByTestId("commit-gate-reason")).toBeNull();
    const commit = screen.getByTestId("commit-button");
    expect(commit).toHaveTextContent("Commit the draw");
    await waitFor(() => expect(commit).toBeEnabled());
    await user.click(commit);
    await waitFor(() => expect(commits(server)).toHaveLength(1));
    expect(commits(server)[0]!.body).not.toHaveProperty("overrideReason");
  });

  it("block, the set gained a pair the open override did not name (same size): a reason is asked for again", async () => {
    const server = createScriptedServer({ gate: "block", flagged: [B, C], openOverride: [TREASURER, B] });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("commit-gate");
    expect(notice).toHaveAttribute("data-gate-state", "blocked");
    expect(screen.getByTestId("commit-gate-reason")).toBeInTheDocument();
    expect(screen.getByTestId("commit-button")).toBeDisabled();
  });

  it("warn: lists the flagged pairs and holds the button until the owner confirms; no reason is sent", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer({ gate: "warn", flagged: [B] });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("commit-gate");
    expect(notice).toHaveAttribute("data-gate-policy", "warn");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("Earlier rounds are flagged");
    expect(notice).toHaveTextContent("1 earlier round(s) have no qualifying contribution attributed. You can still commit this draw.");
    const commit = screen.getByTestId("commit-button");
    expect(commit).toBeDisabled();
    expect(screen.queryByTestId("commit-gate-reason")).toBeNull();
    await user.click(screen.getByTestId("commit-gate-confirm"));
    expect(commit).toBeEnabled();
    await user.click(commit);
    await waitFor(() => expect(commits(server)).toHaveLength(1));
    expect(commits(server)[0]!.body).not.toHaveProperty("overrideReason");
  });

  it("off, or nothing flagged: no notice and a plain commit", async () => {
    const user = userEvent.setup();
    for (const script of [{ gate: "off" as const, flagged: [B] }, { gate: "block" as const, flagged: [] as string[] }, { gate: "warn" as const, flagged: [] as string[] }]) {
      const server = createScriptedServer(script);
      renderLive(server, TREASURER);
      const commit = await screen.findByTestId("commit-button");
      await waitFor(() => expect(commit).toBeEnabled());
      expect(screen.queryByTestId("commit-gate")).toBeNull();
      expect(commit).toHaveTextContent("Commit the draw");
      await user.click(commit);
      await waitFor(() => expect(commits(server)).toHaveLength(1));
      expect(commits(server)[0]!.body).not.toHaveProperty("overrideReason");
    }
  });

  it("a refusal the screen did not predict (the grid was stale) is shown in words, the seals are kept, and the grid is read again", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer({ gate: "block", flagged: [], refuseCommit: [{ memberId: B, round: 1 }] });
    renderLive(server, TREASURER);
    const commit = await screen.findByTestId("commit-button");
    await waitFor(() => expect(commit).toBeEnabled());
    const reads = () => server.calls.filter((call) => call.path === "/api/draw/contributions").length;
    const before = reads();
    // The grid now shows the problem, the way the server will on the next read.
    server.script.flagged = [B];
    server.script.refuseCommit = [{ memberId: B, round: 1 }];
    await user.click(commit);
    expect(await screen.findByText(en("drawLive.error.commitGateBlocked"))).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // The draw is still sealing: the seal progress and the control are still there.
    expect(screen.getByTestId("seal-progress")).toBeInTheDocument();
    expect(await screen.findByTestId("commit-gate")).toHaveTextContent("Committing this draw is blocked");
  });

  it("only the owner or treasurer has the control: a plain member sees no commit form and no gate notice", async () => {
    const server = createScriptedServer({ gate: "block", flagged: [B] });
    renderLive(server, B);
    await screen.findByTestId("draw-panel");
    expect(screen.queryByTestId("commit-form")).toBeNull();
    expect(screen.queryByTestId("commit-gate")).toBeNull();
    expect(screen.queryByTestId("commit-button")).toBeNull();
  });

  it("the grid lists an override given at commit as such, beside the one given at open", async () => {
    const server = createScriptedServer({ gate: "block", flagged: [], openOverride: [B], commitOverride: [B, C] });
    renderLive(server, B);
    await screen.findByTestId("contribution-grid-scroll");
    const rows = await screen.findAllByTestId("gate-override");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute("data-stage"))).toEqual(["open", "commit"]);
    expect(rows[0]).toHaveTextContent("opened round 2 despite 1 flagged round(s)");
    expect(rows[1]).toHaveTextContent("committed round 2 despite 2 flagged round(s) (berhan@example.test, chaltu@example.test)");
  });

  it("speaks Amharic in the commit notice with no raw keys", async () => {
    const server = createScriptedServer({ gate: "block", flagged: [B] });
    renderLive(server, TREASURER, "am");
    const notice = await screen.findByTestId("commit-gate");
    expect(notice).toHaveTextContent(translate("am", "drawLive.commitGateBlockedTitle"));
    expect(notice.textContent).not.toMatch(/drawLive\.[a-zA-Z.]+/);
    expect(screen.getByTestId("commit-button")).toHaveTextContent(translate("am", "drawLive.commitGateOverrideAction"));
    expect(screen.getByText(translate("am", "drawLive.commitGateReason"))).toBeInTheDocument();
  });

  it("every new key exists in both languages with the same placeholders, and the Amharic is not the English", () => {
    const keys = Object.keys(dictionaries.en).filter(
      (key) => key.startsWith("drawLive.commitGate") || key === "drawLive.error.commitGateBlocked" || key === "contributions.gate.commitOverrideRow" || key === "contributions.assignNote"
    );
    expect(keys.length).toBe(11);
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keys) {
      expect(dictionaries.am[key as MessageKey], key).toBeTruthy();
      expect(dictionaries.am[key as MessageKey], key).not.toBe(dictionaries.en[key as MessageKey]);
      expect(holes(dictionaries.am[key as MessageKey]), key).toEqual(holes(dictionaries.en[key as MessageKey]));
    }
  });
});
