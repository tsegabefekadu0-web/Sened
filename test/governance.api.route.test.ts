import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mocks.getUser } }))
}));

import { listCitations } from "@/lib/governance/citations";
import { GovernanceProviderError } from "@/lib/governance/errors";
import { createCitationsHandler, createRecommendationsHandler } from "@/lib/governance/routeHandlers";
import type { ScholarXivProvider } from "@/lib/governance/scholarxiv";
import { UnconfiguredScholarXivProvider } from "@/lib/governance/scholarxiv";

const validEqub = {
  groupType: "equb",
  memberCount: 12,
  contributionAmount: "1000.00",
  cycleLengthDays: 30,
  trust: "mixed"
};

const validIddir = {
  groupType: "iddir",
  memberCount: 40,
  contributionAmount: "100.00",
  cycleLengthDays: 30,
  trust: "close",
  typicalClaimAmount: "20000.00",
  currentFundBalance: "0.00"
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/governance/recommendations", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...headers },
    body: raw
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/governance/recommendations", () => {
  const handler = createRecommendationsHandler();

  it("returns advisory recommendations with no-store and no session needed", async () => {
    const response = await handler(post(validEqub));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.citationSource).toBe("bundled");
    expect(body.recommendation.advisoryOnly).toBe(true);
    expect(body.recommendation.clauses.map((entry: { id: string }) => entry.id)).toEqual([
      "late.equb",
      "replacement.equb",
      "default.reserve"
    ]);
  });

  it("handles an iddir", async () => {
    const response = await handler(post(validIddir));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendation.clauses.map((entry: { id: string }) => entry.id)).toContain("emergency.fund");
  });

  it("rejects unknown fields (strict schema)", async () => {
    const response = await handler(post({ ...validEqub, groupId: "x" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", message: "Invalid fields: groupId" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["iddir without a claim", { ...validIddir, typicalClaimAmount: undefined }],
    ["equb with an iddir field", { ...validEqub, currentFundBalance: "0.00" }],
    ["one member", { ...validEqub, memberCount: 1 }],
    ["bad amount", { ...validEqub, contributionAmount: "12" }],
    ["zero amount", { ...validEqub, contributionAmount: "0.00" }],
    ["bad trust", { ...validEqub, trust: "none" }]
  ])("rejects %s", async (_name, body) => {
    const response = await handler(post(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
  });

  it("rejects a wrong content type, malformed JSON and an oversized body", async () => {
    const wrongType = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(validEqub)
    });
    expect((await handler(wrongType)).status).toBe(400);
    expect((await handler(post("{nope"))).status).toBe(400);
    const big = post({ ...validEqub, pad: "x".repeat(5_000) });
    const response = await handler(big);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("returns an engine rejection as invalid_request, not a 500", async () => {
    const response = await handler(post({ ...validEqub, contributionAmount: "99999999999.00" }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/too large/);
  });
});

function configuredProvider(overrides: Partial<ScholarXivProvider> = {}): ScholarXivProvider {
  return {
    name: "scholarxiv-papers",
    isConfigured: true,
    confirmCitations: vi.fn(async (citations: readonly { id: import("@/lib/governance/citations").CitationId }[]) => ({
      provider: "scholarxiv-papers",
      collectionId: "6aaf5269f7a1121dbd049897",
      confirmations: citations.map((citation) => ({ id: citation.id, status: "confirmed" as const }))
    })),
    ...overrides
  };
}

function get(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/governance/citations", { method: "GET", headers });
}

describe("GET /api/governance/citations", () => {
  it("serves the bundled catalogue without a session when ScholarXIV is not configured", async () => {
    const handler = createCitationsHandler(() => new UnconfiguredScholarXivProvider());
    const response = await handler(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.source).toBe("bundled");
    expect(body.scholarxivConfigured).toBe(false);
    expect(body.citations).toHaveLength(6);
    expect(body.confirmations).toBeUndefined();
  });

  it("requires a session when configured, and never calls the provider without one", async () => {
    const provider = configuredProvider();
    const handler = createCitationsHandler(() => provider);
    const response = await handler(get());
    expect(response.status).toBe(401);
    expect(provider.confirmCitations).not.toHaveBeenCalled();
  });

  it("rejects a bearer token that does not verify", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    const handler = createCitationsHandler(() => configuredProvider());
    expect((await handler(get({ authorization: "Bearer t" }))).status).toBe(401);
  });

  it("returns confirmations for a signed-in caller", async () => {
    const provider = configuredProvider();
    const handler = createCitationsHandler(() => provider);
    const response = await handler(get({ authorization: "Bearer t" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("scholarxiv");
    expect(body.collectionId).toBe("6aaf5269f7a1121dbd049897");
    expect(body.confirmations).toHaveLength(listCitations().length);
    expect(JSON.stringify(body)).not.toContain("sxv_");
  });

  it.each([
    ["PROVIDER_TIMEOUT", 504],
    ["PROVIDER_REJECTED", 422],
    ["PROVIDER_UNAUTHORIZED", 502]
  ] as const)("maps a %s failure to %i", async (code, status) => {
    const handler = createCitationsHandler(() =>
      configuredProvider({
        confirmCitations: vi.fn(async () => {
          throw new GovernanceProviderError(code, "scholarxiv-papers", "x");
        })
      })
    );
    const response = await handler(get({ authorization: "Bearer t" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code.toLowerCase(), provider: "scholarxiv-papers" });
  });

  it("sets Retry-After on a rate-limited provider", async () => {
    const handler = createCitationsHandler(() =>
      configuredProvider({
        confirmCitations: vi.fn(async () => {
          throw new GovernanceProviderError("PROVIDER_RATE_LIMITED", "scholarxiv-papers", "x", 9);
        })
      })
    );
    const response = await handler(get({ authorization: "Bearer t" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
  });

  it("turns an unexpected throw into a generic 502", async () => {
    const handler = createCitationsHandler(() =>
      configuredProvider({
        confirmCitations: vi.fn(async () => {
          throw new Error("boom");
        })
      })
    );
    const response = await handler(get({ authorization: "Bearer t" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "governance_provider_failed" });
  });
});
