# Sened (ሰነድ) — Product & Technical Roadmap
> **Voice-Audited Community Treasury & Dispute-Free Trust Engine for Ethiopian Equbs and Iddirs.**  
> Built by **Team GitGud** for the **STARK Official Hackathon 2026**.

---

## 🏛️ Vision & Design Reference
*Sened* is designed to bridge the gap between traditional Ethiopian community finance (*Equb* and *Iddir*) and modern digital banking. The interface directly mirrors the generated cultural design reference. (The original reference image was a local file that is not in the repository, so it is no longer linked; the cropped pieces the UI is built from live in `public/reference_assets/`.)

### Core UI Pillars:
1. **Indigenous Cultural Design Tokens**: Warm Ethiopian coffee obsidian (`#1A1412`), aged parchment cream (`#F5EFEB`), Lalibela terracotta (`#C6532B`), antique gold (`#D4A244`), and traditional *Tibeb* (ጥበብ) geometric embroidery accents.
2. **Digital *ደብተር* (Debter Card)**: Leather-stitched tactile card replacing the paper ledger, displaying total pot balance, cycle progress, and the next *እጣ* (draw).
3. **The Woven *መሶብ* (Mesob Draw Icon)**: Symbolic pot visualization for the verifiably fair lottery draw.
4. **Instant Bank Verification Badges**: Real-time Telebirr and CBE Birr transaction badges powered by Links.et.
5. **One-Touch Spoken Audio Digest (*አድምጥ*)**: Single tap audio balance sheet reading out treasury status in natural Amharic for elder treasurers.
6. **Spoken Voice Logging Dock**: Glowing terracotta-and-gold microphone button for vernacular voice contribution logging.

---

## 🗺️ Milestone Roadmap

```mermaid
graph TD
    M1["Milestone 1<br/>🎨 Indigenous Design System & Shell"] --> M2["Milestone 2<br/>🛡️ Double-Entry Ledger & Bank Verification (Links.et)"]
    M2 --> M3["Milestone 3<br/>🎙️ Zero-Trust Voice Pipeline (Voxide STT/TTS)"]
    M3 --> M4["Milestone 4<br/>🎲 Verifiably Fair Lottery Draw Engine (Abebe et al.)"]
    M4 --> M5["Milestone 5<br/>📚 ScholarXIV Governance Copilot"]
    M5 --> M6["Milestone 6<br/>🚀 PWA Offline Sync, Testing & EthioDeploy"]
```

---

### Milestone 1: Indigenous Design System & Core Shell
**Target:** Establish the complete cultural component foundation and responsive mobile-first shell matching the visual reference.

- [x] **1.1 Design System & Typography**:
  - Configure fonts: Noto Sans Ethiopic / Abyssinica SIL for Ge'ez script alongside Inter for numerals.
  - Note: the Latin/numeral face actually loaded is Plus Jakarta Sans (`src/app/layout.tsx`, `src/app/globals.css`), not Inter; Abyssinica SIL is a fallback in the font stack, not loaded from the web.
  - Implement color tokens: Coffee Dark (`#1A1412`), Parchment Cream (`#F5EFEB`), Terracotta (`#C6532B`), Antique Gold (`#D4A244`), and Bank Verification Green (`#16A34A`).
  - Create reusable SVG assets for traditional *Tibeb* (ጥበብ) diamond and cross geometric borders.
- [x] **1.2 Digital *ደብተር* (Debter) Card Component**:
  - Leather-textured card styling with subtle stitching border and *Tibeb* corner ribbon.
  - Live pot balance display (`175,000 ብር`), cycle progress indicator (`17/20 Contributed`), and upcoming draw summary.
  - Note: signed in, the pot balance and digest are read from the real ledger (`src/lib/ledger/useHomeLedger.ts`); signed out, `175,000 ብር` and `17/20` are labelled sample figures.
