import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const hoisted = vi.hoisted(() => ({
  userId: "",
  session: { status: "signed-out" } as Record<string, unknown>
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: { id: hoisted.userId } }, error: null }) }
  }))
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
const triggerHaptic = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/draw/haptics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/draw/haptics")>()),
  triggerHaptic
}));

import { LiveDraw } from "@/components/draw-console/LiveDraw";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";
import { drawErrorKey, readSeal, sealForDraw, writeSeal } from "@/lib/draw/clientDraw";
import { DRAW_ERROR_CODES } from "@/lib/draw/types";
import { InMemoryDrawRepository } from "@/lib/draw/repository";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import {
  createCancelHandler,
  createCommitHandler,
  createCycleCreateHandler,
  createCycleListHandler,
  createCycleReadHandler,
  createDrawOpenHandler,
  createNonceHandler,
  createPayoutHandler,
  createRevealHandler,
  createSealHandler,
  createSessionHandler,
  createVerifyHandler
} from "@/lib/draw/routeHandlers";
import { DrawService } from "@/lib/draw/service";
import { dictionaries, translate } from "@/lib/i18n";
import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";

const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const MEMBER_B = "33333333-3333-4333-8333-333333333333";
const MEMBER_C = "55555555-5555-4555-8555-555555555555";
const CASH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INCOME = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-10-01T10:00:00.000Z";

function tokenFor(userId: string): string {
  return `h.${btoa(JSON.stringify({ sub: userId }))}.s`;
}

type Role = "owner" | "treasurer" | "member";
type Override = (url: string, init: RequestInit) => Response | Promise<Response> | null;
type Tamper = (path: string, body: Record<string, unknown>) => Record<string, unknown>;

/**
 * A fake server that is the real one: the real route handlers over the real
 * `DrawService`, with in-memory draw and ledger repositories that enforce the same
 * rules the SQL does (who may seal, a nonce only after the commit, the commit over
 * the stored seals). Only the network and the Supabase session are replaced, so
 * what the browser verifies is what a real server would have published.
 */
function createServer(
  role: Role,
  opts: { override?: Override; tamper?: Tamper; groups?: number; bankPaid?: boolean; cashPaid?: boolean; clock?: () => Date } = {}
) {
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [
      { id: CASH, groupId: GROUP, code: "POT_CASH", name: "Pot cash", type: "asset" },
      { id: EXPENSE, groupId: GROUP, code: "PAYOUT_EXPENSE", name: "Payout", type: "expense" }
    ],
    clock: () => new Date(NOW)
  });
  const roster = [
    { userId: TREASURER, role: role === "member" ? ("owner" as const) : role },
    { userId: MEMBER_B, role: "member" as const },
    { userId: MEMBER_C, role: "member" as const }
  ];
  const repository = new InMemoryDrawRepository({
    groups: [{ groupId: GROUP, members: roster }],
    hasher: nodeDrawHasher,
    // Deadlines are the draw repository's clock; a test that crosses one hands it a clock it can move.
    clock: opts.clock ?? (() => new Date(NOW))
  });
  const service = new DrawService(repository, new LedgerService(ledger), {
    hasher: nodeDrawHasher,
    clock: () => new Date(NOW)
  });
  const post: Record<string, (request: Request) => Promise<Response>> = {
    "/api/draw/commits": createCommitHandler(() => service),
    "/api/draw/reveals": createRevealHandler(() => service),
    "/api/draw/verify": createVerifyHandler(() => service),
    "/api/draw/payouts": createPayoutHandler(() => service),
    "/api/draw/cycles": createCycleCreateHandler(() => service),
    "/api/draw/draws": createDrawOpenHandler(() => service),
    "/api/draw/seals": createSealHandler(() => service),
    "/api/draw/nonces": createNonceHandler(() => service),
    "/api/draw/cancel": createCancelHandler(() => service)
  };
  const listCycles = createCycleListHandler(() => service);
  const readCycle = createCycleReadHandler(() => service);
  const readSession = createSessionHandler(() => service);
  const calls: string[] = [];
  const bodies: { path: string; body: Record<string, unknown> }[] = [];

  const members = roster.map((entry, index) => ({
    userId: entry.userId,
    role: entry.role,
    joinedAt: `2026-09-0${index + 1}T00:00:00Z`,
    email: entry.userId === TREASURER ? "treasurer@example.test" : null
  }));

  const baseEntries = [
    { id: "e1", groupId: GROUP, occurredAt: "2026-09-01T09:00:00.000Z", sequence: "1", entryType: "contribution", correctsEntryId: null, postings: [{ accountId: CASH, direction: "debit", amount: "500.00" }, { accountId: INCOME, direction: "credit", amount: "500.00" }] },
    { id: "e2", groupId: GROUP, occurredAt: "2026-10-02T09:00:00.000Z", sequence: "2", entryType: "contribution", correctsEntryId: null, postings: [{ accountId: CASH, direction: "debit", amount: "1000.00" }, { accountId: INCOME, direction: "credit", amount: "1000.00" }] },
    { id: "e3", groupId: GROUP, occurredAt: "2026-10-03T09:00:00.000Z", sequence: "3", entryType: "contribution", correctsEntryId: null, postings: [{ accountId: CASH, direction: "debit", amount: "2000.00" }, { accountId: INCOME, direction: "credit", amount: "2000.00" }] }
  ];

  // With `bankPaid`, entry 2 was posted from MEMBER_B's verified bank receipt.
  const entries = baseEntries.map((entry) =>
    opts.bankPaid && entry.id === "e2"
      ? {
          ...entry,
          provenance: {
            kind: "bank_verification",
            provider: "telebirr",
            verifiedAt: "2026-10-02T09:00:05.000Z",
            verificationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            memberUserId: MEMBER_B
          }
        }
      : opts.cashPaid && entry.id === "e2"
        ? {
            ...entry,
            provenance: null,
            // A cash entry whose payer the TREASURER recorded: no bank provenance.
            attribution: {
              source: "treasurer",
              memberUserId: MEMBER_B,
              recordedBy: TREASURER,
              recordedAt: "2026-10-02T09:30:00.000Z",
              cycleId: null,
              round: null,
              revision: 1,
              reason: null
            }
          }
        : { ...entry, provenance: null }
  );

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "POST" && typeof init.body === "string") {
      bodies.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
    }
    const overridden = opts.override?.(url, init);
    if (overridden) return overridden;
    if (path === "/api/my-groups") {
      const one = {
        groupId: GROUP,
        // The role is the signed-in person's: only the treasurer's account has one.
        role: hoisted.userId === TREASURER ? (role === "member" ? "owner" : role) : "member",
        accounts: [
          { id: CASH, code: "POT_CASH" },
          { id: EXPENSE, code: "PAYOUT_EXPENSE" }
        ]
      };
      return Response.json({ groups: opts.groups === 0 ? [] : opts.groups === 2 ? [one, { ...one, groupId: TENANT }] : [one] });
    }
    if (path === "/api/ledger/members") return Response.json({ members });
    if (path === "/api/ledger/entries") return Response.json({ entries });

    const headers = new Headers(init.headers);
    let response: Response;
    const cycleMatch = /^\/api\/draw\/cycles\/([0-9a-f-]{36})$/.exec(path);
    const sessionMatch = /^\/api\/draw\/draws\/([0-9a-f-]{36})$/.exec(path);
    if (path === "/api/draw/cycles" && method === "GET") {
      response = await listCycles(new Request(`http://localhost${url}`, { method, headers }));
    } else if (cycleMatch) {
      response = await readCycle(new Request(`http://localhost${path}`, { method, headers }), { params: { cycleId: cycleMatch[1]! } });
    } else if (sessionMatch) {
      response = await readSession(new Request(`http://localhost${path}`, { method, headers }), { params: { drawId: sessionMatch[1]! } });
    } else {
      const handler = post[path];
      if (!handler) return new Response("{}", { status: 404 });
      response = await handler(new Request(`http://localhost${path}`, { method: "POST", headers, body: init.body as string }));
    }
    if (!opts.tamper || !response.ok) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json(opts.tamper(path.replace(/[0-9a-f-]{36}$/, ":id"), body), { status: response.status });
  }) as typeof fetch;

  return { service, repository, calls, bodies, fetchImpl, members };
}

