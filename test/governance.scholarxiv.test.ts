import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { listCitations } from "@/lib/governance/citations";
import { GovernanceProviderError } from "@/lib/governance/errors";
import {
  ScholarXivPapersProvider,
  UnconfiguredScholarXivProvider,
  buildSearchBody,
  createScholarXivProvider,
  isScholarXivConfigured,
  paperMatchesCitation
} from "@/lib/governance/scholarxiv";

const catalogue = listCitations();
const env = { SCHOLARXIV_API_URL: "https://sx.example.test/api/v1/", SCHOLARXIV_API_KEY: "sxv_test" };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

/** A fake index: finds a paper for every catalogue entry by its arXiv id or title. */
function indexFetch(missing: readonly string[] = []) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { searchFilterString: { ti: string } };
    const hit = catalogue.find((entry) => entry.title === body.searchFilterString.ti);
    if (!hit || missing.includes(hit.id)) {
      return jsonResponse({ data: [{ id: "unrelated", title: "Something else", url: "https://arxiv.org/abs/1111.11111" }] });
    }
    return jsonResponse({
      data: [{ title: hit.title, url: hit.arxivId ? `https://arxiv.org/abs/${hit.arxivId}v2` : undefined }]
    });
  });
}

describe("configuration", () => {
  it("is inert without both variables", () => {
    expect(createScholarXivProvider({})).toBeInstanceOf(UnconfiguredScholarXivProvider);
    expect(createScholarXivProvider({ SCHOLARXIV_API_URL: env.SCHOLARXIV_API_URL })).toBeInstanceOf(
      UnconfiguredScholarXivProvider
    );
    expect(createScholarXivProvider({ SCHOLARXIV_API_KEY: "sxv_x" })).toBeInstanceOf(UnconfiguredScholarXivProvider);
    expect(isScholarXivConfigured({})).toBe(false);
  });

  it("is configured with both, and refuses a cleartext non-local URL", () => {
    expect(createScholarXivProvider(env)).toBeInstanceOf(ScholarXivPapersProvider);
    expect(isScholarXivConfigured(env)).toBe(true);
    expect(isScholarXivConfigured({ ...env, SCHOLARXIV_API_URL: "http://sx.example.test/api" })).toBe(false);
    expect(isScholarXivConfigured({ ...env, SCHOLARXIV_API_URL: "not a url" })).toBe(false);
    expect(isScholarXivConfigured({ ...env, SCHOLARXIV_API_URL: "http://localhost:4000/api" })).toBe(true);
  });

  it("rejects with PROVIDER_NOT_CONFIGURED rather than fabricating a result", async () => {
    const provider = createScholarXivProvider({});
    expect(provider.isConfigured).toBe(false);
    await expect(provider.confirmCitations(catalogue)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      status: 503
    });
  });
});

