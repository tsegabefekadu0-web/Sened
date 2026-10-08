import "server-only";

import { z } from "zod";

import { SCHOLARXIV_COLLECTION_ID, type CatalogueCitation, type CitationId } from "./citations";
import { GovernanceProviderError } from "./errors";

/**
 * M5.1 — ScholarXIV Papers API adapter. SERVER ONLY (it holds a credential).
 *
 * ## What is documented and what is assumed
 *
 * The ScholarXIV developer docs (`https://www.scholarxiv.com/developers`) could
 * not be fetched from the environment this was written in (the egress proxy
 * blocks the host), so this adapter is written against what a web search of
 * those docs surfaced, and nothing more. Be precise about the split:
 *
 * REPORTED BY THE DOCS (secondhand, via search snippets):
 * - API keys start with `sxv_`, and are sent as `Authorization: Bearer sxv_...`
 *   (an `x-api-key` header is also reported; we send Bearer only).
 * - The search endpoint is `POST /api/v1/papers/search`, taking a
 *   `searchFilterString` of field filters (e.g. `ti` for title), plus
 *   `maxResults`, `sortBy` and `sortOrder`. Paper data comes back under a
 *   top-level `data` property.
 *
 * ASSUMED (not confirmed against a live key or the full docs):
 * - That `searchFilterString` is an object of `{ field: text }` pairs. The
 *   reported wording ("must contain at least one non-empty string value")
 *   suggests so; if it is really a single query string, `buildSearchBody` is
 *   the one place to change.
 * - That `data` is an array of paper objects, or an object holding that array
 *   under `papers`, `results` or `items`. All three are accepted.
 * - The paper field names. We do not trust any one: a paper is matched to a
 *   catalogue entry if its arXiv id appears in *any* string field of the paper
 *   object, or its `title` equals the catalogue title (case and punctuation
 *   insensitive).
 * - That there is no documented way to filter a search by collection id, so we
 *   do NOT send one. "Confirmed" therefore means "the paper is found by the
 *   ScholarXIV Papers search", NOT "the paper is a member of collection
 *   6aaf5269f7a1121dbd049897". The UI wording reflects that.
 *
 * Like `AddisAiSpeechToTextProvider` this client is inert until both
 * `SCHOLARXIV_API_URL` and `SCHOLARXIV_API_KEY` are set, and it never
 * fabricates a result: no key, a timeout, a 4xx/5xx or an unparseable body all
 * raise a named `GovernanceProviderError`.
 */

export const SCHOLARXIV_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 10;

export type CitationStatus = "confirmed" | "not_found";

export interface CitationConfirmation {
  readonly id: CitationId;
  readonly status: CitationStatus;
}

export interface CitationCheckResult {
  readonly provider: string;
  readonly collectionId: string;
  readonly confirmations: readonly CitationConfirmation[];
}

export interface ScholarXivProvider {
  readonly name: string;
  /** `false` => every call rejects with `PROVIDER_NOT_CONFIGURED`. */
  readonly isConfigured: boolean;
  confirmCitations(
    citations: readonly CatalogueCitation[],
    options?: { readonly signal?: AbortSignal }
  ): Promise<CitationCheckResult>;
}

export class UnconfiguredScholarXivProvider implements ScholarXivProvider {
  readonly name = "unconfigured-scholarxiv";
  readonly isConfigured = false;

  async confirmCitations(): Promise<CitationCheckResult> {
    throw new GovernanceProviderError(
      "PROVIDER_NOT_CONFIGURED",
      this.name,
      "ScholarXIV is not configured. Set SCHOLARXIV_API_URL and SCHOLARXIV_API_KEY to confirm citations."
    );
  }
}

const paperRecordSchema = z.record(z.unknown());
const searchResponseSchema = z
  .object({
    data: z.union([
      z.array(paperRecordSchema),
      z.object({ papers: z.array(paperRecordSchema) }).passthrough(),
      z.object({ results: z.array(paperRecordSchema) }).passthrough(),
      z.object({ items: z.array(paperRecordSchema) }).passthrough()
    ])
  })
  .passthrough();

