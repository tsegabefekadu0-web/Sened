import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  readMyGroup: vi.fn(),
  listCycles: vi.fn(),
  readCycle: vi.fn(),
  readContributions: vi.fn(),
  readSession: vi.fn(),
  loadHomeLedger: vi.fn()
}));

vi.mock("@/lib/ledger/clientRead", () => ({ readMyGroup: hoisted.readMyGroup }));
vi.mock("@/lib/ledger/clientHome", () => ({ loadHomeLedger: hoisted.loadHomeLedger }));
vi.mock("@/lib/draw/clientDraw", async () => {
  const actual = await vi.importActual<typeof import("@/lib/draw/clientDraw")>("@/lib/draw/clientDraw");
  return {
    ...actual,
    listCycles: hoisted.listCycles,
    readCycle: hoisted.readCycle,
    readContributions: hoisted.readContributions,
    readSession: hoisted.readSession
  };
});

import {
  NAVIGATION_ALLOWLIST,
  NEVER_EXPOSED_WORDS,
  createCapabilities,
  type CapabilityDeps
} from "@/lib/voice/capabilities";

const USER = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const CYCLE = "33333333-3333-4333-8333-333333333333";

function token(sub: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.sig`;
}

function setup(overrides: Partial<CapabilityDeps> = {}, signedIn = true) {
  const mocks = {
    setLocale: vi.fn<(locale: "en" | "am") => void>(),
    navigate: vi.fn<(path: string) => void>(),
    openDigest: vi.fn<() => boolean>(() => true),
    openDraft: vi.fn<(utterance: string) => boolean>(() => true)
  };
  const deps = {
    ...mocks,
    getToken: async () => (signedIn ? token(USER) : null),
    getActiveGroupId: () => GROUP,
    getRoute: () => "/",
    getLocale: () => "am" as const,
    readPending: async () => ({ waiting: 2, blocked: 0, rejected: 0, spokenNotes: 1, oldestPendingAt: null }),
    screenDelayMs: 0,
    ...overrides
  } satisfies CapabilityDeps;
  const capabilities = createCapabilities(deps);
  const byName = (name: string) => {
    const found = capabilities.find((capability) => capability.name === name);
    if (!found) throw new Error(`no capability ${name}`);
    return found;
  };
  return { deps: { ...deps, ...mocks }, capabilities, byName };
}

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset();
  hoisted.readMyGroup.mockResolvedValue({ status: "ok", groupId: GROUP, groupName: "Bole Equb", role: "member", accounts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("voice capabilities: the allowlist", () => {
  it("exposes exactly the intended capabilities, and only the draft is dangerous", () => {
    const { capabilities } = setup();
    expect(capabilities.map((capability) => capability.name)).toEqual([
      "getContributionStatus",
      "whoIsNextInDraw",
      "listPendingItems",
      "readAudioDigest",
      "navigateTo",
      "switchLanguage",
      "draftContribution"
    ]);
    expect(capabilities.filter((capability) => capability.dangerous).map((capability) => capability.name)).toEqual([
      "draftContribution"
    ]);
  });

  it("has no capability whose name or description offers to verify, credit, pay out, draw or change roles", () => {
    const { capabilities } = setup();
    for (const capability of capabilities) {
      for (const word of NEVER_EXPOSED_WORDS) {
        expect(capability.name.toLowerCase(), `${capability.name} contains "${word}"`).not.toContain(word);
      }
      // The descriptions may say what is NOT done ("records nothing"), but never describe a mutation.
      expect(capability.description).not.toMatch(/\b(approve|verify the payment|credit the ledger|pay out|reveal the draw)\b/i);
    }
  });

  it("marks the free-text parameter of the draft as sensitive", () => {
    const { byName } = setup();
    expect(byName("draftContribution").params.utterance?.sensitive).toBe(true);
  });
});

describe("voice capabilities: navigateTo", () => {
  it("opens real screens, by name or by path", async () => {
    const { byName, deps } = setup();
    expect(await byName("navigateTo").handler({ screen: "ledger" })).toMatchObject({ status: "ok" });
    expect(await byName("navigateTo").handler({ screen: "/draw" })).toMatchObject({ status: "ok" });
    expect(deps.navigate).toHaveBeenNthCalledWith(1, NAVIGATION_ALLOWLIST.ledger);
    expect(deps.navigate).toHaveBeenNthCalledWith(2, NAVIGATION_ALLOWLIST.draw);
  });

  it("REJECTS an unknown route, an API path, an external URL and a traversal", async () => {
    const { byName, deps } = setup();
    for (const screen of ["/api/ledger/entries", "https://evil.example", "//evil.example", "../admin", "admin", "ledger?x=1", "__proto__", "constructor", undefined, 7]) {
      const result = await byName("navigateTo").handler({ screen });
      expect(result.status, String(screen)).toBe("rejected");
    }
    expect(deps.navigate).not.toHaveBeenCalled();
  });
});

describe("voice capabilities: switchLanguage", () => {
  it("switches the screens to Amharic and points to the Amharic voice button", async () => {
    const { byName, deps } = setup();
    const result = await byName("switchLanguage").handler({ language: "am" });
    expect(deps.setLocale).toHaveBeenCalledWith("am");
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/Amharic voice button/);
  });

  it("switches to English, and REJECTS any other language", async () => {
    const { byName, deps } = setup();
    expect((await byName("switchLanguage").handler({ language: "en" })).status).toBe("ok");
    expect(deps.setLocale).toHaveBeenLastCalledWith("en");
    deps.setLocale.mockClear();
    expect((await byName("switchLanguage").handler({ language: "om" })).status).toBe("rejected");
    expect(deps.setLocale).not.toHaveBeenCalled();
  });
});

describe("voice capabilities: signed out", () => {
  it("asks the person to sign in and sends no request for the ledger reads", async () => {
    const { byName } = setup({}, false);
    hoisted.readMyGroup.mockResolvedValue({ status: "unauthorized" });
    for (const name of ["getContributionStatus", "whoIsNextInDraw"]) {
      expect((await byName(name).handler({})).status).toBe("sign_in_required");
    }
    expect(hoisted.readMyGroup).not.toHaveBeenCalled();
    expect(hoisted.listCycles).not.toHaveBeenCalled();
    expect(hoisted.readContributions).not.toHaveBeenCalled();
  });

  it("reads the pot balance for the digest only when signed in", async () => {
    const out = setup({}, false);
    const result = await out.byName("readAudioDigest").handler({});
    expect(hoisted.loadHomeLedger).not.toHaveBeenCalled();
    expect(result.potBalanceEtb).toBeNull();
    expect(out.deps.openDigest).toHaveBeenCalledTimes(1);
  });
});

describe("voice capabilities: reads", () => {
  it("reports the signed-in member's own contribution standing, and nothing about others", async () => {
    hoisted.listCycles.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{ cycleId: CYCLE, name: "Meskerem Equb", closedAt: null, createdAt: "2026-01-01T00:00:00Z" }]
    });
    hoisted.readContributions.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        contributionAmount: "500.00",
        nextRound: 3,
        members: [
          {
            memberId: USER,
            cells: [
              { round: 1, status: "met" },
              { round: 2, status: "flagged" },
              { round: 3, status: "not_due" }
            ]
          },
          { memberId: "someone-else", cells: [{ round: 1, status: "flagged" }] }
        ]
      }
    });
    const { byName } = setup();
    const result = await byName("getContributionStatus").handler({});
    expect(result).toMatchObject({ status: "ok", roundsMet: 1, roundsFlagged: 1, roundsNotYetDue: 1, currentRound: 3 });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("someone-else");
    expect(wire).not.toContain(USER);
    expect(wire).not.toContain("sig");
  });

  it("asks for a group choice instead of guessing", async () => {
    hoisted.readMyGroup.mockResolvedValue({ status: "choose-group" });
    const { byName } = setup();
    expect((await byName("whoIsNextInDraw").handler({})).status).toBe("choose_group");
  });

  it("describes the next draw without naming a winner", async () => {
    hoisted.listCycles.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{ cycleId: CYCLE, name: "Meskerem Equb", closedAt: null, createdAt: "2026-01-01T00:00:00Z" }]
    });
    hoisted.readCycle.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        cycle: { nextRound: 4, totalRounds: 10 },
        draws: [
          { drawId: "d1", round: 4, state: "sealing", openedAt: "2026-02-01T00:00:00Z", superseded: false, sealCount: 3, winnerMemberId: null }
        ],
        cancellations: []
      }
    });
    hoisted.readSession.mockResolvedValue({ ok: true, status: 200, data: { sealDeadline: "2026-02-03T00:00:00Z" } });
    const { byName } = setup();
    const result = await byName("whoIsNextInDraw").handler({});
    expect(result).toMatchObject({ status: "ok", nextRound: 4, drawState: "sealing", sealsIn: 3, sealingClosesAt: "2026-02-03T00:00:00Z" });
    expect(result.message).toMatch(/winner is not known/i);
  });

  it("lists pending items as counts only", async () => {
    const { byName } = setup();
    const result = await byName("listPendingItems").handler({});
    expect(result).toMatchObject({ status: "ok", waiting: 2, spokenNotes: 1 });
    expect(result.message).toMatch(/not recorded in the ledger/i);
  });
});

describe("voice capabilities: draftContribution never commits", () => {
  it("returns a provisional, unverified, unsubmitted draft and calls no network at all", async () => {
    const fetchImpl = vi.fn();
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    const { byName, deps } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await byName("draftContribution").handler({
      utterance: "I paid 5000 birr for Meskerem by Telebirr, reference 9BF42"
    });
    expect(result).toMatchObject({ status: "draft", provisional: true, verified: false, submitted: false });
    expect(result.amountEtb).toBe("5000.00");
    expect(result.message).toMatch(/not recorded and not verified/i);
    expect(deps.openDraft).toHaveBeenCalledWith("I paid 5000 birr for Meskerem by Telebirr, reference 9BF42");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(hoisted.readMyGroup).not.toHaveBeenCalled();
    expect(hoisted.loadHomeLedger).not.toHaveBeenCalled();
  });

  it("opens the draft on the home screen, navigating there first when elsewhere", async () => {
    vi.useFakeTimers();
    const { byName, deps } = setup({ getRoute: () => "/ledger" });
    await byName("draftContribution").handler({ utterance: "500 birr cash" });
    expect(deps.navigate).toHaveBeenCalledWith("/");
    expect(deps.openDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.openDraft).toHaveBeenCalledWith("500 birr cash");
  });

  it("asks what was paid when nothing was said, and truncates very long input", async () => {
    const { byName, deps } = setup();
    expect((await byName("draftContribution").handler({ utterance: "   " })).status).toBe("needs_input");
    await byName("draftContribution").handler({ utterance: "5000 ".repeat(500) });
    const sent = deps.openDraft.mock.calls[0]?.[0] as string;
    expect(sent.length).toBeLessThanOrEqual(600);
  });
});

describe("voice capabilities: failures stay quiet", () => {
  it("does not leak an error message that could carry a token or URL", async () => {
    hoisted.readMyGroup.mockRejectedValue(new Error("Bearer eyJsecret at https://internal.example"));
    const { byName } = setup();
    const result = await byName("getContributionStatus").handler({});
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(/secret|internal\.example|Bearer/);
  });
});
