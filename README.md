# Sened (ሰነድ)

> **Voice-Audited Community Treasury & Dispute-Free Trust Engine for Ethiopian Equbs and Iddirs.**  
> Built by **Team GitGud** for the **STARK Official Hackathon 2026**.

[![STARK Official Hackathon](https://img.shields.io/badge/STARK-Hackathon_2026-hyper?style=flat-square)](https://hackathon.stark.et/)
[![ScholarXIV Collection](https://img.shields.io/badge/ScholarXIV-Collection%20(Live)-blue?style=flat-square)](https://www.scholarxiv.com/collections/6aaf5269f7a1121dbd049897?token=293b33f942e29f15a7bc9b4fd82b33bf88eb252a190ebbdb05c5ded00cf36896)
[![Voxide Voice](https://img.shields.io/badge/Voxide-Amharic%20%2F%20Oromiffa-purple?style=flat-square)](https://voxide.app)
[![Links.et Payments](https://img.shields.io/badge/Links.et-17_Banks_Verified-emerald?style=flat-square)](https://links.et)
[![EthioDeploy](https://img.shields.io/badge/EthioDeploy-Live_Hosting-orange?style=flat-square)](https://ethiodeploy.com)

**Live ScholarXIV Collection:** [STARK Hackathon 2026 - Ideation & Research (GitGud)](https://www.scholarxiv.com/collections/6aaf5269f7a1121dbd049897?token=293b33f942e29f15a7bc9b4fd82b33bf88eb252a190ebbdb05c5ded00cf36896)

---

## 📌 About Sened

In Ethiopia, traditional Rotating Savings and Credit Associations (**Equb - ዕቁብ**) and community mutual-aid insurance societies (**Iddir - ዕድር**) circulate billions of Birr annually. As cash has shifted to mobile banking (Telebirr, CBE Birr, Awash), administration has collapsed into screenshot fraud, reconciliation chaos in Telegram groups, and digital exclusion of elder treasurers.

**Sened (ሰነድ)** bridges this gap by combining **voice-first vernacular interaction** with **real-time bank receipt verification**, honoring the oral tradition of community finance while eliminating fraud.

---

## 📖 Traced Ideation & Research

Our ideation journey—including why we evaluated and rejected Telegram bots, standard mobile apps, and USSD services—is documented in:

👉 **[Read the Full Traced Ideation Journal (docs/IDEATION.md)](./docs/IDEATION.md)**  
👉 **[View the Technical & Product Roadmap (ROADMAP.md)](./ROADMAP.md)**

### Key Research Grounding (Curated in [ScholarXIV Collection](https://www.scholarxiv.com/collections/6aaf5269f7a1121dbd049897?token=293b33f942e29f15a7bc9b4fd82b33bf88eb252a190ebbdb05c5ded00cf36896)):

#### Preprints Attached to ScholarXIV Collection:
1. **Dr. Rediet Abebe et al. (AAAI 2022)** — [*An Algorithmic Introduction to Savings Circles*](https://arxiv.org/abs/2203.12486) (`arXiv:2203.12486`). Algorithmic mechanism design for ROSCAs, fair pot allocation, and default minimization.
2. **Fan Wang (2021)** — [*An empirical equilibrium model of formal and informal credit markets in developing countries*](https://arxiv.org/abs/2204.12374) (`arXiv:2204.12374`). Proves formal banking and informal community credit coexist when verification costs are addressed.
3. **Karen Sowon et al. (2023)** — [*The Role of User-Agent Interactions on Mobile Money Practices in Kenya and Tanzania*](https://arxiv.org/abs/2309.00226) (`arXiv:2309.00226`). Conversational trust and audio interaction in East African mobile financial ecosystems.
4. **Quist-Aphetsi Kester (2013)** — [*The Role of Rural Banks in Providing Mobile Money Services to Rural Poor Communities*](https://arxiv.org/abs/1307.7789) (`arXiv:1307.7789`). Integration models bridging grassroots community finance and formal mobile money infrastructure.

#### Foundational Literature (Peer-Reviewed Journals):
5. **Stefan Dercon et al. (2006)** — *In sickness and in health: Risk-sharing within Ethiopian funeral societies (Iddirs)* (*Journal of Development Economics*). Empirical evidence on informal risk-sharing resilience in Ethiopia.
6. **Besley, Coate & Loury (1993)** — *The Economics of Rotating Savings and Credit Associations* (*The American Economic Review*). Theoretical foundations of ROSCA efficiency and social enforcement.

---

## ⚡ Core Features

What is built today (see [ROADMAP.md](./ROADMAP.md) for per-item status). External providers are optional: each one is inert, and fails closed, until its keys are set (see [Configuration](#-configuration)).

* 🎙️ **Spoken Contribution Logging:** a mic-dock recorder with a live waveform, and a parser that reads Amharic and Afaan Oromoo numerals, Ethiopian month names, providers and references (*"ለመስከረም ወር እቁብ 5000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው"*). Speech is always provisional. Server transcription needs Voxide keys; otherwise the modal uses browser speech recognition where available, or a typed transcript. The app UI is English and Amharic.
* 🛡️ **Receipt Verification (Links.et):** a signed-in treasurer's voice entry is sent to `/api/bank-verifications`, which checks the receipt against Telebirr, CBE or Awash through Links.et. Needs a Links.et key; with none, nothing is ever shown as verified. Unresolved receipts are queued as `PENDING_RECONCILIATION` (the queue is not yet drained automatically).
* 📒 **Append-only Double-Entry Ledger:** SHA-256 hash-chained entries in Supabase Postgres, balance and immutability enforced in the database, corrections as reversals, group roles and invite links. The home screen reads the signed-in group's real ledger (labelled sample data when signed out).
* 🔊 **Spoken Audio Balance Sheets:** one button reads a treasury digest aloud in Amharic using the browser's speech synthesis, with play, pause and speed controls.
* 🎲 **Verifiably Fair Lottery Draw:** a commit-reveal engine with member-committed seeds, an independent verifier, reserve retention, and `/api/draw/*` routes. The `/draw` page runs the engine on-device with demo data.
* 📚 **ScholarXIV Governance Copilot (`/governance`):** advisory bylaw and penalty recommendations with citation tags, from a bundled catalogue. An optional ScholarXIV API key lets the server confirm the cited papers.
* 📴 **Offline Desk (`/offline`):** IndexedDB (Dexie) roster, notes and draft ledger entries with an outbox; when signed in it syncs through `POST /api/sync` (push and pull, hash-checked).

---

## 🚀 Getting Started

Requires Node 22 (the version the Docker image uses).

```bash
npm install
cp .env.example .env.local   # then fill in what you need
npm run dev                  # http://localhost:3000
```

Without any keys the app runs: the home screen shows labelled sample data, and the `/api/*` routes answer `503 not_configured` until Supabase is configured.

### Configuration

Every environment variable (Supabase, bank-reference keys, Links.et, ScholarXIV, Voxide) is documented in [`.env.example`](./.env.example). Database migrations, the container build (the two `NEXT_PUBLIC_SUPABASE_*` values are build args) and hosting are covered in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

### Tests

```bash
npm test            # unit and component tests (Vitest)
npm run test:e2e    # Playwright, mobile and desktop projects (needs a production build)
npm run test:all    # lint, typecheck, unit tests, build, then e2e
```

---

## 🏗️ System Architecture

```
[ Member Spoken Audio ]                    [ Treasurer Audio Request ]
"በቴሌብር 5,000 ብር አስገብቻለሁ..."               "የዚህ ወር ሂሳብ ሪፖርት አሰማኝ"
           │                                            ▲
           ▼                                            │
   ┌───────────────┐                            ┌───────────────┐
   │  Voxide STT   │                            │  Voxide TTS   │
   └───────┬───────┘                            └───────▲───────┘
           │ (Intent & Ref)                             │ (Spoken Audio)
           ▼                                            │
   ┌────────────────────────────────────────────────────────────┐
   │                 Links.et Verification Layer                │
   │       Validates Ref against Telebirr, CBE, Awash...        │
   └───────────────────────────┬────────────────────────────────┘
                               │ (Verified Truth)
                               ▼
   ┌────────────────────────────────────────────────────────────┐
   │               Sened Double-Entry Ledger Engine             │
   │  - Immutable SHA-256 Audit Trail                           │
   │  - Abebe et al. Fair Draw Lottery Mechanism                │
   │  - ScholarXIV Papers API Governance Grounding              │
   └────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    [ Docker image · EthioDeploy target ]
```

---

## 👥 Team GitGud

* **Track:** Software / Product Development
* **Hackathon:** STARK Official Hackathon 2026
* **Verification:** Built from scratch on the clock, tracked via atomic Git commits and STARK Changelog entries.

---

## 📜 License

MIT License. Copyright (c) 2026 Team GitGud.
