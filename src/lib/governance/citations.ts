/**
 * The bundled citation catalogue.
 *
 * Static, curated, and built only from the six references listed in the
 * project README ("Key Research Grounding"). The arXiv ids and links are the
 * README's; nothing here is a quote. `finding` repeats the README's own
 * one-line description of each paper and goes no further: the engine's rules
 * are heuristics *informed by* this literature, and a citation chip means
 * "relevant reading", not "this paper proves this parameter".
 *
 * This file is safe for the browser. It performs no I/O.
 */

export const CITATION_IDS = [
  "abebe2022",
  "wang2021",
  "sowon2023",
  "kester2013",
  "dercon2006",
  "besley1993"
] as const;

export type CitationId = (typeof CITATION_IDS)[number];

export interface CatalogueCitation {
  readonly id: CitationId;
  /** Short chip label. */
  readonly label: string;
  readonly authors: string;
  readonly year: number;
  readonly title: string;
  readonly venue: string;
  /** arXiv identifier, or `null` for the two journal articles (README gives none). */
  readonly arxivId: string | null;
  /** `https://arxiv.org/abs/<id>`, or `null` when there is no arXiv entry. */
  readonly url: string | null;
}

export const CITATION_CATALOGUE: Readonly<Record<CitationId, CatalogueCitation>> = {
  abebe2022: {
    id: "abebe2022",
    label: "Abebe et al. 2022",
    authors: "Rediet Abebe et al.",
    year: 2022,
    title: "An Algorithmic Introduction to Savings Circles",
    venue: "AAAI 2022",
    arxivId: "2203.12486",
    url: "https://arxiv.org/abs/2203.12486"
  },
  wang2021: {
    id: "wang2021",
    label: "Wang 2021",
    authors: "Fan Wang",
    year: 2021,
    title: "An empirical equilibrium model of formal and informal credit markets in developing countries",
    venue: "arXiv preprint",
    arxivId: "2204.12374",
    url: "https://arxiv.org/abs/2204.12374"
  },
  sowon2023: {
    id: "sowon2023",
    label: "Sowon et al. 2023",
    authors: "Karen Sowon et al.",
    year: 2023,
    title: "The Role of User-Agent Interactions on Mobile Money Practices in Kenya and Tanzania",
    venue: "arXiv preprint",
    arxivId: "2309.00226",
    url: "https://arxiv.org/abs/2309.00226"
  },
  kester2013: {
    id: "kester2013",
    label: "Kester 2013",
    authors: "Quist-Aphetsi Kester",
    year: 2013,
    title: "The Role of Rural Banks in Providing Mobile Money Services to Rural Poor Communities",
    venue: "arXiv preprint",
    arxivId: "1307.7789",
    url: "https://arxiv.org/abs/1307.7789"
  },
  dercon2006: {
    id: "dercon2006",
    label: "Dercon et al. 2006",
    authors: "Stefan Dercon et al.",
    year: 2006,
    title: "In sickness and in health: Risk-sharing within Ethiopian funeral societies (Iddirs)",
    venue: "Journal of Development Economics",
    arxivId: null,
    url: null
  },
  besley1993: {
    id: "besley1993",
    label: "Besley, Coate & Loury 1993",
    authors: "Besley, Coate & Loury",
    year: 1993,
    title: "The Economics of Rotating Savings and Credit Associations",
    venue: "The American Economic Review",
    arxivId: null,
    url: null
  }
};

export function getCitation(id: CitationId): CatalogueCitation {
  return CITATION_CATALOGUE[id];
}

export function listCitations(): readonly CatalogueCitation[] {
  return CITATION_IDS.map((id) => CITATION_CATALOGUE[id]);
}

export function isCitationId(value: unknown): value is CitationId {
  return typeof value === "string" && (CITATION_IDS as readonly string[]).includes(value);
}

/** The ScholarXIV collection the README curates these papers in. */
export const SCHOLARXIV_COLLECTION_ID = "6aaf5269f7a1121dbd049897";