describe("confirmCitations", () => {
  it("sends a Bearer-authenticated POST to /papers/search and confirms every paper found", async () => {
    const fetchImpl = indexFetch();
    const provider = ScholarXivPapersProvider.fromEnv(env, fetchImpl as unknown as typeof fetch)!;
    const result = await provider.confirmCitations(catalogue);

    expect(result.confirmations.every((entry) => entry.status === "confirmed")).toBe(true);
    expect(result.confirmations).toHaveLength(6);
    expect(result.collectionId).toBe("6aaf5269f7a1121dbd049897");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sx.example.test/api/v1/papers/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sxv_test");
    expect(JSON.parse(String(init.body))).toEqual(buildSearchBody(catalogue[0]));
  });

  it("reports a paper that the search does not return as not_found, not confirmed", async () => {
    const provider = ScholarXivPapersProvider.fromEnv(env, indexFetch(["wang2021"]) as unknown as typeof fetch)!;
    const result = await provider.confirmCitations(catalogue);
    expect(result.confirmations.find((entry) => entry.id === "wang2021")?.status).toBe("not_found");
    expect(result.confirmations.find((entry) => entry.id === "abebe2022")?.status).toBe("confirmed");
  });

  it("accepts data wrapped under papers, results or items", async () => {
    for (const key of ["papers", "results", "items"]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ data: { [key]: [{ arxiv_id: "2203.12486", title: "x" }] } })
      );
      const provider = ScholarXivPapersProvider.fromEnv(env, fetchImpl as unknown as typeof fetch)!;
      const result = await provider.confirmCitations([catalogue[0]]);
      expect(result.confirmations[0].status).toBe("confirmed");
    }
  });

  it("times out", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const provider = new ScholarXivPapersProvider({
      baseUrl: "https://sx.example.test/api/v1",
      apiKey: "sxv_test",
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(provider.confirmCitations([catalogue[0]])).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      status: 504
    });
  });

  it("maps network failure to a timeout-class error, and a caller abort to unavailable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = ScholarXivPapersProvider.fromEnv(env, failing as unknown as typeof fetch)!;
    await expect(provider.confirmCitations([catalogue[0]])).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(provider.confirmCitations([catalogue[0]], { signal: controller.signal })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
  });

  it.each([
    [429, "PROVIDER_RATE_LIMITED", 429],
    [401, "PROVIDER_UNAUTHORIZED", 502],
    [403, "PROVIDER_UNAUTHORIZED", 502],
    [500, "PROVIDER_UNAVAILABLE", 502],
    [404, "PROVIDER_UNAVAILABLE", 502]
  ])("maps HTTP %i to %s", async (status, code, mapped) => {
    const fetchImpl = vi.fn(async () => new Response("no", { status, headers: { "retry-after": "7" } }));
    const provider = ScholarXivPapersProvider.fromEnv(env, fetchImpl as unknown as typeof fetch)!;
    const error = await provider.confirmCitations([catalogue[0]]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GovernanceProviderError);
    expect(error).toMatchObject({ code, status: mapped });
    if (status === 429) {
      expect((error as GovernanceProviderError).retryAfterSeconds).toBe(7);
    }
  });

  it("rejects a non-JSON body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const provider = ScholarXivPapersProvider.fromEnv(env, fetchImpl as unknown as typeof fetch)!;
    await expect(provider.confirmCitations([catalogue[0]])).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });

  it.each([
    ["no data property", { papers: [] }],
    ["data is a string", { data: "oops" }],
    ["papers are not objects", { data: [1, 2, 3] }],
    ["null body", null]
  ])("rejects a malformed response: %s", async (_name, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const provider = ScholarXivPapersProvider.fromEnv(env, fetchImpl as unknown as typeof fetch)!;
    await expect(provider.confirmCitations([catalogue[0]])).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
      status: 422
    });
  });
});

describe("paperMatchesCitation", () => {
  const abebe = catalogue.find((entry) => entry.id === "abebe2022")!;
  const dercon = catalogue.find((entry) => entry.id === "dercon2006")!;

  it("matches an arXiv id in any string field, including a versioned url", () => {
    expect(paperMatchesCitation({ link: "https://arxiv.org/pdf/2203.12486v3" }, abebe)).toBe(true);
    expect(paperMatchesCitation({ anything: "arXiv:2203.12486" }, abebe)).toBe(true);
  });

  it("does not match a longer or different id", () => {
    expect(paperMatchesCitation({ id: "12203.12486" }, abebe)).toBe(false);
    expect(paperMatchesCitation({ id: "2203.124861" }, abebe)).toBe(false);
    expect(paperMatchesCitation({ id: "2203x12486" }, abebe)).toBe(false);
  });

  it("falls back to a title match for papers with no arXiv id", () => {
    expect(paperMatchesCitation({ title: dercon.title.toUpperCase() }, dercon)).toBe(true);
    expect(paperMatchesCitation({ title: "Another paper" }, dercon)).toBe(false);
  });
});
