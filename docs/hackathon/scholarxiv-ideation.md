# ScholarXIV ideation

How Sened's design was grounded in published research, and how the code uses ScholarXIV. Only sources already in this repository are cited (the bundled catalogue in `src/lib/governance/citations.ts`, the README, and `docs/IDEATION.md`). The one-line descriptions below are the catalogue's own wording; the code says a citation means "relevant reading", not "this paper proves this parameter".

Collection: [STARK Hackathon 2026 - Ideation & Research (GitGud)](https://www.scholarxiv.com/collections/6aaf5269f7a1121dbd049897?token=293b33f942e29f15a7bc9b4fd82b33bf88eb252a190ebbdb05c5ded00cf36896) (id `6aaf5269f7a1121dbd049897`).

## Problem

Equbs (rotating savings) and iddirs (mutual aid) circulate large sums on trust, and four things go wrong:

1. **Trust.** Who paid, who is late, and who got the pot is argued from memory or screenshots.
2. **Record-keeping.** Payments arrive as Telebirr, CBE or Awash screenshots in chat groups; the book is one treasurer's notebook, and a corrected number is indistinguishable from a changed one.
3. **Verification cost.** A screenshot proves nothing; the bank's own record does, but checking it by hand is slow.
4. **Literacy and access.** Treasurers and members who find typed forms hard are shut out of digital tools, so records stay informal.

## Research-grounded decisions

| Decision | Feature in the code | Source in the catalogue |
| --- | --- | --- |
| The pot draw is a commit-reveal lottery that anyone can re-run, with reserve retention and collateral/guarantors for early winners | `/draw`, `src/lib/draw`, collateral panel, `/api/draw/*` | Abebe et al. 2022, *An Algorithmic Introduction to Savings Circles* (AAAI 2022, arXiv:2203.12486): algorithmic mechanism design for ROSCAs, fair pot allocation, default minimization |
| Rules (late penalty, replacing a defaulter, default reserve) are advisory, tagged with the reading behind them | `/governance`, `src/lib/governance/engine.ts` (clauses `late.equb`, `late.iddir`, `replacement.equb`, `replacement.iddir`, `default.reserve`, `emergency.fund`) | Besley, Coate & Loury 1993, *The Economics of Rotating Savings and Credit Associations* (AER): ROSCA efficiency and social enforcement |
| Iddir clauses lean on social enforcement and transparent records | `late.iddir`, `replacement.iddir`, `emergency.fund` | Dercon et al. 2006, *In sickness and in health: Risk-sharing within Ethiopian funeral societies (Iddirs)* (J. Development Economics): informal risk-sharing resilience in Ethiopia |
| Do not replace the equb with a bank; give it bank-grade verification of receipts | Links.et receipt check, `PENDING_RECONCILIATION` queue, ledger that never marks unverified entries as verified | Wang 2021 (arXiv:2204.12374): formal and informal credit coexist when verification costs are addressed |
| Spoken input and spoken digests, with confirmation, for users uncomfortable with typing | `/voice`, Voxide widget, Addis AI Amharic STT/TTS | Sowon et al. 2023 (arXiv:2309.00226): conversational trust and audio interaction in East African mobile money |
| Bridge grassroots groups to mobile-money and bank infrastructure | Telebirr/CBE/Awash providers through Links.et | Kester 2013 (arXiv:1307.7789): integration models bridging grassroots finance and formal mobile money |

Which papers back which rule is the code's own mapping (`citations` arrays in `engine.ts`): `late` rules cite Besley (and Dercon for iddirs, Abebe for equbs); replacement cites Abebe, Besley and Wang (equb) or Dercon and Wang (iddir); default reserve cites Abebe and Besley; emergency fund cites Dercon.

Design choices that come from the problem rather than a paper: an append-only hash-chained ledger (corrections are reversals), speech treated as provisional, offline-first writes with an outbox, and an Amharic/English interface using the Ethiopian calendar.

## How the code uses ScholarXIV

- **Catalogue (`src/lib/governance/citations.ts`).** Six references, built only from the README list, with arXiv ids for four and none for the two journal articles. `SCHOLARXIV_COLLECTION_ID` records the collection. Browser-safe; no I/O.
- **Adapter (`src/lib/governance/scholarxiv.ts`, server only).** `ScholarXivPapersProvider` calls `POST <SCHOLARXIV_API_URL>/papers/search` with `Authorization: Bearer <SCHOLARXIV_API_KEY>`, one title search per catalogue paper, and marks each `confirmed` or `not_found`. A paper matches if its arXiv id appears in any string field or its title matches (case and punctuation insensitive).
- **Fail closed.** With no URL or key, `createScholarXivProvider` returns an unconfigured provider that throws `PROVIDER_NOT_CONFIGURED`; timeouts, 401/403, 429, other HTTP errors and malformed bodies each raise a named `GovernanceProviderError`. The key is only sent over https (http for localhost) and never reaches the browser.
- **Honest wording.** The adapter's header records what is documented and what is assumed: the request shape (`searchFilterString: { ti: title }`) and the response shape were written from search snippets of the developer docs, not a live key. "Confirmed" means the paper is found by the Papers search, not that it is a member of the collection, because no collection filter is documented. `buildSearchBody` is the one place to change if the live API differs.
- **Surface.** `/governance` shows recommendations with citation chips; `/api/governance/citations` runs the check for a signed-in treasurer. Without the key the chips come from the bundled list and nothing is claimed as confirmed.

## Open items for the owner

- Mint a ScholarXIV key and set `SCHOLARXIV_API_URL` (normally `https://www.scholarxiv.com/api/v1`) and `SCHOLARXIV_API_KEY` on the host, then check `/governance` shows "confirmed" chips. If the request or response shape differs, adjust `buildSearchBody` and `papersOf`.
- `docs/IDEATION.md` describes the papers more strongly than the catalogue does and lists author names that differ slightly for the 2023 paper ("Michael, K." there, "Karen Sowon et al." in the README and code). Reconcile against the actual arXiv pages before judging.
- Whether ScholarXIV's MCP is used for ideation is not recorded in the repo; add a note if it was.
