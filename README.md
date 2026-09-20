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

Our ideation journey—including why we evaluated and rejected Telegram bots, standard mobile apps, and USSD services, as well as our simulated jury review with the hackathon judges—is documented in:

👉 **[Read the Full Traced Ideation Journal (docs/IDEATION.md)](./docs/IDEATION.md)**

### Key Research Grounding (retrieved via ScholarXIV):
1. **Dr. Rediet Abebe et al. (AAAI 2022)** — [*An Algorithmic Introduction to Savings Circles*](https://arxiv.org/abs/2203.12486) (arXiv:2203.12486). Mechanism design for welfare guarantees in lottery and auction savings circles.
2. **Fan Wang (2021)** — [*An empirical equilibrium model of formal and informal credit markets in developing countries*](https://arxiv.org/abs/2204.12374) (Review of Economic Dynamics).
3. **Stefan Dercon et al. (2006)** — *In sickness and in health: Risk-sharing within Ethiopian funeral societies (Iddirs)* (Journal of Development Economics).

---

## ⚡ Core Features

* 🎙️ **Spoken Contribution Logging (Voxide):** Members log contributions in Amharic or Afaan Oromoo (*"ለመስከረም ወር እቁብ 5000 ብር በቴሌብር አስገብቻለሁ፣ ቁጥሩ 9BF42 ነው"*).
* 🛡️ **Instant Receipt Verification (Links.et):** Transaction codes are validated in real time against Telebirr and 17 Ethiopian banks, stopping fake SMS and doctored screenshots.
* 🔊 **Spoken Audio Balance Sheets:** Treasurers tap one button to hear an audio financial digest read aloud in natural Amharic.
* 🎲 **Verifiably Fair Lottery Draw:** Cryptographically fair pot allocation (drawing the *እጣ*) that removes any perception of treasurer bias.
* 📚 **ScholarXIV Governance Copilot:** In-app advisor querying the ScholarXIV Papers API to help treasurers configure research-backed bylaws and penalty structures.

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
                    [ Hosted on EthioDeploy ]
```

---

## 👥 Team GitGud

* **Track:** Software / Product Development
* **Hackathon:** STARK Official Hackathon 2026
* **Verification:** Built from scratch on the clock, tracked via atomic Git commits and STARK Changelog entries.

---

## 📜 License

MIT License. Copyright (c) 2026 Team GitGud.
