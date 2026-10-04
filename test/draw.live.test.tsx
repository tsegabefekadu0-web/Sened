import { render, screen, waitFor, within } from "@testing-library/react";
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

import DrawPage from "@/app/draw/page";
import { LiveDraw } from "@/components/draw/LiveDraw";
import { drawErrorKey, readDraft, readSeal, sealForDraw, sealLine, openingLine } from "@/lib/draw/clientDraw";
import { sealMemberContribution } from "@/lib/draw/engine";
import { DRAW_ERROR_CODES } from "@/lib/draw/types";
import { InMemoryDrawRepository } from "@/lib/draw/repository";
import { nodeDrawHasher } from "@/lib/draw/nodeHasher";
import {
  createCommitHandler,
  createPayoutHandler,
  createRevealHandler,
  createVerifyHandler
} from "@/lib/draw/routeHandlers";
import { DrawService } from "@/lib/draw/service";
import { dictionaries, translate } from "@/lib/i18n";
import { InMemoryLedgerRepository, LedgerService } from "@/lib/ledger";

const GROUP = "22222222-2222-4222-8222-222222222222";
const TENANT = "99999999-9999-4999-8999-999999999999";
const CYCLE = "77777777-7777-4777-8777-777777777777";
const TREASURER = "11111111-1111-4111-8111-111111111111";
const MEMBER_B = "33333333-3333-4333-8333-333333333333";
const MEMBER_C = "55555555-5555-4555-8555-555555555555";
const CASH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function tokenFor(userId: string): string {
  return `h.${btoa(JSON.stringify({ sub: userId }))}.s`;
}

type Role = "owner" | "treasurer" | "member";
type Override = (url: string, init: RequestInit) => Response | Promise<Response> | null;
type Tamper = (path: string, body: Record<string, unknown>) => Record<string, unknown>;

/**
 * A fake server that is the real one: the real route handlers over the real
 * `DrawService`, with in-memory draw and ledger repositories. Only the network
 * and the Supabase session are replaced, so what the browser verifies is what a
 * real server would have published.
 */
function createServer(role: Role, opts: { override?: Override; tamper?: Tamper; groups?: number } = {}) {
  const ledger = new InMemoryLedgerRepository({
    groups: [{ id: GROUP, tenantId: TENANT, members: [{ userId: TREASURER, role: "treasurer" }] }],
    accounts: [
      { id: CASH, groupId: GROUP, code: "POT_CASH", name: "Pot cash", type: "asset" },
      { id: EXPENSE, groupId: GROUP, code: "PAYOUT_EXPENSE", name: "Payout", type: "expense" }
    ],
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  const service = new DrawService(new InMemoryDrawRepository(), new LedgerService(ledger), {
    hasher: nodeDrawHasher,
    clock: () => new Date("2026-10-01T10:00:00.000Z")
  });
  const handlers: Record<string, (request: Request) => Promise<Response>> = {
    "/api/draw/commits": createCommitHandler(() => service),
    "/api/draw/reveals": createRevealHandler(() => service),
    "/api/draw/verify": createVerifyHandler(() => service),
    "/api/draw/payouts": createPayoutHandler(() => service)
  };
  const calls: string[] = [];

  const members = [
    { userId: TREASURER, role: role === "member" ? "owner" : role, joinedAt: "2026-09-01T00:00:00Z", email: "treasurer@example.test" },
    { userId: MEMBER_B, role: "member", joinedAt: "2026-09-02T00:00:00Z", email: null },
    { userId: MEMBER_C, role: "member", joinedAt: "2026-09-03T00:00:00Z", email: null }
  ];

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const overridden = opts.override?.(url, init);
    if (overridden) return overridden;
    if (path === "/api/my-groups") {
      const one = {
        groupId: GROUP,
        role,
        accounts: [
          { id: CASH, code: "POT_CASH" },
          { id: EXPENSE, code: "PAYOUT_EXPENSE" }
        ]
      };
      return Response.json({ groups: opts.groups === 0 ? [] : opts.groups === 2 ? [one, { ...one, groupId: TENANT }] : [one] });
    }
    if (path === "/api/ledger/members") return Response.json({ members });
    const handler = handlers[path];
    if (!handler) return new Response("{}", { status: 404 });
    const headers = new Headers(init.headers);
    const response = await handler(new Request(`http://localhost${path}`, { method: "POST", headers, body: init.body as string }));
    if (!opts.tamper || !response.ok) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json(opts.tamper(path, body), { status: response.status });
  }) as typeof fetch;

  return { service, calls, fetchImpl, members };
}