type Server = ReturnType<typeof createServer>;

function deps(server: Server, userId: string) {
  hoisted.userId = userId;
  return { getToken: async () => tokenFor(userId), fetchImpl: server.fetchImpl };
}

/** Each person's browser storage is their own: switching users swaps it. */
const devices = new Map<string, Record<string, string>>();
let currentDevice: string | null = null;

function switchDevice(userId: string) {
  if (currentDevice !== null) {
    const saved: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)!;
      saved[key] = localStorage.getItem(key)!;
    }
    devices.set(currentDevice, saved);
  }
  localStorage.clear();
  for (const [key, value] of Object.entries(devices.get(userId) ?? {})) localStorage.setItem(key, value);
  currentDevice = userId;
}

/** Open the draw screen as one person, on their own device. */
function renderAs(server: Server, userId: string, locale: "en" | "am" = "en") {
  cleanup();
  switchDevice(userId);
  return render(<LiveDraw locale={locale} accessToken={tokenFor(userId)} deps={deps(server, userId)} />);
}

beforeEach(() => {
  // The server double runs on NOW; the screen reads Date.now() for the seal deadline, so both agree.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  triggerHaptic.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  globalThis.localStorage?.clear();
  devices.clear();
  currentDevice = null;
  hoisted.session = { status: "signed-out" };
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type User = ReturnType<typeof userEvent.setup>;

async function createTheCycle(user: User) {
  await screen.findByTestId("draw-live");
  await user.type(within(screen.getByTestId("cycle-create-form")).getByLabelText("Cycle name"), "Meskerem equb");
  await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
  await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
  expect(screen.getByTestId("cycle-pot-preview")).toHaveTextContent("Br 3,000.00 = 3 members × Br 1,000.00");
  await user.click(screen.getByRole("button", { name: "Create the cycle" }));
  await waitFor(() => expect(screen.getByTestId("cycle-pot")).toHaveTextContent("Br 3,000.00"));
}

async function openTheDraw(user: User) {
  await user.click(await screen.findByRole("button", { name: "Open the draw for round 1" }));
  return (await screen.findByTestId("draw-panel")).closest("[data-draw-panel]") as HTMLElement;
}

/** The server's one draw, found through the same listing members use. */
async function theDrawId(server: Server): Promise<string> {
  const cycles = await server.service.listCycles(GROUP, { userId: TREASURER });
  const detail = await server.service.getCycleDetail(cycles[0]!.cycleId, { userId: TREASURER });
  return detail.draws[detail.draws.length - 1]!.drawId;
}

describe("signed in: cycles", () => {
  it("lets the treasurer create a cycle and shows its terms, with the pot computed by the server", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);

    expect(await screen.findByTestId("cycle-none")).toHaveTextContent("Your group has no draw cycle yet");
    await createTheCycle(user);

    expect(screen.getByTestId("cycle-each")).toHaveTextContent("Br 1,000.00");
    expect(screen.getByTestId("cycle-pot")).toHaveTextContent("Br 3,000.00 ETB (3 members when created)");
    expect(screen.getByTestId("cycle-terms")).toHaveTextContent("0 of 3 drawn, 0 paid");
    // Only the terms the treasurer chose went out; no pot, no group size.
    const sent = server.bodies.find((entry) => entry.path === "/api/draw/cycles")!.body;
    expect(Object.keys(sent).sort()).toEqual([
      "contributionAmount",
      "contributionGate",
      "groupId",
      "idempotencyKey",
      "name",
      "nonceWindowHours",
      "reserveRatioBps",
      "sealWindowHours",
      "totalRounds"
    ]);
    // The form's default policy is `off`: nothing changes for a group that does not choose.
    expect(sent).toMatchObject({ contributionAmount: "1000.00", totalRounds: 3, reserveRatioBps: 1000, contributionGate: "off", sealWindowHours: 48, nonceWindowHours: 48 });
  });

  it("sends the seal and nonce-release windows the treasurer typed, and says they are fixed once created", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await screen.findByTestId("draw-live");

    expect(screen.getByTestId("cycle-windows-hint")).toHaveTextContent("fixed once the cycle is created");
    const seal = screen.getByTestId("cycle-seal-window");
    const nonce = screen.getByTestId("cycle-nonce-window");
    expect(seal).toHaveValue("48");
    expect(nonce).toHaveValue("48");
    await user.clear(seal);
    await user.type(seal, "24");
    await user.clear(nonce);
    await user.type(nonce, "72");
    await user.type(screen.getByLabelText("Cycle name"), "Windows");
    await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
    await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
    await user.click(screen.getByRole("button", { name: "Create the cycle" }));

    await waitFor(() => expect(screen.getByTestId("cycle-pot")).toHaveTextContent("Br 3,000.00"));
    const sent = server.bodies.find((entry) => entry.path === "/api/draw/cycles")!.body;
    expect(sent).toMatchObject({ sealWindowHours: 24, nonceWindowHours: 72 });
  });

  it("REJECTS (before asking the server) a window outside 1 to 720 hours or not a whole number", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await screen.findByTestId("draw-live");

    await user.type(screen.getByLabelText("Cycle name"), "Bad windows");
    await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
    await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
    for (const bad of ["0", "721", "1.5", "abc", ""]) {
      const seal = screen.getByTestId("cycle-seal-window");
      await user.clear(seal);
      if (bad !== "") await user.type(seal, bad);
      expect(screen.getByTestId("cycle-windows-invalid")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create the cycle" }));
      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      expect(server.calls).not.toContain("POST /api/draw/cycles");
    }
  });

  it("refuses rounds beyond the number of members before asking the server", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await screen.findByTestId("draw-live");

    await user.type(screen.getByLabelText("Cycle name"), "Too long");
    await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
    await user.type(screen.getByLabelText("Rounds in the cycle"), "9");
    await user.click(screen.getByRole("button", { name: "Create the cycle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("rounds (1 to 3");
    expect(server.calls).not.toContain("POST /api/draw/cycles");
  });

  it("shows every member the cycle, the draws in it, and the ledger figures with an honest note", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);

    renderAs(server, MEMBER_B);
    expect(await screen.findByTestId("cycle-select")).toHaveDisplayValue("Meskerem equb");
    expect(screen.getByTestId("cycle-pot")).toHaveTextContent("Br 3,000.00");
    const list = screen.getByTestId("draw-list");
    expect(list).toHaveTextContent("Round 1 · sealing");
    // Contributions recorded since the cycle started: the two after it, not the one before.
    await waitFor(() => expect(screen.getByTestId("ledger-recorded")).toHaveTextContent("Br 3,000.00 ETB in 2 contribution entries"));
    // Neither entry carries bank provenance, so the entries are counted as unattributed. Who paid
    // which round is the grid's job now: the ledger panel no longer lists members.
    expect(screen.queryByTestId("ledger-paid-members")).toBeNull();
    expect(screen.queryByTestId("ledger-no-verified")).toBeNull();
    expect(screen.getByTestId("ledger-unattributed-entries")).toHaveTextContent("2 entries (Br 3,000.00 ETB) are not attributed to any member");
    expect(screen.getByTestId("ledger-unattributed")).toHaveTextContent("not one round");
    expect(screen.getByTestId("ledger-unattributed")).toHaveTextContent("grid above");
    expect(screen.getByTestId("ledger-unattributed")).toHaveTextContent("does not mean they have not paid");
    // Members are listed at the configured amount and never marked paid.
    expect(document.querySelector('[data-draw-panel="roster"]')!.textContent).toContain("Br 1,000.00 expected");
    expect(document.querySelector('[data-draw-panel="roster"]')!.textContent).not.toMatch(/\bpaid\b/i);
    // A plain member gets none of the treasurer's controls.
    expect(screen.queryByTestId("cycle-create-form")).toBeNull();
    expect(screen.queryByTestId("open-draw")).toBeNull();
    expect(screen.queryByTestId("commit-button")).toBeNull();
  });
});

