import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

import { ContributionGrid, type ContributionsState, type GateOutcome } from "@/components/draw/ContributionGrid";
import { LiveDraw } from "@/components/draw/LiveDraw";
import { parseCycleContributions } from "@/lib/draw/contributions";
import type { DrawContributionGate } from "@/lib/draw/types";
import { dictionaries, translate, type Locale, type MessageKey } from "@/lib/i18n";

afterEach(cleanup);

const CYCLE = "66666666-6666-4666-8666-666666666666";
const GROUP = "22222222-2222-4222-8222-222222222222";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const DRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-10T09:00:00.000Z";
const NAMES: Record<string, string> = { [TREASURER]: "Treasurer", [A]: "Alem", [B]: "Berhan", [C]: "Chaltu" };
const REASON = "Members agreed to pay on Friday";

const en = (key: MessageKey, vars: Record<string, string | number> = {}) => translate("en", key, vars);

type Status = "met" | "flagged" | "not_due";
function cells(statuses: readonly Status[], sources: Record<number, "bank_verification" | "treasurer"> = {}) {
  return statuses.map((status, index) => ({
    round: index + 1,
    status,
    entryId: status === "met" ? ENTRY : null,
    source: status === "met" ? (sources[index + 1] ?? "treasurer") : null
  }));
}

function wire(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 4,
    contributionAmount: "100.00",
    startedAt: T0,
    contributionGate: "block",
    nextRound: 3,
    flaggedCount: 3,
    rounds: [1, 2, 3, 4].map((round) => ({ round, dueAt: round <= 2 ? T0 : null, revealedAt: round === 1 ? T0 : null })),
    members: [
      { memberId: A, active: true, winRound: 1, cells: cells(["met", "flagged", "not_due", "not_due"]) },
      { memberId: B, active: true, winRound: null, cells: cells(["met", "met", "not_due", "not_due"], { 1: "bank_verification" }) },
      { memberId: C, active: false, winRound: null, cells: cells(["flagged", "flagged", "not_due", "not_due"]) },
      { memberId: TREASURER, active: true, winRound: null, cells: cells(["flagged", "not_due", "not_due", "not_due"]) }
    ],
    gateEvents: [],
    overrides: [],
    ...overrides
  };
}

function ready(overrides: Record<string, unknown> = {}): ContributionsState {
  const view = parseCycleContributions(wire(overrides));
  if (view === null) throw new Error("fixture must parse");
  return { kind: "ready", view };
}

function mount(
  options: { state?: ContributionsState; locale?: Locale; me?: string | null; isTreasurer?: boolean; onSetGate?: (gate: DrawContributionGate, reason: string) => Promise<GateOutcome> } = {}
) {
  const onSetGate = vi.fn(options.onSetGate ?? (async () => ({ ok: true }) as GateOutcome));
  render(
    <ContributionGrid
      locale={options.locale ?? "en"}
      state={options.state ?? ready()}
      myUserId={options.me === undefined ? TREASURER : options.me}
      isTreasurer={options.isTreasurer ?? false}
      labelFor={(id) => NAMES[id] ?? id}
      onSetGate={onSetGate}
    />
  );
  return onSetGate;
}