function deps(server: ReturnType<typeof createServer>, userId: string = TREASURER) {
  hoisted.userId = userId;
  return { getToken: async () => tokenFor(userId), fetchImpl: server.fetchImpl };
}

function renderLive(server: ReturnType<typeof createServer>, userId: string = TREASURER, locale: "en" | "am" = "en") {
  return render(<LiveDraw locale={locale} accessToken={tokenFor(userId)} deps={deps(server, userId)} />);
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

/** What another member's phone produces for a draw, independent of this UI. */
async function memberSeal(drawId: string, memberId: string) {
  return sealForDraw(drawId, memberId);
}

/** Drive the treasurer through open → commit with one other member's seal. */
async function openAndCommit(
  user: ReturnType<typeof userEvent.setup>,
  server: ReturnType<typeof createServer>,
  options: { readonly expectRevealForm?: boolean } = {}
) {
  await screen.findByTestId("draw-live");
  await user.click(screen.getByRole("button", { name: "Create a new draw ID" }));
  const drawId = readDraft(GROUP)!.drawId;
  const seal = await memberSeal(drawId, MEMBER_B);

  await user.type(screen.getByLabelText("Cycle ID"), CYCLE);
  await user.clear(screen.getByLabelText("Rounds in the cycle"));
  await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
  await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
  expect(screen.getByTestId("pot-preview")).toHaveTextContent("Br 3,000.00 = 3 members × Br 1,000.00");
  await user.click(screen.getByLabelText("Sealed lines from members, one per line (member-id:hash)"));
  await user.paste(sealLine(seal));
  await user.click(screen.getByRole("button", { name: "Commit the draw" }));
  if (options.expectRevealForm !== false) await screen.findByTestId("reveal-form");
  await waitFor(() => expect(server.calls).toContain("POST /api/draw/commits"));
  return { drawId, seal };
}

describe("signed in: the real flow through /api/draw/*", () => {
  it("runs commit, reveal, browser verification and a confirmed payout, in that order", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer");
    renderLive(server);

    const { drawId, seal } = await openAndCommit(user, server);

    // Step 2: reveal with the member's opening.
    await user.click(screen.getByLabelText("Openings from members, one per line (member-id:secret)"));
    await user.paste(openingLine(seal));
    await user.click(screen.getByRole("button", { name: "Reveal and draw" }));

    // Verification: recomputed on this device, then compared with the server.
    await screen.findByTestId("compare-result");
    expect(screen.getByTestId("compare-result")).toHaveTextContent("This device and the server agree.");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Verified");
    expect(screen.getByTestId("verdict-server")).toHaveTextContent("Verified");

    // Step 4 is offered, with amount and both canonical accounts visible, and
    // nothing is posted until the box is ticked.
    const payoutButton = await screen.findByRole("button", { name: "Post payout to the ledger" });
    expect(screen.getByTestId("payout-amount")).toHaveTextContent("Br 2,000.10");
    expect(screen.getByTestId("payout-debit")).toHaveTextContent(`PAYOUT_EXPENSE ${EXPENSE}`);
    expect(screen.getByTestId("payout-credit")).toHaveTextContent(`POT_CASH ${CASH}`);
    expect(payoutButton).toBeDisabled();
    await user.click(payoutButton);
    expect(server.calls).not.toContain("POST /api/draw/payouts");

    await user.click(screen.getByRole("checkbox", { name: /I confirm this payout/ }));
    expect(payoutButton).toBeEnabled();
    await user.click(payoutButton);

    await waitFor(() => expect(screen.getByTestId("payout-done")).toHaveTextContent("ledger entry #"));
    expect(server.calls.filter((call) => call === "POST /api/draw/payouts")).toHaveLength(1);
    expect(server.calls.filter((call) => call.startsWith("POST /api/draw")).slice(0, 3)).toEqual([
      "POST /api/draw/commits",
      "POST /api/draw/verify",
      "POST /api/draw/reveals"
    ]);

    // The payout really is in the ledger, for the amount that was on screen.
    const round = await server.service.getRound(drawId, { userId: TREASURER });
    expect(round.state).toBe("paid");
    expect(round.payout?.amount).toBe("2000.10");
  });

  it("refuses to commit with no sealed contribution from anyone but the treasurer", async () => {
    const user = userEvent.setup();
    const server = createServer("owner");
    renderLive(server);
    await screen.findByTestId("draw-live");
    await user.click(screen.getByRole("button", { name: "Create a new draw ID" }));
    const drawId = readDraft(GROUP)!.drawId;
    const mine = await sealMemberContribution(
      { drawId, memberId: TREASURER, nonce: "treasurer-own-nonce-0123456789" },
      nodeDrawHasher
    );

    await user.type(screen.getByLabelText("Cycle ID"), CYCLE);
    await user.type(screen.getByLabelText("Rounds in the cycle"), "3");
    await user.type(screen.getByLabelText("Contribution per member (ETB)"), "1000");
    await user.click(screen.getByLabelText("Sealed lines from members, one per line (member-id:hash)"));
    await user.paste(sealLine(mine));
    await user.click(screen.getByRole("button", { name: "Commit the draw" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("At least one sealed line from a member other than you");
    expect(server.calls).not.toContain("POST /api/draw/commits");
  });

  it("lets a member seal on this device, but withholds the opening until the commitment is published", async () => {
    const user = userEvent.setup();
    const server = createServer("member");
    renderLive(server, MEMBER_B);
    await screen.findByTestId("draw-live");
    const drawId = "dddddddd-0000-4000-8000-000000000001";

    await user.type(screen.getByLabelText("Draw ID to seal against"), drawId);
    await user.click(screen.getByRole("button", { name: "Seal my contribution" }));

    const seal = await screen.findByTestId("my-seal");
    const lines = within(seal).getAllByRole("textbox") as HTMLInputElement[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.value).toMatch(new RegExp(`^${MEMBER_B}:[0-9a-f]{64}$`));
    // The nonce decides the winner (protocol v3). Until the treasurer's commitment
    // is public it must not even be in the page, or a screenshot/copy leaks the one
    // input the treasurer cannot grind over.
    expect(within(seal).getByTestId("opening-locked")).toHaveTextContent("Do not share your opening yet");
    expect(within(seal).queryByTestId("opening-released")).toBeNull();
    const stored = readSeal(drawId)!;
    expect(seal.textContent ?? "").not.toContain(stored.nonce);
    // Sealing is local: nothing was sent to a draw route.
    expect(server.calls.some((call) => call.startsWith("POST /api/draw"))).toBe(false);
  });

  it("releases the opening only once the published commitment contains this member's seal", async () => {
    const user = userEvent.setup();
    const server = createServer("member");
    renderLive(server, MEMBER_B);
    await screen.findByTestId("draw-live");
    const drawId = "dddddddd-0000-4000-8000-000000000002";

    await user.type(screen.getByLabelText("Draw ID to seal against"), drawId);
    await user.click(screen.getByRole("button", { name: "Seal my contribution" }));
    const seal = await screen.findByTestId("my-seal");
    const mine = readSeal(drawId)!;

    // Asking before the treasurer has committed is an expected "not yet", not an alarm.
    await user.click(within(seal).getByRole("button", { name: "Check whether the treasurer has committed" }));
    expect(await within(seal).findByText("No commitment is published for this draw yet. Keep your opening private.")).toBeTruthy();
    expect(within(seal).queryByTestId("opening-released")).toBeNull();

    // The treasurer commits with a DIFFERENT member's seal, not this member's.
    const other = await sealMemberContribution({ drawId, memberId: MEMBER_C, nonce: "member-c-nonce-0123456789" }, nodeDrawHasher);
    const commitInput = {
      groupId: GROUP,
      cycleId: CYCLE,
      round: 1,
      totalRounds: 3,
      drawId,
      potAmount: "3000.00",
      reserveRatioBps: 1000,
      members: server.members.map((entry) => ({ memberId: entry.userId, displayName: entry.userId, status: "active" as const, contributionAmount: "1000.00" })),
      priorWinnerIds: [],
      idempotencyKey: `draw-commit.${drawId}`
    };
    await server.service.commit({ ...commitInput, memberCommitments: [other] }, { userId: TREASURER });
    await user.click(within(seal).getByRole("button", { name: "Check whether the treasurer has committed" }));
    expect(await within(seal).findByText(/your sealed line is not in it/)).toBeTruthy();
    expect(within(seal).queryByTestId("opening-released")).toBeNull();
    expect(seal.textContent ?? "").not.toContain(mine.nonce);
  });

  it("shows the opening line after the commitment that contains this member's seal is published", async () => {
    const user = userEvent.setup();
    const server = createServer("member");
    renderLive(server, MEMBER_B);
    await screen.findByTestId("draw-live");
    const drawId = "dddddddd-0000-4000-8000-000000000003";

    await user.type(screen.getByLabelText("Draw ID to seal against"), drawId);
    await user.click(screen.getByRole("button", { name: "Seal my contribution" }));
    const seal = await screen.findByTestId("my-seal");
    const mine = readSeal(drawId)!;

    await server.service.commit(
      {
        groupId: GROUP,
        cycleId: CYCLE,
        round: 1,
        totalRounds: 3,
        drawId,
        potAmount: "3000.00",
        reserveRatioBps: 1000,
        members: server.members.map((entry) => ({ memberId: entry.userId, displayName: entry.userId, status: "active" as const, contributionAmount: "1000.00" })),
        priorWinnerIds: [],
        idempotencyKey: `draw-commit.${drawId}`,
        memberCommitments: [{ memberId: MEMBER_B, sealed: mine.sealed }]
      },
      { userId: TREASURER }
    );

    await user.click(within(seal).getByRole("button", { name: "Check whether the treasurer has committed" }));
    const released = await within(seal).findByTestId("opening-released");
    const boxes = within(released).getAllByRole("textbox") as HTMLInputElement[];
    expect(boxes[0]!.value).toBe(openingLine(mine));
    expect(within(seal).queryByTestId("opening-locked")).toBeNull();
  });
});

describe("roles", () => {
  it("a plain member sees the seal and verify cards but none of the treasurer steps", async () => {
    const server = createServer("member");
    renderLive(server, MEMBER_B);
    await screen.findByTestId("draw-live");

    expect(document.querySelector('[data-draw-panel="seal"]')).not.toBeNull();
    expect(document.querySelector('[data-draw-panel="verify-live"]')).not.toBeNull();
    expect(document.querySelector('[data-draw-panel="treasurer"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Create a new draw ID" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit the draw" })).toBeNull();
    expect(screen.getByText(/Only the owner or treasurer can commit, reveal or pay/)).toBeInTheDocument();
  });

  it("shows the server's refusal when a non-treasurer slips past the UI", async () => {
    const user = userEvent.setup();
    const server = createServer("treasurer", {
      override: (url) =>
        url.startsWith("/api/draw/commits")
          ? Response.json({ error: "forbidden", message: "draw_forbidden" }, { status: 403 })
          : null
    });
    renderLive(server);
    await openAndCommit(user, server, { expectRevealForm: false });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only the owner or treasurer of the group can do this.");
    expect(alert).toHaveTextContent("draw_forbidden");
  });

  it("refuses with a message on no group and on several groups", async () => {
    const none = createServer("owner", { groups: 0 });
    const { unmount } = renderLive(none);
    expect(await screen.findByTestId("draw-live-refusal")).toHaveTextContent("You are not in a group yet");
    unmount();

    const many = createServer("owner", { groups: 2 });
    renderLive(many);
    expect(await screen.findByTestId("draw-live-refusal")).toHaveTextContent("more than one group");
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
    renderLive(server);
    const { seal } = await openAndCommit(user, server);

    await user.click(screen.getByLabelText("Openings from members, one per line (member-id:secret)"));
    await user.paste(openingLine(seal));
    await user.click(screen.getByRole("button", { name: "Reveal and draw" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A member's opening does not match what they sealed");
    expect(alert).toHaveTextContent("nonce does not open");
    expect(screen.queryByTestId("compare-result")).toBeNull();
  });

  it("catches a wrong opening before anything is sent", async () => {
    const user = userEvent.setup();
    const server = createServer("owner");
    renderLive(server);
    await openAndCommit(user, server);

    await user.click(screen.getByLabelText("Openings from members, one per line (member-id:secret)"));
    await user.paste(`${MEMBER_B}:not-what-was-sealed-0123456789`);
    await user.click(screen.getByRole("button", { name: "Reveal and draw" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("do not match what was sealed");
    expect(server.calls).not.toContain("POST /api/draw/reveals");
  });
});

/** A revealed draw created directly on the server, for the verification tests. */
async function revealedDraw(server: ReturnType<typeof createServer>) {
  const drawId = "dddddddd-0000-4000-8000-0000000000aa";
  const nonce = "member-b-nonce-0123456789-abc";
  const sealed = await sealMemberContribution({ drawId, memberId: MEMBER_B, nonce }, nodeDrawHasher);
  const context = { userId: TREASURER };
  await server.service.commit(
    {
      groupId: GROUP,
      cycleId: CYCLE,
      round: 1,
      totalRounds: 3,
      drawId,
      commitmentNonce: "commitment-nonce-0123456789",
      seed: "treasurer-seed-0123456789-xyz",
      memberCommitments: [sealed],
      potAmount: "3000.00",
      reserveRatioBps: 1000,
      members: server.members.map((entry) => ({
        memberId: entry.userId,
        displayName: entry.email ?? entry.userId,
        status: "active" as const,
        contributionAmount: "1000.00"
      })),
      priorWinnerIds: [],
      idempotencyKey: "draw-commit.aa"
    },
    context
  );
  await server.service.reveal(
    { drawId, seed: "treasurer-seed-0123456789-xyz", memberNonces: [{ memberId: MEMBER_B, nonce }] },
    context
  );
  return drawId;
}

async function verifyDrawIdInUi(user: ReturnType<typeof userEvent.setup>, drawId: string) {
  await screen.findByTestId("draw-live");
  await user.type(screen.getByLabelText("Draw ID to verify"), drawId);
  await user.click(screen.getByRole("button", { name: "Verify on this device" }));
}

describe("verification happens in the browser", () => {
  it("any member sees this device and the server agree on an honest draw", async () => {
    const user = userEvent.setup();
    const server = createServer("member");
    const drawId = await revealedDraw(server);
    renderLive(server, MEMBER_C);

    await verifyDrawIdInUi(user, drawId);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("agree");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Verified");
    // A plain member is never offered the payout.
    expect(document.querySelector('[data-draw-panel="payout"]')).toBeNull();
  });

  it("catches a server that names a different winner than the published values produce", async () => {
    const user = userEvent.setup();
    const server = createServer("owner", {
      tamper: (path, body) => {
        if (path !== "/api/draw/verify") return body;
        const round = body.round as Record<string, unknown>;
        const honest = round.winnerMemberId as string;
        const other = server.members.find((entry) => entry.userId !== honest)!.userId;
        return { ...body, round: { ...round, winnerMemberId: other } };
      }
    });
    const drawId = await revealedDraw(server);
    renderLive(server);

    await verifyDrawIdInUi(user, drawId);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("DISAGREE");
    expect(screen.getByText(/winner the server recorded is not the winner/)).toBeInTheDocument();
    // The recomputation, not the server, decides: payout is withheld.
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post payout to the ledger" })).toBeNull();
    expect(server.calls).not.toContain("POST /api/draw/payouts");
  });

  it("catches a forged seed even when the server still claims the draw verified", async () => {
    const user = userEvent.setup();
    const server = createServer("owner", {
      tamper: (path, body) => {
        if (path !== "/api/draw/verify") return body;
        const transcript = body.transcript as Record<string, unknown>;
        return { ...body, transcript: { ...transcript, seed: "a-different-seed-0123456789-zzz" } };
      }
    });
    const drawId = await revealedDraw(server);
    renderLive(server);

    await verifyDrawIdInUi(user, drawId);

    expect(await screen.findByTestId("compare-result")).toHaveTextContent("DISAGREE");
    expect(screen.getByTestId("verdict-device")).toHaveTextContent("Does not verify");
    expect(screen.getByTestId("verdict-server")).toHaveTextContent("Verified");
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
  });

  it("catches a member nonce that does not open what was sealed", async () => {
    const user = userEvent.setup();
    const server = createServer("owner", {
      tamper: (path, body) =>
        path === "/api/draw/verify"
          ? { ...body, memberNonces: [{ memberId: MEMBER_B, nonce: "forged-nonce-0123456789-abcdef" }] }
          : body
    });
    const drawId = await revealedDraw(server);
    renderLive(server);

    await verifyDrawIdInUi(user, drawId);

    expect(await screen.findByTestId("verdict-device")).toHaveTextContent("Does not verify");
    expect(screen.getByTestId("payout-blocked")).toBeInTheDocument();
  });
});

describe("signed out", () => {
  it("keeps the on-device demo, labelled as a demo in both languages, and calls no draw API", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      hoisted.session = { status: "signed-out" };
      const user = userEvent.setup();
      render(<DrawPage />);

      const banner = screen.getByTestId("draw-demo-banner");
      expect(banner).toHaveTextContent("ማሳያ");
      expect(banner).toHaveTextContent("ለቡድንዎ እውነተኛ እጣ ለማውጣት ይግቡ");

      await user.click(screen.getByRole("button", { name: "Switch to English" }));
      expect(screen.getByTestId("draw-demo-banner")).toHaveTextContent("DEMO");
      expect(screen.getByTestId("draw-demo-banner")).toHaveTextContent("Sign in to run a real draw for your group.");
      expect(screen.queryByTestId("draw-live")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Seal the commitment" }));
      await screen.findByRole("button", { name: "Reveal the seed" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says so when this build has no server", () => {
    hoisted.session = { status: "unconfigured" };
    render(<DrawPage />);
    expect(screen.getByTestId("draw-demo-banner")).toHaveTextContent("ይህ ስሪት ከአገልጋይ ጋር አልተገናኘም");
  });

  it("does not show the demo to a signed-in user", async () => {
    hoisted.session = { status: "signed-in", accessToken: tokenFor(TREASURER), email: "t@example.test" };
    render(<DrawPage />);
    expect(screen.queryByTestId("draw-demo-banner")).toBeNull();
    // No browser session in this test, so the live board refuses honestly.
    expect(await screen.findByTestId("draw-live-refusal")).toBeInTheDocument();
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