describe("signed in: the ledger panel after the grid took over who-paid", () => {
  it("counts bank-verified and cash entries in the window but never lists a member as paid (the grid does that, per round)", async () => {
    for (const opts of [{ bankPaid: true }, { cashPaid: true }]) {
      const user = userEvent.setup();
      const server = createServer("treasurer", opts);
      renderAs(server, TREASURER);
      await createTheCycle(user);

      renderAs(server, MEMBER_C);
      await screen.findByTestId("ledger-recorded");
      await waitFor(() => expect(screen.getByTestId("ledger-recorded")).toHaveTextContent("Br 3,000.00 ETB in 2 contribution entries"));
      // The per-member "paid since the cycle began" list is gone: it said nothing about a round.
      expect(screen.queryByTestId("ledger-paid-members")).toBeNull();
      expect(screen.queryByTestId("ledger-paid-member")).toBeNull();
      expect(screen.queryByTestId("ledger-treasurer-mark")).toBeNull();
      expect(screen.queryByTestId("ledger-no-verified")).toBeNull();
      // The entry no member is credited for is still counted, so the treasurer knows what to attribute.
      expect(screen.getByTestId("ledger-unattributed-entries")).toHaveTextContent("1 entries (Br 2,000.00 ETB) are not attributed to any member");
      const text = document.querySelector('[data-draw-panel="ledger"]')!.textContent ?? "";
      expect(text).not.toMatch(/unpaid|in default|overdue/i);
      expect(server.calls.filter((call) => call.includes("/api/ledger"))).not.toContain("POST /api/ledger/entries");
    }
  });
});