- [ ] **1.3 Verified Contribution Feed**:
  - Status: `ContributionFeed` can render a Telebirr / CBE verified badge, but only for a row that carries a real verification result (`status: "VERIFIED"` plus `verifiedBy`). The home screen never supplies one: signed in it lists ledger rows as "Recorded" (`PROVISIONAL`), signed out it lists two labelled sample rows. Avatars exist; per-member attire styling is not implemented.
  - Member cards with avatars, traditional attire styling (*Gabi* / *Netela* accents), and contribution amount (`+5,000 ETB`).
  - Dynamic verification badges: `Telebirr Verified` and `CBE Birr Verified` with transaction reference numbers.
- [x] **1.4 Bottom Navigation & Voice Dock**:
  - Floating tactile navigation bar with Home, Ledger (*ደብተር*), Members, and Profile slots.
  - Prominent elevated central terracotta/gold microphone trigger.
  - Note: the Home, Ledger and mic slots are functional; the Members and Profile tabs open an honest placeholder panel (`tab.panels.pending`), not a roster or profile screen. Group membership is managed under `/ledger` (invite links, roles).

---

### Milestone 2: Double-Entry Ledger Engine & Real-Time Bank Verification (Links.et)
**Target:** Implement the tamper-proof financial core and automated receipt verification to eliminate fake screenshots.

- [x] **2.1 Immutable Double-Entry Ledger**:
  - Append-only journal architecture with SHA-256 hash chaining (`previous_hash`, `entry_hash`, `timestamp`, `nonce`).
  - Zero-in-place updates: corrections require compensating balancing entries with explicit audit rationales.
  - Mathematical integrity checks: $\sum \text{Debits} = \sum \text{Credits}$ enforced at database commit level.
  - Note: verified in `supabase/migrations/20260924214531_ledger_core.sql` (deferred constraint trigger `ledger_entries_validate_at_commit`, immutability triggers on update/delete). The hash chain uses `previous_hash`, `entry_hash`, `nonce` and `occurred_at`/`recorded_at`.
- [ ] **2.2 Links.et / Ethiopian Bank Gateway Integration**:
  - Status: the adapter (`src/lib/banking/linkset.ts`), the `/api/bank-verifications` routes and the bank-account-binding flow are built and tested against mocks, and cover Telebirr, CBE and Awash. It is inert until `LINKS_ET_API_KEY` (plus the `BANK_REFERENCE_*` keys) is set, so it has never verified a real receipt here. "Within 800ms" is a first-response budget (`LINKS_ET_WAIT_MS`, default 800) sent to links.et; a slower receipt returns `202 queued` and becomes `PENDING_RECONCILIATION`, so 800ms is not a hard guarantee.
  - Verification adapter for Telebirr, Commercial Bank of Ethiopia (CBE), and Awash Bank.
  - Real-time reference validation endpoint: verifies amount, sender/receiver, and timestamp within 800ms.
- [ ] **2.3 Graceful Degradation & Reconciliation Queue**:
  - Status: unresolved verifications are marked `PENDING_RECONCILIATION` and queued in Postgres (`bank_reconciliation_jobs`), with jittered exponential backoff and lease-based claiming implemented in `src/lib/banking/reconciliation.ts`. Nothing in the app calls `drainReconciliationQueue` yet (no route, cron or worker), so the queue is not drained automatically when connectivity returns.
  - Offline / network outage fallback: transactions marked `PENDING_RECONCILIATION`.
  - Exponential backoff queue that automatically checks bank status when connectivity returns.

---

### Milestone 3: Zero-Trust Voice Pipeline (Voxide STT & TTS)
**Target:** Enable seamless Amharic and Afaan Oromoo spoken contribution logging and spoken audio financial balance sheets.

- [ ] **3.1 Spoken Contribution Logging (Voxide STT)**:
  - Status: the `getUserMedia`/`MediaRecorder` recorder with a live `AnalyserNode` waveform (in the mic-dock modal), the Amharic / Afaan Oromoo parser and the zero-trust hand-off are implemented and tested. Voxide STT (`/api/voice/transcribe`) is inert until `VOXIDE_API_URL` / `VOXIDE_API_KEY` are set; otherwise the modal relies on browser speech recognition where the device supports it, or a typed transcript. Afaan Oromoo support is real in the parser (Oromo numerals, Gecal month names, Latin-script provider/verb forms; `test/voice.numerals.test.ts`, `test/voice.parser.test.ts`), but the app UI and spoken digest are English/Amharic only, and Oromo speech recognition depends on the browser or Voxide.
  - Web Audio API microphone recorder with real-time waveform visualizer inside the bottom microphone dock.
  - Entity extraction parser for Ethiopian monetary phrasing:
    - *"ለመስከረም ወር እቁብ 5,000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው"* $\rightarrow$ `{ month: "Meskerem", amount: 5000, channel: "telebirr", tx_ref: "9BF42" }`.
  - **Zero-Trust Rule**: Voice extracted data is strictly provisional until Milestone 2 Links.et verification succeeds.