describe("ContributionGrid: every member by every round, in words", () => {
  it("shows one row per member and one cell per round, each saying its status in text", () => {
    mount();
    for (const member of [A, B, C, TREASURER]) {
      expect(screen.getByTestId(`grid-row-${member}`)).toBeInTheDocument();
      for (const round of [1, 2, 3, 4]) expect(screen.getByTestId(`grid-cell-${member}-${round}`)).toBeInTheDocument();
    }
    const alem = [1, 2, 3, 4].map((round) => screen.getByTestId(`grid-cell-${A}-${round}`));
    expect(alem.map((cell) => cell.getAttribute("data-status"))).toEqual(["met", "flagged", "not_due", "not_due"]);
    expect(alem[0]).toHaveTextContent("Met");
    expect(alem[1]).toHaveTextContent("Flagged");
    expect(alem[2]).toHaveTextContent("Not yet due");
    // Colour is never the only signal: the glyph is decorative and the words are real text.
    for (const cell of alem) expect(cell.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("says who is known to have paid how: bank-verified or recorded by the treasurer, never conflated", () => {
    mount();
    expect(screen.getByTestId(`grid-cell-${B}-1`)).toHaveAttribute("data-source", "bank_verification");
    expect(screen.getByTestId(`grid-cell-${B}-1`)).toHaveTextContent("bank");
    expect(screen.getByTestId(`grid-cell-${B}-2`)).toHaveAttribute("data-source", "treasurer");
    expect(screen.getByTestId(`grid-cell-${B}-2`)).toHaveTextContent("treasurer");
    // Only a met cell names a source.
    expect(screen.getByTestId(`grid-cell-${A}-2`)).not.toHaveAttribute("data-source");
    expect(screen.getByTestId("contribution-grid-legend")).toHaveTextContent("not bank-verified");
  });

  it("marks the winner's round, the signed-in member, and a member who is no longer active", () => {
    mount({ me: TREASURER });
    expect(screen.getByTestId(`grid-row-${A}`)).toHaveTextContent("won round 1");
    expect(screen.getByTestId(`grid-row-${TREASURER}`)).toHaveTextContent("(you)");
    expect(screen.getByTestId(`grid-row-${C}`)).toHaveTextContent("no longer active");
    expect(screen.getByTestId(`grid-row-${A}`)).toHaveTextContent("1 met · 1 flagged");
  });

  it("scrolls sideways inside its own region only: the table is wide, the region clips it, the member column stays in view", () => {
    mount();
    const region = screen.getByTestId("contribution-grid-scroll");
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAccessibleName(en("contributions.tableCaption"));
    expect(region.className).toMatch(/overflow-x-auto/);
    expect(region.className).toMatch(/max-w-full/);
    // Positioned, so the table's absolutely positioned screen-reader text is clipped by it too
    // (found in a real browser: without this the page itself scrolled sideways).
    expect(region.className).toMatch(/\brelative\b/);
    const table = region.querySelector("table")!;
    expect(table.className).toMatch(/w-max/);
    // The member column is sticky so a name is never lost while scrolling.
    expect(screen.getByTestId(`grid-row-${A}`).querySelector("th[scope='row']")!.className).toMatch(/sticky left-0/);
    // Nothing else in the panel can widen the page.
    expect(screen.getByTestId("contribution-grid").className).not.toMatch(/overflow-x-(auto|scroll|visible)/);
    expect(screen.getByText(en("contributions.scrollHint"))).toBeInTheDocument();
  });

  it("is a real table: a caption, a header per round (full text for assistive tech), row headers", () => {
    mount();
    const table = within(screen.getByTestId("contribution-grid-scroll")).getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(4);
    expect(within(table).getByRole("columnheader", { name: /Round 3/ })).toBeInTheDocument();
    expect(table.querySelector("caption")).toHaveTextContent(en("contributions.tableCaption"));
  });

  it("explains how a cell is worked out, that a flag is not a verdict, and that there is no partial", () => {
    mount();
    expect(screen.getByTestId("contribution-grid-explain")).toHaveTextContent("worked out from the ledger every time this is read");
    const legend = screen.getByTestId("contribution-grid-legend");
    expect(legend).toHaveTextContent("A flag, not a verdict");
    expect(legend).toHaveTextContent("under the cycle's contribution does not count");
    expect(screen.getByTestId("contribution-grid-flagged")).toHaveTextContent("3 flagged cell(s) among active members.");
  });

  it("says nothing rather than guessing while loading or when it could not be read", () => {
    mount({ state: { kind: "loading" } });
    expect(screen.getByTestId("contribution-grid-status")).toHaveTextContent("Reading the contributions");
    expect(screen.queryByTestId("contribution-grid-scroll")).toBeNull();
    cleanup();
    mount({ state: { kind: "unavailable" } });
    expect(screen.getByTestId("contribution-grid-status")).toHaveTextContent("Nothing is shown rather than a guess");
  });

  it("speaks Amharic with no raw keys, and every new key exists in both languages with the same placeholders", () => {
    mount({ locale: "am" });
    const panel = screen.getByTestId("contribution-grid");
    expect(panel).toHaveTextContent(translate("am", "contributions.title"));
    expect(screen.getByTestId(`grid-cell-${A}-2`)).toHaveTextContent(translate("am", "contributions.status.flagged"));
    expect(panel.textContent).not.toMatch(/contributions\.[a-zA-Z_.]+/);
    const keys = Object.keys(dictionaries.en).filter((key) => key.startsWith("contributions.") || key.startsWith("drawLive.gate") || key === "drawLive.cycleGate" || key === "drawLive.error.gateBlocked");
    expect(keys.length).toBeGreaterThan(55);
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keys) {
      expect(dictionaries.am[key as MessageKey], key).toBeTruthy();
      expect(dictionaries.am[key as MessageKey], key).not.toBe(dictionaries.en[key as MessageKey]);
      expect(holes(dictionaries.am[key as MessageKey]), key).toEqual(holes(dictionaries.en[key as MessageKey]));
    }
  });
});

describe("ContributionGrid: the contribution gate", () => {
  it("shows the effective policy and what it means, to everyone", () => {
    mount({ state: ready({ contributionGate: "warn" }) });
    expect(screen.getByTestId("gate-policy-current")).toHaveTextContent("Contribution gate: Warn");
    expect(screen.getByTestId("gate-policy")).toHaveTextContent("asks for a confirmation");
    expect(screen.queryByTestId("gate-change")).toBeNull();
  });

  it("lists the policy changes and the overrides with who, when and why", () => {
    mount({
      state: ready({
        gateEvents: [{ at: T0, actorId: TREASURER, from: "off", to: "block", reason: "Switching it on for everyone" }],
        overrides: [{ at: "2026-10-12T09:00:00.000Z", actorId: A, round: 3, drawId: DRAW, reason: REASON, flagged: [{ memberId: B, round: 1 }, { memberId: B, round: 2 }, { memberId: C, round: 1 }] }]
      })
    });
    const event = screen.getByTestId("gate-event");
    expect(event).toHaveTextContent("2026-10-10: Treasurer (you) changed the gate from Off to Block. Reason: Switching it on for everyone");
    const override = screen.getByTestId("gate-override");
    expect(override).toHaveTextContent("2026-10-12: Alem opened round 3 despite 3 flagged round(s) (Berhan, Chaltu). Reason: Members agreed to pay on Friday");
  });

  it("says so when nothing has been recorded", () => {
    mount();
    expect(screen.getByTestId("gate-history")).toHaveTextContent("No policy change or override has been recorded.");
  });

  it("offers the change only to an owner or treasurer, never offering the policy already in force", async () => {
    const user = userEvent.setup();
    mount({ isTreasurer: true, state: ready({ contributionGate: "block" }) });
    const select = screen.getByTestId("gate-change-select") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["off", "warn"]);
    await user.selectOptions(select, "warn");
    expect(select.value).toBe("warn");
  });

  it("needs a reason of at least 10 characters before it asks the server, then sends the trimmed reason", async () => {
    const user = userEvent.setup();
    const onSetGate = mount({ isTreasurer: true, state: ready({ contributionGate: "off" }) });
    await user.click(screen.getByTestId("gate-change-save"));
    expect(screen.getByTestId("gate-change-message")).toHaveTextContent("at least 10 characters");
    expect(onSetGate).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("gate-change-reason"), "   too short ");
    await user.click(screen.getByTestId("gate-change-save"));
    expect(onSetGate).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("gate-change-reason"));
    await user.type(screen.getByTestId("gate-change-reason"), `  ${REASON}  `);
    await user.selectOptions(screen.getByTestId("gate-change-select"), "block");
    await user.click(screen.getByTestId("gate-change-save"));
    expect(onSetGate).toHaveBeenCalledWith("block", REASON);
    expect(await screen.findByTestId("gate-change-message")).toHaveTextContent("The policy was changed and recorded.");
    expect((screen.getByTestId("gate-change-reason") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the server's refusal in words", async () => {
    const user = userEvent.setup();
    mount({
      isTreasurer: true,
      onSetGate: async () => ({ ok: false, key: "drawLive.error.forbidden", detail: "draw_forbidden" })
    });
    await user.type(screen.getByTestId("gate-change-reason"), REASON);
    await user.click(screen.getByTestId("gate-change-save"));
    const message = await screen.findByTestId("gate-change-message");
    expect(message).toHaveAttribute("role", "alert");
    expect(message).toHaveTextContent(en("drawLive.error.forbidden"));
    expect(message).toHaveTextContent("draw_forbidden");
  });
});

// ---------------------------------------------------------------------------------------------
// The grid and the gate inside /draw (LiveDraw), against a scripted fetch.
// ---------------------------------------------------------------------------------------------

function tokenFor(userId: string): string {
  return `h.${btoa(JSON.stringify({ sub: userId }))}.s`;
}

interface Script {
  gate: DrawContributionGate;
  flagged: boolean;
  /** The next open is refused with 409 and this list. */
  refuseOpen?: { memberId: string; round: number }[];
}

function cycleWire(script: Script) {
  return {
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
  };
}

function gridWire(script: Script) {
  const flagged: Status[] = script.flagged ? ["flagged", "not_due", "not_due"] : ["met", "not_due", "not_due"];
  return {
    cycleId: CYCLE,
    groupId: GROUP,
    totalRounds: 3,
    contributionAmount: "100.00",
    startedAt: T0,
    contributionGate: script.gate,
    nextRound: 2,
    flaggedCount: script.flagged ? 2 : 0,
    rounds: [1, 2, 3].map((round) => ({ round, dueAt: round === 1 ? T0 : null, revealedAt: round === 1 ? T0 : null })),
    members: [
      { memberId: TREASURER, active: true, winRound: 1, cells: cells(flagged) },
      { memberId: B, active: true, winRound: null, cells: cells(flagged) },
      { memberId: C, active: true, winRound: null, cells: cells(["met", "not_due", "not_due"]) }
    ],
    gateEvents: [],
    overrides: []
  };
}

function sessionWire(script: Script) {
  return {
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
    seals: [],
    nonces: [],
    revealRequested: false
  };
}

function createScriptedServer(role: "owner" | "member", script: Script) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const state: { drawOpened: boolean } = { drawOpened: false };
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (path === "/api/my-groups") {
      return Response.json({
        groups: [{ groupId: GROUP, role: hoisted.userId === TREASURER ? role : "member", accounts: [{ id: "a", code: "POT_CASH" }, { id: "b", code: "PAYOUT_EXPENSE" }] }]
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
        draws: state.drawOpened
          ? [{ drawId: DRAW, round: 2, state: "sealing", openedAt: T0, committedAt: null, revealedAt: null, winnerMemberId: null, sealCount: 0, nonceCount: 0, revealRequested: false, superseded: false, legacy: false }]
          : []
      });
    }
    if (path === `/api/draw/draws/${DRAW}`) return Response.json({ session: sessionWire(script) });
    if (path === "/api/draw/contributions") return Response.json({ contributions: gridWire(script) });
    if (path === "/api/draw/gate" && method === "POST") {
      script.gate = body?.gate as DrawContributionGate;
      return Response.json({ cycle: cycleWire(script), replayed: false });
    }
    if (path === "/api/draw/draws" && method === "POST") {
      if (script.refuseOpen) {
        return Response.json({ error: "contribution_gate_blocked", message: "draw_contribution_gate_blocked", flagged: script.refuseOpen }, { status: 409 });
      }
      state.drawOpened = true;
      return Response.json({ session: sessionWire(script), replayed: false, contributionGate: { policy: script.gate, flagged: [], overridden: false } }, { status: 201 });
    }
    if (path === "/api/draw/cycles" && method === "POST") {
      return Response.json({ cycle: cycleWire({ ...script, gate: (body?.contributionGate as DrawContributionGate) ?? "off" }), replayed: false }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, script };
}

function renderLive(server: ReturnType<typeof createScriptedServer>, userId: string, locale: Locale = "en") {
  cleanup();
  hoisted.userId = userId;
  return render(
    <LiveDraw locale={locale} accessToken={tokenFor(userId)} deps={{ getToken: async () => tokenFor(userId), fetchImpl: server.fetchImpl }} />
  );
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

const posts = (server: ReturnType<typeof createScriptedServer>, path: string) => server.calls.filter((call) => call.method === "POST" && call.path === path);

describe("/draw: the grid", () => {
  it("shows every member to every member, with the cycle's policy, and no treasurer controls to a plain member", async () => {
    const server = createScriptedServer("owner", { gate: "block", flagged: true });
    renderLive(server, B);
    expect(await screen.findByTestId("contribution-grid-scroll")).toBeInTheDocument();
    expect(screen.getByTestId(`grid-cell-${TREASURER}-1`)).toHaveAttribute("data-status", "flagged");
    expect(screen.getByTestId(`grid-cell-${C}-1`)).toHaveAttribute("data-status", "met");
    expect(screen.getByTestId("cycle-gate")).toHaveTextContent("Block");
    expect(screen.getByTestId("gate-policy-current")).toHaveTextContent("Block");
    expect(screen.queryByTestId("gate-change")).toBeNull();
    expect(screen.queryByTestId("open-draw")).toBeNull();
    expect(screen.queryByTestId("open-gate")).toBeNull();
    // Member names come from the members list, as everywhere else on the screen.
    expect(screen.getByTestId(`grid-row-${B}`)).toHaveTextContent("berhan@example.test");
  });

  it("replaces the old per-member 'paid since the cycle began' list: the ledger panel keeps only its totals", async () => {
    const server = createScriptedServer("owner", { gate: "off", flagged: false });
    renderLive(server, B);
    await screen.findByTestId("contribution-grid-scroll");
    expect(screen.queryByTestId("ledger-paid-members")).toBeNull();
    expect(screen.getByTestId("ledger-unattributed")).toHaveTextContent("grid above");
  });
});

describe("/draw: opening a draw under each policy", () => {
  it("off: no notice, a plain open, and no reason or confirmation is sent", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "off", flagged: true });
    renderLive(server, TREASURER);
    const open = await screen.findByTestId("open-draw");
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByTestId("open-gate")).toBeNull();
    await user.click(open);
    await waitFor(() => expect(posts(server, "/api/draw/draws")).toHaveLength(1));
    expect(posts(server, "/api/draw/draws")[0]!.body).not.toHaveProperty("overrideReason");
  });

  it("warn: lists who is flagged for which round and holds the button until the owner confirms; the server is not asked for a reason", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "warn", flagged: true });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("open-gate");
    expect(notice).toHaveAttribute("data-gate-policy", "warn");
    expect(notice).toHaveTextContent("Earlier rounds are flagged");
    expect(notice).toHaveTextContent("2 earlier round(s) have no qualifying contribution attributed. You can still open round 2.");
    const list = screen.getByTestId("open-gate-flagged");
    expect(list).toHaveTextContent("treasurer@example.test: round(s) 1");
    expect(list).toHaveTextContent("berhan@example.test: round(s) 1");
    expect(list).not.toHaveTextContent("chaltu");
    const open = screen.getByTestId("open-draw");
    expect(open).toBeDisabled();
    await user.click(screen.getByTestId("open-gate-confirm"));
    expect(open).toBeEnabled();
    expect(screen.queryByTestId("open-gate-reason")).toBeNull();
    await user.click(open);
    await waitFor(() => expect(posts(server, "/api/draw/draws")).toHaveLength(1));
    expect(posts(server, "/api/draw/draws")[0]!.body).not.toHaveProperty("overrideReason");
  });

  it("warn with nothing flagged asks for nothing", async () => {
    const server = createScriptedServer("owner", { gate: "warn", flagged: false });
    renderLive(server, TREASURER);
    const open = await screen.findByTestId("open-draw");
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByTestId("open-gate")).toBeNull();
  });

  it("block: shows the block as an alert, holds the button until a reason of 10+ characters, and sends exactly that reason", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "block", flagged: true });
    renderLive(server, TREASURER);
    const notice = await screen.findByTestId("open-gate");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent("Opening this draw is blocked");
    expect(notice).toHaveTextContent("2 earlier round(s) are flagged");
    const open = screen.getByTestId("open-draw");
    expect(open).toHaveTextContent("Open round 2 with this reason");
    expect(open).toBeDisabled();
    expect(notice).toHaveTextContent("recorded where every member can read them");

    await user.type(screen.getByTestId("open-gate-reason"), "too short");
    expect(open).toBeDisabled();
    await user.clear(screen.getByTestId("open-gate-reason"));
    await user.type(screen.getByTestId("open-gate-reason"), `  ${REASON}  `);
    expect(open).toBeEnabled();
    await user.click(open);
    await waitFor(() => expect(posts(server, "/api/draw/draws")).toHaveLength(1));
    expect(posts(server, "/api/draw/draws")[0]!.body).toMatchObject({ cycleId: CYCLE, overrideReason: REASON });
  });

  it("block with nothing flagged is a plain open with no reason", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "block", flagged: false });
    renderLive(server, TREASURER);
    const open = await screen.findByTestId("open-draw");
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByTestId("open-gate")).toBeNull();
    expect(open).toHaveTextContent("Open the draw for round 2");
    await user.click(open);
    await waitFor(() => expect(posts(server, "/api/draw/draws")).toHaveLength(1));
    expect(posts(server, "/api/draw/draws")[0]!.body).not.toHaveProperty("overrideReason");
  });

  it("a refusal the screen did not predict (the grid was stale) is shown in words and the grid is read again", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "block", flagged: false, refuseOpen: [{ memberId: B, round: 1 }] });
    renderLive(server, TREASURER);
    const open = await screen.findByTestId("open-draw");
    await waitFor(() => expect(open).toBeEnabled());
    const reads = () => server.calls.filter((call) => call.path === "/api/draw/contributions").length;
    const before = reads();
    // The grid now shows the problem, the way the server will on the next read.
    server.script.flagged = true;
    await user.click(open);
    const alert = await screen.findByText(en("drawLive.error.gateBlocked"));
    expect(alert).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByTestId("open-gate")).toHaveTextContent("Opening this draw is blocked");
  });

  it("speaks Amharic in the gate notice with no raw keys", async () => {
    const server = createScriptedServer("owner", { gate: "block", flagged: true });
    renderLive(server, TREASURER, "am");
    const notice = await screen.findByTestId("open-gate");
    expect(notice).toHaveTextContent(translate("am", "drawLive.gateBlockedTitle"));
    expect(notice.textContent).not.toMatch(/drawLive\.[a-zA-Z.]+/);
    expect(screen.getByTestId("open-draw")).toHaveTextContent(translate("am", "drawLive.gateOverrideAction", { round: 2 }));
  });
});