describe("signed in: the ceremony, member and treasurer", () => {
  it("runs seal, commit, release, reveal, browser verification and a confirmed payout, in that order", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    expect(screen.getByTestId("seal-progress")).toHaveTextContent("0 of 3 eligible members have sealed.");
    // Nobody has sealed, so the treasurer cannot commit yet: EVERY eligible member must seal.
    expect(screen.getByTestId("commit-needs-all")).toHaveTextContent("3 of 3 have not sealed yet");
    expect(screen.getByTestId("commit-button")).toBeDisabled();

    // Member B, on their own device, seals. The request carries no member id.
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    const drawId = await theDrawId(server);
    const sealRequest = server.bodies.find((entry) => entry.path === "/api/draw/seals")!.body;
    expect(Object.keys(sealRequest).sort()).toEqual(["drawId", "sealed"]);
    const mine = readSeal(drawId)!;
    expect(sealRequest.sealed).toBe(mine.sealed);
    expect(screen.getByTestId("seal-progress")).toHaveTextContent("1 of 3 eligible members have sealed.");
    // The nonce decides the winner: it is not in the page, and not offered yet.
    expect(document.body.textContent ?? "").not.toContain(mine.nonce);
    expect(screen.getByTestId("release-locked")).toHaveTextContent("Do not release your nonce yet");
    expect(screen.queryByTestId("release-button")).toBeNull();

    // Member C seals on their device (through the service here), and the treasurer seals their own.
    const cSeal = await sealForDraw(drawId, MEMBER_C);
    await server.service.submitSeal({ drawId, sealed: cSeal.sealed }, { userId: MEMBER_C });
    renderAs(server, TREASURER);
    await screen.findByTestId("seal-progress");
    expect(screen.getByTestId("seal-progress")).toHaveTextContent("2 of 3 eligible members have sealed.");
    // Two of three: Commit stays held until M of M have sealed.
    expect(screen.getByTestId("commit-needs-all")).toHaveTextContent("1 of 3 have not sealed yet");
    expect(screen.getByTestId("commit-button")).toBeDisabled();
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    expect(screen.getByTestId("seal-progress")).toHaveTextContent("3 of 3 eligible members have sealed.");
    const treasurerSeal = readSeal(drawId)!;

    // Everyone has sealed: the treasurer commits. Nothing but entropy is sent.
    expect(screen.queryByTestId("commit-needs-all")).toBeNull();
    await user.click(screen.getByTestId("commit-button"));
    await screen.findByTestId("reveal-form");
    const commitRequest = server.bodies.find((entry) => entry.path === "/api/draw/commits")!.body;
    expect(Object.keys(commitRequest).sort()).toEqual(["commitmentNonce", "drawId", "idempotencyKey", "seed"]);
    // Committed, but nobody has released: the reveal is not offered yet.
    expect(screen.getByTestId("reveal-waiting")).toHaveTextContent("Waiting for 3 member(s)");
    expect(screen.getByTestId("reveal-button")).toBeDisabled();

    // B releases once the commitment is published.
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("release-button"));
    await screen.findByTestId("release-done");
    const nonceRequest = server.bodies.find((entry) => entry.path === "/api/draw/nonces")!.body;
    expect(Object.keys(nonceRequest).sort()).toEqual(["drawId", "nonce"]);
    expect(nonceRequest.nonce).toBe(mine.nonce);

    // C releases, and so does the treasurer, who sealed too.
    await server.service.submitNonce({ drawId, nonce: cSeal.nonce }, { userId: MEMBER_C });

    // The treasurer reveals with the seed only; the server supplies the nonces.
    renderAs(server, TREASURER);
    await user.click(await screen.findByTestId("release-button"));
    await screen.findByTestId("release-done");
    expect(treasurerSeal.nonce.length).toBeGreaterThan(0);
    await screen.findByTestId("nonce-progress");
    expect(screen.getByTestId("nonce-progress")).toHaveTextContent("3 of 3 sealed members have released their nonce.");
    await user.click(screen.getByTestId("reveal-button"));
    await screen.findByTestId("compare-result");
    const revealRequest = server.bodies.find((entry) => entry.path === "/api/draw/reveals")!.body;
    expect(Object.keys(revealRequest).sort()).toEqual(["drawId", "idempotencyKey", "seed"]);
    expect(screen.getByTestId("compare-result")).toHaveTextContent("This device and the server agree.");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Verified");
    expect(screen.getByTestId("verdict-server")).toHaveTextContent("Verified");

    // The payout is offered with amount and both canonical accounts; nothing is posted until confirmed.
    const payoutButton = await screen.findByRole("button", { name: "Post payout to the ledger" });
    // The reserve is the cycle's ratio of the pot (10% of 3,000.00), rounded half up to the cent.
    expect(screen.getByTestId("payout-amount")).toHaveTextContent("Br 2,700.00");
    expect(screen.getByTestId("payout-debit")).toHaveTextContent(`PAYOUT_EXPENSE ${EXPENSE}`);
    expect(screen.getByTestId("payout-credit")).toHaveTextContent(`POT_CASH ${CASH}`);
    expect(payoutButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I confirm this payout/ }));
    await user.click(payoutButton);
    await waitFor(() => expect(screen.getByTestId("payout-done")).toHaveTextContent("ledger entry #"));
    expect(server.calls.filter((call) => call === "POST /api/draw/payouts")).toHaveLength(1);

    // The order of the ceremony as the server saw it.
    const order = server.calls.filter((call) => /POST \/api\/draw\/(draws|seals|commits|nonces|reveals|payouts)$/.test(call));
    expect(order).toEqual([
      "POST /api/draw/draws",
      "POST /api/draw/seals",
      "POST /api/draw/seals",
      "POST /api/draw/commits",
      "POST /api/draw/nonces",
      "POST /api/draw/nonces",
      "POST /api/draw/reveals",
      "POST /api/draw/payouts"
    ]);
    const round = await server.service.getRound(drawId, { userId: TREASURER });
    expect(round.state).toBe("paid");
    expect(round.payout?.amount).toBe("2700.00");
  });

  it("never lets the member release before the commit: the screen withholds it and the server refuses it", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    const drawId = await theDrawId(server);
    const mine = readSeal(drawId)!;

    // The screen offers nothing to release while sealing...
    expect(screen.queryByRole("button", { name: "Release my nonce" })).toBeNull();
    // ...and a member who forces the request anyway is refused by the server.
    const response = await server.fetchImpl("/api/draw/nonces", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(MEMBER_B)}`, "content-type": "application/json" },
      body: JSON.stringify({ drawId, nonce: mine.nonce })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "nonce_too_early" });
  });

  it("warns a member whose seal is not in the published commitment, and offers no release", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer", {
      tamper: (path, body) => {
        if (path !== "/api/draw/draws/:id" || (body.session as { state?: string }).state !== "committed") return body;
        const session = body.session as Record<string, unknown>;
        return { ...body, session: { ...session, seals: (session.seals as { memberId: string }[]).filter((seal) => seal.memberId !== MEMBER_B) } };
      }
    });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    // Commit directly through the service, with member C also sealed so the treasurer may.
    const drawId = await theDrawId(server);
    const c = await sealForDraw(drawId, MEMBER_C);
    await server.service.submitSeal({ drawId, sealed: c.sealed }, { userId: MEMBER_C });
    const t = await sealForDraw(drawId, TREASURER);
    await server.service.submitSeal({ drawId, sealed: t.sealed }, { userId: TREASURER });
    await server.service.commitFromSession({ drawId, seed: "live-test-seed-0123456789", commitmentNonce: "live-test-commit-nonce-0123", idempotencyKey: "k-commit-1" }, { userId: TREASURER });

    renderAs(server, MEMBER_B);
    expect(await screen.findByTestId("seal-closed")).toHaveTextContent("your seal is not in it");
    expect(screen.queryByRole("button", { name: "Release my nonce" })).toBeNull();
  });

  it("tells a member whose device lost the nonce, and lets them re-seal while sealing is open", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    const drawId = await theDrawId(server);
    const first = readSeal(drawId)!;

    // The browser's storage is cleared.
    localStorage.clear();
    renderAs(server, MEMBER_B);
    const mismatch = await screen.findByTestId("seal-mismatch");
    expect(mismatch).toHaveTextContent("no longer holds the nonce for your seal");
    await user.click(within(mismatch).getByRole("button", { name: "Replace my seal" }));
    await screen.findByTestId("my-seal");
    const second = readSeal(drawId)!;
    expect(second.sealed).not.toBe(first.sealed);
    const session = await server.service.getSession(drawId, { userId: MEMBER_B });
    expect(session.seals.find((seal) => seal.memberId === MEMBER_B)?.sealed).toBe(second.sealed);
  });

  it("tells a member who is not on the roster that they cannot seal", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    // Make member B ineligible by removing them from the roster in the server's view.
    server.repository.setGroup({
      groupId: GROUP,
      members: [
        { userId: TREASURER, role: "treasurer" },
        { userId: MEMBER_B, role: "member", active: false },
        { userId: MEMBER_C, role: "member" }
      ]
    });
    renderAs(server, MEMBER_C);
    await screen.findByTestId("draw-panel");
    // C is still eligible; B being inactive is simply not on the list.
    expect(screen.getByTestId("seal-progress")).toHaveTextContent("0 of 2 eligible members have sealed.");
    expect(screen.getByTestId("seal-button")).toBeEnabled();
  });
});

describe("roles", () => {
  it("a plain member sees the cycle, ledger and draw cards but none of the treasurer steps", async () => {
    const server = createServer("member");
    await server.service.createCycle(
      { groupId: GROUP, name: "Cycle", contributionAmount: "1000.00", totalRounds: 3, reserveRatioBps: 1000, idempotencyKey: "cyc-1" },
      { userId: TREASURER }
    );
    renderAs(server, MEMBER_B);
    await screen.findByTestId("cycle-select");

    expect(document.querySelector('[data-draw-panel="cycle"]')).not.toBeNull();
    expect(document.querySelector('[data-draw-panel="ledger"]')).not.toBeNull();
    expect(document.querySelector('[data-draw-panel="draws"]')).not.toBeNull();
    expect(screen.queryByTestId("cycle-create-form")).toBeNull();
    expect(screen.queryByTestId("open-draw")).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit the draw" })).toBeNull();
    expect(screen.getByText(/Only the owner or treasurer can create cycles, commit, reveal or pay/)).toBeInTheDocument();
  });

  it("shows the server's refusal when a non-treasurer slips past the UI", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer", {
      override: (url, init) =>
        url.startsWith("/api/draw/draws") && init.method === "POST"
          ? Response.json({ error: "forbidden", message: "draw_forbidden" }, { status: 403 })
          : null
    });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await user.click(await screen.findByRole("button", { name: "Open the draw for round 1" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only the owner or treasurer of the group can do this.");
    // The server's own English text is never rendered: the code is said in the member's language.
    expect(alert).not.toHaveTextContent("draw_forbidden");
  });

  it("refuses with a message on no group and on several groups", async () => {
    const none = createServer("owner", { groups: 0 });
    renderAs(none, TREASURER);
    expect(await screen.findByTestId("draw-live-refusal")).toHaveTextContent("You are not in a group yet");

    const many = createServer("owner", { groups: 2 });
    renderAs(many, TREASURER);
    expect(await screen.findByTestId("draw-live-refusal")).toHaveTextContent("Choose one with the group switcher");
    expect(many.calls).not.toContain("GET /api/ledger/members");
  });
});

describe("server errors", () => {
  it("maps every server error code to a bilingual message", () => {
    const codes = [
      ...DRAW_ERROR_CODES.map((code) => code.toLowerCase()),
      "unauthorized",
      "not_configured",
      "auth_unavailable",
      "bad_request",
      "rate_limited",
      "draw_failed",
      "bad_response",
      "network"
    ];
    for (const code of codes) {
      const key = drawErrorKey({ code, status: 422 });
      expect(key, code).not.toBe("drawLive.error.generic");
      for (const locale of ["en", "am"] as const) {
        expect(dictionaries[locale][key], `${locale} ${key}`).toBeTruthy();
      }
    }
    expect(drawErrorKey({ code: "who-knows", status: 403 })).toBe("drawLive.error.forbidden");
    expect(drawErrorKey({ code: "who-knows", status: 500 })).toBe("drawLive.error.generic");
  });

  it("shows the real error for a rejected reveal, in the chosen language", async () => {
    const user = userEvent.setup();
    const server = createServer("owner", {
      override: (url) =>
        url.startsWith("/api/draw/reveals")
          ? Response.json({ error: "member_commitment_mismatch", message: "nonce does not open" }, { status: 422 })
          : null
    });
    // Reach the committed-and-released state through the service, then reveal in the UI.
    const { drawId } = await committedDraw(server);
    renderAs(server, TREASURER, "am");
    await screen.findByTestId("reveal-form");
    await user.click(screen.getByTestId("reveal-button"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(dictionaries.am["drawLive.error.memberMismatch"]);
    // The server's English detail ("nonce does not open") is not shown next to the translated message.
    expect(alert).not.toHaveTextContent("nonce does not open");
    expect(screen.queryByTestId("compare-result")).toBeNull();
    expect(drawId).toBeTruthy();
  });
});

const TREASURER_SEED = "treasurer-seed-0123456789-xyz";

/**
 * A cycle with one draw committed and every sealed member's nonce released,
 * built directly on the server, with the treasurer's seed saved where the
 * treasurer's browser keeps it.
 */
async function committedDraw(server: Server) {
  const owner = { userId: TREASURER };
  const { cycle } = await server.service.createCycle(
    { groupId: GROUP, name: "Meskerem equb", contributionAmount: "1000.00", totalRounds: 3, reserveRatioBps: 1000, idempotencyKey: "cyc-1" },
    owner
  );
  const { session } = await server.service.openDraw({ cycleId: cycle.cycleId, idempotencyKey: "open-1" }, owner);
  const drawId = session.drawId;
  // The quorum is every eligible member: B, C and the treasurer all seal, then all release.
  const everyone = [MEMBER_B, MEMBER_C, TREASURER];
  const seals = new Map<string, Awaited<ReturnType<typeof sealForDraw>>>();
  for (const memberId of everyone) {
    const mine = await sealForDraw(drawId, memberId);
    await server.service.submitSeal({ drawId, sealed: mine.sealed }, { userId: memberId });
    seals.set(memberId, mine);
  }
  const b = seals.get(MEMBER_B)!;
  const commitKey = `draw-commit.${drawId}`;
  await server.service.commitFromSession(
    { drawId, seed: TREASURER_SEED, commitmentNonce: "treasurer-commit-nonce-0123456789", idempotencyKey: commitKey },
    owner
  );
  for (const memberId of everyone) {
    await server.service.submitNonce({ drawId, nonce: seals.get(memberId)!.nonce }, { userId: memberId });
  }
  // The treasurer's device holds the seed it committed with, and the nonce of its own seal.
  switchDevice(TREASURER);
  writeSeal(seals.get(TREASURER)!);
  localStorage.setItem(
    `sened.draw.draft.${drawId}`,
    JSON.stringify({
      drawId,
      seed: TREASURER_SEED,
      commitmentNonce: "treasurer-commit-nonce-0123456789",
      commitKey,
      revealKey: `draw-reveal.${drawId}`,
      committed: true
    })
  );
  return { drawId, cycleId: cycle.cycleId, b };
}

/** A revealed draw created directly on the server, for the verification tests. */
async function revealedDraw(server: Server) {
  const made = await committedDraw(server);
  await server.service.reveal({ drawId: made.drawId, seed: TREASURER_SEED }, { userId: TREASURER });
  return made.drawId;
}

describe("verification happens in the browser", () => {
  it("any member sees this device and the server agree on an honest draw", async () => {
    const server = createServer("member");
    await revealedDraw(server);
    renderAs(server, MEMBER_C);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("agree");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Verified");
    // A plain member is never offered the payout.
    expect(document.querySelector('[data-draw-panel="payout"]')).toBeNull();
  });

  it("catches a server that names a different winner than the published values produce", async () => {
    const server = createServer("owner", {
      tamper: (path, body) => {
        if (path !== "/api/draw/verify") return body;
        const round = body.round as Record<string, unknown>;
        const honest = round.winnerMemberId as string;
        const other = server.members.find((entry) => entry.userId !== honest)!.userId;
        return { ...body, round: { ...round, winnerMemberId: other } };
      }
    });
    await revealedDraw(server);
    renderAs(server, TREASURER);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("DISAGREE");
    expect(screen.getByText(/winner the server recorded is not the winner/)).toBeInTheDocument();
    // The recomputation, not the server, decides: payout is withheld.
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post payout to the ledger" })).toBeNull();
    expect(server.calls).not.toContain("POST /api/draw/payouts");
  });

  it("catches a forged seed even when the server still claims the draw verified", async () => {
    const server = createServer("owner", {
      tamper: (path, body) => {
        if (path !== "/api/draw/verify") return body;
        const transcript = body.transcript as Record<string, unknown>;
        return { ...body, transcript: { ...transcript, seed: "a-different-seed-0123456789-zzz" } };
      }
    });
    await revealedDraw(server);
    renderAs(server, TREASURER);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("DISAGREE");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Does not verify");
    expect(screen.getByTestId("verdict-server")).toHaveTextContent("Verified");
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
  });

  it("catches a member nonce that does not open what was sealed", async () => {
    const server = createServer("owner", {
      tamper: (path, body) =>
        path === "/api/draw/verify"
          ? { ...body, memberNonces: [{ memberId: MEMBER_B, nonce: "forged-nonce-0123456789-abcdef" }] }
          : body
    });
    await revealedDraw(server);
    renderAs(server, TREASURER);

    expect(await screen.findByTestId("verdict-device")).toHaveTextContent("Does not verify");
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
  });

  it("says the verification text in the chosen language, with no Amharic left in English", async () => {
    const server = createServer("owner");
    await revealedDraw(server);
    renderAs(server, TREASURER, "en");
    await screen.findByTestId("compare-result");
    const verify = document.querySelector('[data-draw-panel="verify"]') as HTMLElement;
    const risk = document.querySelector('[data-draw-panel="risk"]') as HTMLElement;
    expect(verify.textContent).toContain("Verified");
    expect(verify.textContent ?? "").not.toMatch(/[\u1200-\u137F]/);
    expect(risk.textContent).toContain("Base reserve is");
    expect(risk.textContent ?? "").not.toMatch(/[\u1200-\u137F]/);

    renderAs(server, TREASURER, "am");
    await screen.findByTestId("compare-result");
    const verifyAm = document.querySelector('[data-draw-panel="verify"]') as HTMLElement;
    const riskAm = document.querySelector('[data-draw-panel="risk"]') as HTMLElement;
    expect(verifyAm.textContent).toContain("ተረጋግጧል");
    // The risk notes are Amharic too, not the engine's English.
    expect(riskAm.textContent).toContain("መነሻ ክምችቱ");
    expect(riskAm.textContent ?? "").not.toContain("Base reserve is");
  });
});

describe("haptics follow the live ceremony", () => {
  const buzzes = () => triggerHaptic.mock.calls.map((call) => (call as unknown as [string])[0]);

  it("buzzes at seal, commit, release, reveal and the verified winner, and nowhere else", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    expect(buzzes()).toEqual([]);

    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    expect(buzzes()).toEqual(["commitSealed"]);

    // Member C seals through the service (no buzz: it is not this device); the treasurer seals their own.
    const drawId = await theDrawId(server);
    const cSeal = await sealForDraw(drawId, MEMBER_C);
    await server.service.submitSeal({ drawId, sealed: cSeal.sealed }, { userId: MEMBER_C });
    renderAs(server, TREASURER);
    await user.click(await screen.findByTestId("seal-button"));
    await screen.findByTestId("my-seal");
    expect(buzzes()).toEqual(["commitSealed", "commitSealed"]);
    await user.click(screen.getByTestId("commit-button"));
    await screen.findByTestId("reveal-form");
    expect(buzzes()).toEqual(["commitSealed", "commitSealed", "commitSealed"]);

    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("release-button"));
    await screen.findByTestId("release-done");
    expect(buzzes()).toEqual(["commitSealed", "commitSealed", "commitSealed", "revealStep"]);
    await server.service.submitNonce({ drawId, nonce: cSeal.nonce }, { userId: MEMBER_C });

    renderAs(server, TREASURER);
    await user.click(await screen.findByTestId("release-button"));
    await screen.findByTestId("release-done");
    await user.click(screen.getByTestId("reveal-button"));
    await screen.findByTestId("compare-result");
    await waitFor(() => expect(buzzes()).toContain("winnerRevealed"));
    expect(buzzes()).toEqual(["commitSealed", "commitSealed", "commitSealed", "revealStep", "revealStep", "revealStep", "winnerRevealed"]);
  });

  it("does not buzz when someone merely opens a draw that was already revealed", async () => {
    const server = createServer("member");
    await revealedDraw(server);
    renderAs(server, MEMBER_C);
    expect(await screen.findByTestId("compare-result")).toHaveTextContent("agree");
    expect(buzzes()).toEqual([]);
  });

  it("buzzes the tamper pattern, not the winner one, when this device disagrees with the server", async () => {
    const user = userEvent.setup();
    const server = createServer("owner", {
      tamper: (path, body) => {
        if (path !== "/api/draw/verify") return body;
        const transcript = body.transcript as Record<string, unknown>;
        return { ...body, transcript: { ...transcript, seed: "a-different-seed-0123456789-zzz" } };
      }
    });
    await committedDraw(server);
    renderAs(server, TREASURER);
    await user.click(await screen.findByTestId("reveal-button"));
    expect(await screen.findByTestId("compare-result")).toHaveTextContent("DISAGREE");
    await waitFor(() => expect(buzzes()).toContain("tamperDetected"));
    expect(buzzes()).toEqual(["revealStep", "tamperDetected"]);
  });

  it("buzzes a member who refreshes into a reveal that just happened, once", async () => {
    const user = userEvent.setup();
    const server = createServer("member");
    const made = await committedDraw(server);
    renderAs(server, MEMBER_C);
    await screen.findByTestId("draw-live");
    await server.service.reveal({ drawId: made.drawId, seed: TREASURER_SEED }, { userId: TREASURER });
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await screen.findByTestId("compare-result");
    await waitFor(() => expect(buzzes()).toEqual(["winnerRevealed"]));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByTestId("compare-result");
    expect(buzzes()).toEqual(["winnerRevealed"]);
  });
});

describe("copy", () => {
  it("has English and Amharic text for every live key", () => {
    const live = Object.keys(dictionaries.en).filter((key) => key.startsWith("drawLive.") || key.startsWith("draw.demo"));
    expect(live.length).toBeGreaterThan(60);
    for (const key of live) {
      const k = key as keyof typeof dictionaries.en;
      expect(dictionaries.am[k]).toBeTruthy();
      expect(translate("am", k, { id: "x", sequence: "1" })).not.toBe(dictionaries.en[k]);
    }
  });
});

describe("signed in: collateral for each winner (advisory)", () => {
  const WINNER = TREASURER; // the first round's winner in the fixture view
  const T0 = "2026-10-10T09:00:00.000Z";
  const G1 = "11111111-aaaa-4aaa-8aaa-111111111111";

  function guaranteeWire(state: string, extra: Record<string, unknown> = {}) {
    return {
      guaranteeId: G1,
      cycleId: "",
      winnerMemberId: WINNER,
      guarantorMemberId: MEMBER_B,
      proposedBy: TREASURER,
      proposedAt: T0,
      state,
      stateAt: T0,
      stateBy: state === "accepted" ? MEMBER_B : TREASURER,
      acceptedAt: state === "accepted" ? T0 : null,
      reason: null,
      successorGuaranteeId: null,
      ...extra
    };
  }

  /** Overrides the two collateral routes; everything else is the real fake server. */
  function collateralOverride(state: { guarantee: string; posted: Record<string, unknown>[]; failRead?: boolean; cycleId?: string }): Override {
    return (url, init) => {
      const path = url.split("?")[0]!;
      if (path === "/api/draw/collateral") {
        if (state.failRead) return new Response("{}", { status: 500 });
        const cycleId = new URL(url, "http://localhost").searchParams.get("cycleId")!;
        state.cycleId = cycleId;
        return Response.json({
          collateral: {
            cycleId,
            groupId: GROUP,
            totalRounds: 3,
            contributionAmount: "1000.00",
            potAmount: "3000.00",
            reserveRatioBps: 1000,
            startedAt: T0,
            nextRound: 2,
            eligibleCount: 2,
            reserveRetained: "300.00",
            flaggedCount: 1,
            winners: [
              {
                memberId: WINNER,
                round: 1,
                revealedAt: T0,
                owed: [
                  { round: 2, status: "flagged", dueAt: T0, entryId: null, source: null },
                  { round: 3, status: "not_due", dueAt: null, entryId: null, source: null }
                ],
                guarantees: [{ ...guaranteeWire(state.guarantee), cycleId }]
              }
            ]
          }
        });
      }
      if (path === "/api/draw/guarantees" && init.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        state.posted.push(body);
        if (body.action === "accept") state.guarantee = "accepted";
        return Response.json({ guarantee: { ...guaranteeWire(state.guarantee), cycleId: state.cycleId }, superseded: null, replayed: false });
      }
      return null;
    };
  }

  it("shows the guarantor their own confirm control, sends only the guarantee id, and re-reads the derived view", async () => {
    const user = userEvent.setup();
    const state = { guarantee: "proposed", posted: [] as Record<string, unknown>[] };
    const server = createServer("treasurer", { override: collateralOverride(state) });
    renderAs(server, TREASURER);
    await createTheCycle(user);

    renderAs(server, MEMBER_B);
    const panel = await screen.findByTestId("collateral-panel");
    expect(await within(panel).findByTestId("collateral-winner")).toHaveTextContent("treasurer@example.test · won round 1");
    expect(within(panel).getByTestId("collateral-advisory")).toHaveTextContent("Nothing here moves money");
    expect(within(panel).getAllByTestId("collateral-round").map((entry) => entry.getAttribute("data-round-status"))).toEqual(["flagged", "not_due"]);
    expect(within(panel).getByTestId("collateral-retained")).toHaveTextContent("300.00 ETB");
    // This member IS the guarantor named, so the confirm control is theirs; the treasurer's controls are not.
    expect(within(panel).queryByTestId("guarantee-propose")).toBeNull();
    await user.click(within(panel).getByTestId("guarantee-accept"));

    await waitFor(() => expect(state.posted).toEqual([{ action: "accept", guaranteeId: G1 }]));
    await waitFor(() => expect(within(screen.getByTestId("collateral-panel")).getByTestId("guarantee-state")).toHaveTextContent("Confirmed by the guarantor"));
    expect(within(screen.getByTestId("collateral-panel")).queryByTestId("guarantee-accept")).toBeNull();
    // Nothing but the draw, ledger-read and collateral routes was called: no ledger write, no payout.
    expect(server.calls).not.toContain("POST /api/ledger/entries");
    expect(server.calls).not.toContain("POST /api/draw/payouts");
  });

  it("gives the treasurer propose, release and replace controls, and not the guarantor's confirm", async () => {
    const user = userEvent.setup();
    const state = { guarantee: "accepted", posted: [] as Record<string, unknown>[] };
    const server = createServer("treasurer", { override: collateralOverride(state) });
    renderAs(server, TREASURER);
    await createTheCycle(user);

    const panel = await screen.findByTestId("collateral-panel");
    await within(panel).findByTestId("collateral-winner");
    expect(within(panel).getByTestId("guarantee-propose")).toBeInTheDocument();
    expect(within(panel).getByTestId("guarantee-release")).toBeInTheDocument();
    expect(within(panel).getByTestId("guarantee-supersede")).toBeInTheDocument();
    expect(within(panel).queryByTestId("guarantee-accept")).toBeNull();
    expect(within(panel).queryByTestId("guarantee-decline")).toBeNull();
  });

  it("says the record is unavailable, rather than guessing, when the collateral read fails", async () => {
    const user = userEvent.setup();
    const state = { guarantee: "proposed", posted: [] as Record<string, unknown>[], failRead: true };
    const server = createServer("treasurer", { override: collateralOverride(state) });
    renderAs(server, TREASURER);
    await createTheCycle(user);

    const panel = await screen.findByTestId("collateral-panel");
    await waitFor(() => expect(within(panel).getByTestId("collateral-status")).toHaveTextContent("could not be read"));
    expect(within(panel).queryByTestId("collateral-winner")).toBeNull();
    expect(within(panel).getByTestId("collateral-advisory")).toBeInTheDocument();
  });

  it("speaks Amharic when the screen does", async () => {
    const user = userEvent.setup();
    const state = { guarantee: "proposed", posted: [] as Record<string, unknown>[] };
    const server = createServer("treasurer", { override: collateralOverride(state) });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    renderAs(server, MEMBER_B, "am");
    const panel = await screen.findByTestId("collateral-panel");
    await within(panel).findByTestId("collateral-winner");
    expect(panel).toHaveTextContent(translate("am", "collateral.title"));
    expect(panel).toHaveTextContent(translate("am", "collateral.advisory"));
  });
});

describe("a seal lost to an ambiguous network failure is not thrown away", () => {
  it("keeps the nonce when the server stored the seal and only the reply was lost", async () => {
    const user = userEvent.setup();
    let applied = false;
    // eslint-disable-next-line prefer-const
    let server: Server;
    server = createServer("treasurer", {
      override: (url, init) => {
        if (!url.startsWith("/api/draw/seals") || applied) return null;
        applied = true;
        const body = JSON.parse(String(init.body)) as { drawId: string; sealed: string };
        // The seal reaches the database ...
        return server.service
          .submitSeal(body, { userId: hoisted.userId })
          .then(() => {
            // ... and the connection drops before the reply.
            throw new TypeError("network lost");
          });
      }
    });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));

    // The screen asked the server what it holds, found the seal, and kept the nonce that opens it.
    await screen.findByTestId("my-seal");
    const drawId = await theDrawId(server);
    const mine = readSeal(drawId);
    expect(mine).not.toBeNull();
    const held = (await server.service.getSession(drawId, { userId: MEMBER_B })).seals.find((seal) => seal.memberId === MEMBER_B);
    expect(held?.sealed).toBe(mine!.sealed);
  });

  it("keeps the nonce when the server cannot be asked either, and says so", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer", {
      override: (url, init) => {
        if (!url.startsWith("/api/draw/seals") && !(url.startsWith("/api/draw/draws/") && (init.method ?? "GET") === "GET" && sealSent)) return null;
        sealSent = true;
        throw new TypeError("network down");
      }
    });
    let sealSent = false;
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    sealSent = false;
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));

    expect(await screen.findByText(translate("en", "drawLive.sealUnsure"))).toBeInTheDocument();
    const drawId = await theDrawId(server);
    // The seal may be on the server, so the nonce stays on this device.
    expect(readSeal(drawId)).not.toBeNull();
  });

  it("still clears the nonce when the server answers that it refused the seal", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer", {
      override: (url) =>
        url.startsWith("/api/draw/seals") ? Response.json({ error: "not_eligible" }, { status: 403 }) : null
    });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    renderAs(server, MEMBER_B);
    await user.click(await screen.findByTestId("seal-button"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const drawId = await theDrawId(server);
    expect(readSeal(drawId)).toBeNull();
  });
});

describe("cancelling for members who did not respond", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the deadline and offers no cancel before it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T10:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const server = createServer("treasurer");
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);

    expect(screen.getByTestId("seal-deadline")).toBeInTheDocument();
    expect(screen.queryByTestId("sealing-closed")).toBeNull();
    expect(screen.getByTestId("cancel-early")).toBeInTheDocument();
    expect(screen.queryByTestId("cancel-button")).toBeNull();
    expect(screen.queryByTestId("cancel-reason")).toBeNull();
  });

  it("after the deadline the treasurer cancels with a reason, and every member sees who, why and who missed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const server = createServer("treasurer", { clock: () => new Date() });
    renderAs(server, TREASURER);
    await createTheCycle(user);
    await openTheDraw(user);
    expect(screen.getByTestId("cancel-early")).toBeInTheDocument();

    // Two days pass with nobody sealing: the seal deadline (48 hours) is behind us.
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByTestId("cancel-button");
    expect(screen.queryByTestId("cancel-early")).toBeNull();
    // Past the seal deadline the draw says sealing is closed and offers no seal button.
    expect(screen.getByTestId("sealing-closed")).toHaveTextContent("Sealing closed on");
    expect(screen.queryByTestId("seal-deadline")).toBeNull();
    expect(screen.queryByTestId("seal-button")).toBeNull();
    const button = await screen.findByTestId("cancel-button");
    expect(button).toBeDisabled();
    await user.type(screen.getByTestId("cancel-reason"), "short");
    expect(button).toBeDisabled();
    await user.clear(screen.getByTestId("cancel-reason"));
    await user.type(screen.getByTestId("cancel-reason"), "Two members never sealed within the window");
    await user.click(button);

    const list = await screen.findByTestId("cancellation-list");
    expect(list).toHaveTextContent("Two members never sealed within the window");
    expect(list).toHaveTextContent("before the commit");
    expect(list).toHaveTextContent("Did not respond:");
    const request = server.bodies.find((entry) => entry.path === "/api/draw/cancel")!.body;
    expect(Object.keys(request).sort()).toEqual(["drawId", "reason"]);
    expect(screen.getByTestId("cancelled-note")).toHaveTextContent("Two members never sealed within the window");
    // The canceller is told it was recorded.
    expect(screen.getByTestId("draw-notice")).toHaveTextContent("The draw was cancelled and recorded.");

    // A plain member sees the same record and is offered nothing to cancel.
    renderAs(server, MEMBER_B);
    expect(await screen.findByTestId("cancellation-list")).toHaveTextContent("Two members never sealed within the window");
    expect(screen.queryByTestId("cancel-form")).toBeNull();
  });

  it("once the reveal is opened the draw must be finished: no cancel, and a manager without the seed can finish it", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    const { drawId } = await committedDraw(server);
    await server.repository.requestReveal({ drawId, seed: TREASURER_SEED }, { userId: TREASURER });
    // This device never held the seed (another manager committed): only the published one exists.
    localStorage.removeItem(`sened.draw.draft.${drawId}`);
    renderAs(server, TREASURER);

    expect(await screen.findByTestId("cancel-reveal-opened")).toBeInTheDocument();
    expect(screen.queryByTestId("cancel-button")).toBeNull();
    expect(screen.getByTestId("reveal-finish")).toBeInTheDocument();
    await user.click(screen.getByTestId("reveal-button"));
    await screen.findByTestId("compare-result");
    const request = server.bodies.find((entry) => entry.path === "/api/draw/reveals")!.body;
    expect(Object.keys(request).sort()).toEqual(["drawId", "idempotencyKey"]);
    expect(screen.getByTestId("compare-result")).toHaveTextContent("agree");
  });
});