- [ ] **3.2 Spoken Audio Balance Sheet (*አድምጥ* - Listen via Voxide TTS)**:
  - Top *አድምጥ* button synthesizes an Amharic audio digest of the current Equb/Iddir treasury status:
    - *"የቦሌ መድኃኔዓለም እቁብ ዛሬ 17 አባላት አስገብተዋል። ጠቅላላ ሒሳብ 175,000 ብር ነው። 3 አባላት ይቀራሉ። ቀጣይ እጣ እሁድ ይወጣል።"*
  - Native browser audio playback with play, pause, and speed controls.
  - Status: the digest modal (play / pause / speed, progress from real `speechSynthesis` boundary events) reads the signed-in group's real ledger totals, or labelled sample figures when signed out. It speaks through the browser's `speechSynthesis` and is disabled when the device has no voice for the language; the Voxide TTS route (`/api/voice/speak`) exists but the modal does not call it, and it is inert until `VOXIDE_TTS_*` / `VOXIDE_API_*` keys are set. The digest is spoken in Amharic only.

---

### Milestone 4: Verifiably Fair Lottery Draw Engine (*እጣ*)
**Target:** Implement a transparent, mathematically fair pot allocation system based on Dr. Rediet Abebe et al. (AAAI 2022) ROSCA mechanism design.

- [ ] **4.1 Cryptographically Fair Random Draw**:
  - Status: the SHA-256 commit-reveal engine (`src/lib/draw/`), member-seed commitments (so the treasurer cannot choose the seed), the `/api/draw/*` routes, the SQL (`20260926100000_draw_commit_reveal.sql` and later) and an independent verifier are built and tested. It uses member/treasurer-committed seeds, not block hashes. The `/draw` ceremony page with the Mesob animation runs the real engine on-device with a fixture roster and does not call `/api/draw/*`; there is no haptic feedback.
  - Commit-reveal lottery mechanism using SHA-256 block hashes to prevent treasurer bias or favoritism.
  - Visual ceremonial *Mesob* (መሶብ) draw animation with celebratory tactile feedback.
- [ ] **4.2 Rotation & Default Risk Management (Abebe et al.)**:
  - Tracking payout history: previous winners are excluded from remaining draws in the cycle.
  - Dynamic social collateral & reserve retention model to minimize post-win contribution defaults.
  - Status: previous winners are excluded from later rounds (`src/lib/draw/rotation.ts`, `draw_payouts` in SQL) and a deterministic reserve-retention heuristic (`src/lib/draw/risk.ts`, capped at a third of the pot) is implemented and tested, but, as with 4.1, the UI that shows it uses fixture data. It is a heuristic, not a proven equilibrium model, and there is no separate collateral tracking.

---

### Milestone 5: ScholarXIV Governance Copilot
**Target:** An in-app governance advisor querying the ScholarXIV Papers API to ground community bylaws and penalty rules in peer-reviewed economic research.

- [ ] **5.1 ScholarXIV Papers API Adapter**:
  - Connect to live ScholarXIV collection (`6aaf5269f7a1121dbd049897`) and query preprints (Abebe et al., Fan Wang, Sowon et al., Dercon et al.).
  - Status: the adapter (`src/lib/governance/scholarxiv.ts`) and `/api/governance/citations` are built and tested against mocks, but inert until `SCHOLARXIV_API_URL` and `SCHOLARXIV_API_KEY` are set. It was written without access to the live API docs (request and response shapes are assumed, as its header comment says), has never been run against a live key, and only confirms that the bundled catalogue's papers are findable; it does not filter by collection id.