describe("/draw: choosing and changing the policy", () => {
  it("the cycle form sends the chosen policy, and `off` when the owner does not choose", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "off", flagged: false });
    renderLive(server, TREASURER);
    await screen.findByTestId("cycle-create-form");
    const select = screen.getByTestId("cycle-gate-select") as HTMLSelectElement;
    expect(select.value).toBe("off");
    expect([...select.options].map((option) => option.value)).toEqual(["off", "warn", "block"]);
    await user.type(screen.getByLabelText("Cycle name"), "Tikimt equb");
    await user.type(screen.getByLabelText("Contribution per member (ETB)"), "100");
    await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
    await user.selectOptions(select, "block");
    await user.click(screen.getByRole("button", { name: "Create the cycle" }));
    await waitFor(() => expect(posts(server, "/api/draw/cycles")).toHaveLength(1));
    expect(posts(server, "/api/draw/cycles")[0]!.body).toMatchObject({ contributionGate: "block" });
  });

  it("the owner changes the policy from the grid with a reason; the cycle card and the grid follow", async () => {
    const user = userEvent.setup();
    const server = createScriptedServer("owner", { gate: "off", flagged: true });
    renderLive(server, TREASURER);
    await screen.findByTestId("gate-change");
    expect(screen.getByTestId("cycle-gate")).toHaveTextContent("Off");
    await user.click(screen.getByText(en("contributions.gate.change")));
    await user.selectOptions(screen.getByTestId("gate-change-select"), "block");
    await user.type(screen.getByTestId("gate-change-reason"), REASON);
    await user.click(screen.getByTestId("gate-change-save"));
    await waitFor(() => expect(posts(server, "/api/draw/gate")).toHaveLength(1));
    expect(posts(server, "/api/draw/gate")[0]!.body).toEqual({ cycleId: CYCLE, gate: "block", reason: REASON });
    await waitFor(() => expect(screen.getByTestId("cycle-gate")).toHaveTextContent("Block"));
    // The open section now holds the draw until a reason is given.
    expect(await screen.findByTestId("open-gate")).toHaveAttribute("data-gate-policy", "block");
  });
});