function papersOf(body: z.infer<typeof searchResponseSchema>): readonly Record<string, unknown>[] {
  const data = body.data;
  if (Array.isArray(data)) {
    return data;
  }
  const holder = data as Record<string, unknown>;
  for (const key of ["papers", "results", "items"]) {
    const value = holder[key];
    if (Array.isArray(value)) {
      return value as Record<string, unknown>[];
    }
  }
  return [];
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Does `paper` look like `citation`? See the matching assumptions above. */
export function paperMatchesCitation(paper: Record<string, unknown>, citation: CatalogueCitation): boolean {
  const strings = Object.values(paper).filter((value): value is string => typeof value === "string");
  if (citation.arxivId !== null) {
    const escaped = citation.arxivId.replace(".", "\\.");
    const pattern = new RegExp(`(?<![\\d.])${escaped}(?:v\\d+)?(?![\\d])`);
    if (strings.some((value) => pattern.test(value))) {
      return true;
    }
  }
  const title = paper.title;
  return typeof title === "string" && normalizeTitle(title) === normalizeTitle(citation.title);
}

/** The one place the request shape lives. See "ASSUMED" above. */
export function buildSearchBody(citation: CatalogueCitation): Record<string, unknown> {
  return {
    searchFilterString: { ti: citation.title },
    maxResults: MAX_RESULTS,
    sortBy: "relevance",
    sortOrder: "descending"
  };
}

function isAcceptableEndpoint(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // The key travels as a Bearer token; never send it over cleartext.
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return null;
  }
  return url;
}

export class ScholarXivPapersProvider implements ScholarXivProvider {
  readonly name = "scholarxiv-papers";
  readonly isConfigured = true;
  private readonly searchUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.searchUrl = `${config.baseUrl.replace(/\/+$/, "")}/papers/search`;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? SCHOLARXIV_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /** Build from the environment, or `null` when it is not (validly) configured. */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    fetchImpl?: typeof fetch
  ): ScholarXivPapersProvider | null {
    const baseUrl = env.SCHOLARXIV_API_URL?.trim();
    const apiKey = env.SCHOLARXIV_API_KEY?.trim();
    if (!baseUrl || !apiKey || isAcceptableEndpoint(baseUrl) === null) {
      return null;
    }
    const timeout = Number(env.SCHOLARXIV_TIMEOUT_MS);
    return new ScholarXivPapersProvider({
      baseUrl,
      apiKey,
      timeoutMs: Number.isFinite(timeout) && timeout >= 500 && timeout <= 30_000 ? timeout : undefined,
      fetchImpl
    });
  }

  async confirmCitations(
    citations: readonly CatalogueCitation[],
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<CitationCheckResult> {
    const confirmations = await Promise.all(
      citations.map(async (citation): Promise<CitationConfirmation> => {
        const papers = await this.search(citation, options.signal);
        return {
          id: citation.id,
          status: papers.some((paper) => paperMatchesCitation(paper, citation)) ? "confirmed" : "not_found"
        };
      })
    );
    return { provider: this.name, collectionId: SCHOLARXIV_COLLECTION_ID, confirmations };
  }

  private async search(
    citation: CatalogueCitation,
    outerSignal?: AbortSignal
  ): Promise<readonly Record<string, unknown>[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    outerSignal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(this.searchUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(buildSearchBody(citation)),
        signal: controller.signal,
        cache: "no-store"
      });
    } catch {
      throw new GovernanceProviderError(
        outerSignal?.aborted ? "PROVIDER_UNAVAILABLE" : "PROVIDER_TIMEOUT",
        this.name,
        "ScholarXIV did not respond."
      );
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      throw new GovernanceProviderError(
        "PROVIDER_RATE_LIMITED",
        this.name,
        "ScholarXIV is rate limited.",
        Number.isFinite(retryAfter) ? retryAfter : 1
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new GovernanceProviderError(
        "PROVIDER_UNAUTHORIZED",
        this.name,
        "ScholarXIV rejected the configured API key."
      );
    }
    if (!response.ok) {
      throw new GovernanceProviderError(
        "PROVIDER_UNAVAILABLE",
        this.name,
        `ScholarXIV returned HTTP ${response.status}.`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GovernanceProviderError("PROVIDER_REJECTED", this.name, "ScholarXIV returned a malformed body.");
    }
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GovernanceProviderError(
        "PROVIDER_REJECTED",
        this.name,
        "ScholarXIV returned a body that does not match the expected shape."
      );
    }
    return papersOf(parsed.data);
  }
}

/** The fail-closed default, returned whenever ScholarXIV is not configured. */
export function createScholarXivProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): ScholarXivProvider {
  return ScholarXivPapersProvider.fromEnv(env, fetchImpl) ?? new UnconfiguredScholarXivProvider();
}

export function isScholarXivConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return ScholarXivPapersProvider.fromEnv(env) !== null;
}