- [x] **5.2 Bylaw & Penalty Recommendation Engine**:
  - Interactive copilot dialog for treasurers configuring late payment penalties, replacement member protocols, and emergency medical fund allocations for Iddirs.
  - Citation tags linking bylaws directly to academic literature on ROSCA equilibrium.
  - Note: delivered at `/governance` (`src/lib/governance/engine.ts`, topics: late payment, replacement, default protection, emergency fund). Recommendations and citations come from a bundled catalogue and work with no key; the ScholarXIV API (5.1) is only an optional check. Advisory only, it never writes to the ledger.

---

### Milestone 6: PWA Offline Sync, Reliability Testing & EthioDeploy
**Target:** Deliver a production-grade, offline-first Progressive Web App hosted live on EthioDeploy.

- [ ] **6.1 Offline-First Architecture (IndexedDB / Dexie.js)**:
  - Status: the Dexie stores (roster, spoken notes, drafts, outbox, ledger mirror, sync metadata), the outbox with backoff and idempotency keys, and the `/offline` desk are built and tested, and work offline for data. Sync is push plus pull over `POST /api/sync` when signed in; a push goes through the same ledger path as `POST /api/ledger/entries`, and a pull stores hash-verified entries append-only in the local mirror and surfaces any fork. It is not merged silently: the pulled mirror is only shown on `/offline` (entry count and chain head), the home and ledger screens do not read it, and sync is manual (buttons), not triggered automatically when connectivity returns. Only `ledger-draft` mutations have a server path; spoken notes and roster edits stay on the device. `public/sw.js` and the manifest exist, but nothing registers the service worker, so the app shell is not cached for offline loads.
  - Full local persistence: treasurers can view rosters, record spoken notes, and draft ledger entries during Sunday meetings without active internet.
  - Automatic bidirectional sync when network connectivity is detected.
- [x] **6.2 Comprehensive Test Suite**:
  - Unit tests for double-entry ledger calculations and hash verification.
  - Voice entity extraction benchmark tests for Amharic and Afaan Oromoo number formats.
  - Automated Playwright browser tests covering both desktop and mobile viewports.
  - Note: `npm test` (Vitest) and `npm run test:e2e` (Playwright, `mobile` Pixel 7 and `desktop` 1280x900 projects); `npm run test:all` runs lint, typecheck, unit tests, build and e2e.
- [ ] **6.3 Deployment & Hackathon Submission**:
  - Status: the `Dockerfile` (built and run locally), the documented environment variables (`.env.example`) and `docs/DEPLOYMENT.md` exist. The live deployment to EthioDeploy has not happened, and no STARK changelog entries are tracked in this repository.
  - Docker containerization and live deployment on EthioDeploy.
  - STARK hackathon changelog logging and documentation finalization.

---

## 📊 Summary of Tech Stack

| Layer | Technology |
|---|---|
| **Framework & UI** | Next.js 14 / React 18, Tailwind CSS, Lucide Icons, Ge'ez Web Fonts (Noto Sans Ethiopic, Plus Jakarta Sans) |
| **Backend & Auth** | Supabase (Postgres with RLS, email sign-in), Next.js route handlers under `src/app/api` |
| **Voice & Speech** | Voxide STT/TTS routes (inert until keys are set), browser Web Speech / `speechSynthesis`, Web Audio API; Amharic / Afaan Oromoo parser |
| **Bank Verification** | Links.et / v.odit.et Verification API (adapter covers Telebirr, CBE and Awash; inert until `LINKS_ET_API_KEY` is set) |
| **Ledger & Math** | Immutable SHA-256 Double-Entry Ledger, Abebe et al. Fair Draw Engine |
| **Academic Grounding**| Bundled citation catalogue; optional ScholarXIV API (`sxv_...`) check (inert until configured) & Live Collection |
| **Offline & Storage** | Dexie.js (IndexedDB), `POST /api/sync`, service worker + manifest (worker not yet registered) |
| **Hosting & Deploy** | Docker image (Next.js standalone); EthioDeploy is the target host, not yet deployed; GitHub / STARK Verification |
