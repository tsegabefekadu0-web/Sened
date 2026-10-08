import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import DrawPage from "@/app/draw/page";
import { DrawBoard } from "@/components/draw/DrawBoard";
import { VerifyPanel } from "@/components/draw/VerifyPanel";
import type { DrawVerificationTranscript } from "@/lib/draw/canonical";
import type { DrawVerificationResult } from "@/lib/draw/types";

/**
 * jsdom ships a `crypto` without `subtle`, and the draw engine hashes through
 * `crypto.subtle` in the browser. Without this the component cannot verify
 * anything on-device, which is exactly the claim under test, so the real
 * WebCrypto implementation is installed rather than a stub.
 */
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

/**
 * Panels are located by their stable `data-draw-panel` hook rather than by
 * their Amharic headings. Ge'ez literals are fragile to match on across
 * encodings, and the accessible name is still asserted separately where it
 * matters for a11y.
 */
function panel(name: string): ReturnType<typeof within> {
  const found = document.querySelector(`[data-draw-panel="${name}"]`);
  if (found === null) {
    throw new Error(`No draw panel named ${name}`);
  }
  return within(found as HTMLElement);
}

async function sealCommitment(): Promise<void> {
  const user = userEvent.setup();
  render(<DrawBoard />);
  await user.click(screen.getByRole("button", { name: "እጣውን ቆልፍ" }));
  await screen.findByRole("button", { name: "አሸናፊውን አውጣ" });
}

describe("DrawBoard ceremony", () => {
  it("adopts the dead Mesob assets rather than inventing new art", async () => {
    const { container } = render(<DrawBoard />);
    const viewBoxes = () =>
      Array.from(container.querySelectorAll("svg")).map((svg) => svg.getAttribute("viewBox"));

    // MesobIcon (0 0 54 62) is what the ceremony rests on.
    expect(viewBoxes()).toContain("0 0 54 62");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "እጣውን ቆልፍ" }));
    await screen.findByRole("button", { name: "አሸናፊውን አውጣ" });
    await user.click(screen.getByRole("button", { name: "አሸናፊውን አውጣ" }));

    // MesobBasket (0 0 70 82) is the celebration. Both had zero importers at
    // `main`; the ceremony is what gives them a home.
    await waitFor(() => {
      expect(viewBoxes()).toContain("0 0 70 82");
    });
  });

  it("shows the three ceremony steps in order", () => {
    render(<DrawBoard />);

    expect(screen.getByText("እጣውን መቆለፍ")).toBeInTheDocument();
    expect(screen.getByText("አሸናፊውን መምረጥ")).toBeInTheDocument();
    expect(screen.getByText("ማረጋገጥ")).toBeInTheDocument();
  });

  it("publishes a commitment and roster digest after sealing", async () => {
    render(<DrawBoard />);
    expect(screen.getByText("እስካሁን ምንም እጣ አልተቆለፈም።")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "እጣውን ቆልፍ" }));

    await waitFor(() => {
      expect(screen.getByText("እጣው ተቆልፏል፤ የአባላት ዝርዝርም ታትሟል።")).toBeInTheDocument();
    });
    expect(panel("commitment").getAllByText(/^[0-9a-f]{64}$/).length).toBeGreaterThanOrEqual(2);
  });

  it("verifies an honest reveal on-device and names a winner", async () => {
    await sealCommitment();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "አሸናፊውን አውጣ" }));

    await waitFor(() => {
      expect(panel("verify").getByText("ተረጋግጧል")).toBeInTheDocument();
    });
    const verified = panel("verify");
    expect(verified.getByText("አሸናፊ")).toBeInTheDocument();
    expect(verified.getByText("ትሪት")).toBeInTheDocument();
    expect(verified.getByText("የግል ድምር")).toBeInTheDocument();
    expect(screen.getByText("እጣ ተጠናቋል")).toBeInTheDocument();
  });

  it("REFUSES the whole draw when the revealed seed does not reproduce the commitment", async () => {
    await sealCommitment();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "አሸናፊውን አውጣ" }));

    // The engine refuses before it ever names a winner. No winner is shown, and
    // the verification panel keeps reporting the honest "not yet" state rather
    // than anything that could be mistaken for a successful draw.
    await waitFor(() => {
      // The wording names the member contributions too, because they are part of
      // what has to reproduce the commitment for the draw to stand.
      expect(screen.getByText(/do not reproduce the published commitment/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("እጣ ተጠናቋል")).not.toBeInTheDocument();
    expect(panel("verify").getByText("ገና አልተረጋግጠም")).toBeInTheDocument();
    expect(screen.queryByText("ተረጋግጧል")).not.toBeInTheDocument();
  });

  it("explains the reserve instead of paying out the whole pot", async () => {
    await sealCommitment();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "አሸናፊውን አውጣ" }));

    await waitFor(() => {
      expect(panel("risk").getByText("የመሶብ ጠቅላላ")).toBeInTheDocument();
    });
    const risk = panel("risk");
    const pot = risk.getByText("የመሶብ ጠቅላላ").nextElementSibling?.textContent ?? "";
    const payout = risk.getByText("የሚከፈለው").nextElementSibling?.textContent ?? "";
    const reserve = risk.getByText("የተጠበቀ ማስጠንቀቂያ").nextElementSibling?.textContent ?? "";

    expect(pot).toContain("25,000");
    // The payout is strictly less than the pot, and the reserve is the gap.
    expect(payout).not.toBe(pot);
    expect(reserve).not.toMatch(/^Br 0\.00/);
    expect(risk.getByText(/የመጠባበቂያ ገንዘቡ አይበቃም/)).toBeInTheDocument();
  });

  it("keeps a past winner out of the remaining draws", async () => {
    await sealCommitment();
    const user = userEvent.setup();

    for (let round = 1; round <= 2; round += 1) {
      await user.click(screen.getByRole("button", { name: "አሸናፊውን አውጣ" }));
      await waitFor(() => {
        expect(screen.getByText("እጣ ተጠናቋል")).toBeInTheDocument();
      });
      await user.click(screen.getByRole("button", { name: "ወደ ቀጣይ ዙር ቀጥል" }));
      if (round < 2) {
        await user.click(screen.getByRole("button", { name: "እጣውን ቆልፍ" }));
        await screen.findByRole("button", { name: "አሸናፊውን አውጣ" });
      }
    }

    expect(screen.getByText("ዙር 3 / 8")).toBeInTheDocument();
    expect(panel("rotation").getAllByText("አሸናፊ ሆነዋል")).toHaveLength(2);
  });

  it("shows no English words in the Amharic page header and seal stamp, and the English ones after the switch", async () => {
    const user = userEvent.setup();
    const { container } = render(<DrawPage />);
    expect(screen.queryByText("A draw you can check")).toBeNull();
    expect(screen.getByText("ሁሉም ሊያረጋግጠው የሚችል እጣ")).toBeInTheDocument();
    expect(container.textContent).not.toContain("SEALED");
    await user.click(screen.getByRole("button", { name: "Switch to English" }));
    expect(screen.getByText("A draw you can check")).toBeInTheDocument();
  });

  it("switches to English without losing the ceremony", async () => {
    const user = userEvent.setup();
    render(<DrawPage />);

    await user.click(screen.getByRole("button", { name: "Switch to English" }));

    expect(screen.getByText("Mesob draw ceremony")).toBeInTheDocument();
    expect(screen.getAllByText("Lock the draw").length).toBeGreaterThan(0);
  });
});

describe("VerifyPanel tamper reporting", () => {
  const transcript: DrawVerificationTranscript = {
    drawId: "55555555-5555-4555-8555-555555555555",
    groupId: "22222222-2222-4222-8222-222222222222",
    cycleId: "77777777-7777-4777-8777-777777777777",
    round: 1,
    commitment: "a".repeat(64),
    rosterDigest: "b".repeat(64),
    commitmentNonce: "nonce-abcdefghijklmnop",
    memberDigest: "e".repeat(64),
    memberCommitments: [
      { memberId: "00014444-4444-8444-8444-444444444444", sealed: "f".repeat(64) }
    ],
    seed: "seed-abcdefghijklmnop",
    participants: [
      {
        memberId: "00014444-4444-8444-844444444444",
        ticket: "c".repeat(64),
        contributionAmount: "5000.00"
      }
    ]
  };

  it("says so plainly when a commitment does not reproduce", () => {
    const verification: DrawVerificationResult = {
      verified: false,
      codes: ["commitment_mismatch"],
      warnings: [],
      winnerMemberId: null,
      winningTicket: null,
      selectedIndex: null,
      transcriptDigest: "d".repeat(64),
      recomputedCommitment: "f".repeat(64),
      errors: [
        {
          code: "commitment_mismatch",
          detail: "The revealed seed does not hash to the published commitment."
        }
      ]
    };

    render(<VerifyPanel transcript={transcript} verification={verification} isRunning={false} error={null} />);

    expect(screen.getByText("ማስተካከል ተለይቷል")).toBeInTheDocument();
    expect(screen.getAllByText(/does not hash to the published commitment/).length).toBeGreaterThan(0);
    // No winner is shown next to a failed verification.
    expect(screen.queryByText("አሸናፊ")).not.toBeInTheDocument();
  });

  it("refuses to certify before the seed is revealed", () => {
    const verification: DrawVerificationResult = {
      verified: false,
      codes: ["incomplete_transcript"],
      warnings: [],
      winnerMemberId: null,
      winningTicket: null,
      selectedIndex: null,
      transcriptDigest: null,
      recomputedCommitment: null,
      errors: [
        { code: "incomplete_transcript", detail: "The seed has not been revealed yet." }
      ]
    };

    render(
      <VerifyPanel
        transcript={{ ...transcript, seed: "" }}
        verification={verification}
        isRunning={false}
        error={null}
      />
    );

    expect(screen.getByText("ገና አልተረጋግጠም")).toBeInTheDocument();
    expect(screen.getAllByText(/has not been revealed yet/).length).toBeGreaterThan(0);
  });

  it("surfaces an abandoned-commitment warning without calling the arithmetic invalid", () => {
    const verification: DrawVerificationResult = {
      verified: true,
      codes: ["ok", "suspicious_commitment_history"],
      warnings: ["1 commitment(s) for this round were created and then abandoned."],
      winnerMemberId: "00014444-4444-8444-844444444444",
      winningTicket: "c".repeat(64),
      selectedIndex: 0,
      transcriptDigest: "d".repeat(64),
      recomputedCommitment: "a".repeat(64),
      errors: []
    };

    render(<VerifyPanel transcript={transcript} verification={verification} isRunning={false} error={null} />);

    expect(screen.getByText("ተረጋግጧል")).toBeInTheDocument();
    expect(screen.getByText(/abandoned/)).toBeInTheDocument();
  });
});

describe("VerifyPanel and RiskPanel speak both languages", () => {
  const transcript: DrawVerificationTranscript = {
    drawId: "55555555-5555-4555-8555-555555555555",
    groupId: "22222222-2222-4222-8222-222222222222",
    cycleId: "77777777-7777-4777-8777-777777777777",
    round: 1,
    commitment: "a".repeat(64),
    rosterDigest: "b".repeat(64),
    commitmentNonce: "nonce-abcdefghijklmnop",
    memberDigest: "e".repeat(64),
    memberCommitments: [{ memberId: "00014444-4444-8444-8444-444444444444", sealed: "f".repeat(64) }],
    seed: "seed-abcdefghijklmnop",
    participants: [
      { memberId: "00014444-4444-8444-8444-444444444444", ticket: "c".repeat(64), contributionAmount: "5000.00" }
    ]
  };
  const ethiopic = /[ሀ-፿]/;

  const failing: DrawVerificationResult = {
    verified: false,
    codes: ["commitment_mismatch", "roster_mismatch", "member_commitment_mismatch", "incomplete_transcript", "selection_mismatch"],
    warnings: ["1 commitment(s) for this round were created and then abandoned."],
    warningItems: [
      { code: "abandoned_commitments", count: 2 },
      { code: "recorded_winner_mismatch" },
      { code: "recorded_digest_mismatch" }
    ],
    winnerMemberId: null,
    winningTicket: null,
    selectedIndex: null,
    transcriptDigest: null,
    recomputedCommitment: null,
    errors: (
      ["commitment_mismatch", "roster_mismatch", "member_commitment_mismatch", "incomplete_transcript", "selection_mismatch"] as const
    ).map((code) => ({ code, detail: `engine detail for ${code}` }))
  };

  it("shows English in English: status, errors and structured warnings, with no Amharic left", () => {
    render(<VerifyPanel locale="en" transcript={transcript} verification={failing} isRunning={false} error={null} />);
    const verify = panel("verify");

    expect(verify.getByText("Tampering detected")).toBeInTheDocument();
    expect(verify.getByText(/The revealed seed does not reproduce the published commitment/)).toBeInTheDocument();
    expect(verify.getByText(/A member's nonce does not open what they sealed/)).toBeInTheDocument();
    expect(verify.getByText(/2 commitment\(s\) for this round were created and then abandoned/)).toBeInTheDocument();
    expect(verify.getByText(/winner recorded by the server does not match/)).toBeInTheDocument();
    const text = document.querySelector('[data-draw-panel="verify"]')!.textContent ?? "";
    expect(text).not.toMatch(ethiopic);
  });

  it("shows Amharic in Amharic (the default), with the structured warning and its count", () => {
    render(<VerifyPanel transcript={transcript} verification={failing} isRunning={false} error={null} />);
    const text = document.querySelector('[data-draw-panel="verify"]')!.textContent ?? "";

    expect(text).toContain("ማስተካከል ተለይቷል");
    expect(text).toContain("ለዚህ ዙር 2 መቆለፊያ(ዎች) ተፈጥረው ተተዋል");
    // The English engine detail is kept as technical detail, labelled as English.
    expect(document.querySelector('[data-draw-panel="verify"] [lang="en"]')).not.toBeNull();
  });

  it("has a message in both languages for every verification code and warning kind", async () => {
    const { dictionaries } = await import("@/lib/i18n");
    const { DRAW_VERIFICATION_CODES } = await import("@/lib/draw/types");
    for (const code of DRAW_VERIFICATION_CODES) {
      for (const locale of ["en", "am"] as const) {
        expect(dictionaries[locale][`drawVerify.err.${code}` as keyof typeof dictionaries.en], `${locale} ${code}`).toBeTruthy();
      }
    }
    for (const kind of ["abandoned_commitments", "recorded_winner_mismatch", "recorded_digest_mismatch"]) {
      for (const locale of ["en", "am"] as const) {
        expect(dictionaries[locale][`drawVerify.warn.${kind}` as keyof typeof dictionaries.en], `${locale} ${kind}`).toBeTruthy();
      }
    }
    for (const state of ["sealing", "committed", "revealed", "paid"]) {
      expect(dictionaries.am[`drawLive.lifecycle.${state}` as keyof typeof dictionaries.en]).toBeTruthy();
    }
  });

  it("localises every risk note kind the engine can emit", async () => {
    const { RiskPanel } = await import("@/components/draw/RiskPanel");
    const { assessDrawRisk, planReserve } = await import("@/lib/draw/risk");
    const base = {
      drawId: "55555555-5555-4555-8555-555555555555",
      potAmount: "10000.00",
      reserveRatioBps: 1000,
      totalRounds: 5,
      contributionAmount: "2000.00",
      eligibleCount: 5
    };
    // Mid-cycle (member exposure), final round, and an exposure above the ceiling.
    const requests = [
      { ...base, round: 2 },
      { ...base, round: 5 },
      { ...base, round: 1, contributionAmount: "9000.00", potAmount: "45000.00" }
    ];
    const seen = new Set<string>();
    for (const request of requests) {
      const risk = assessDrawRisk(request, planReserve(request));
      for (const note of risk.noteItems ?? []) seen.add(note.code);
      for (const locale of ["en", "am"] as const) {
        const { unmount, container } = render(<RiskPanel locale={locale} risk={risk} currencyLabel="ETB" />);
        const text = container.textContent ?? "";
        if (locale === "en") expect(text).not.toMatch(ethiopic);
        else {
          // No English engine sentence leaks into the Amharic panel.
          for (const english of risk.notes) expect(text).not.toContain(english);
          expect(text).toMatch(ethiopic);
        }
        unmount();
      }
    }
    expect([...seen].sort()).toEqual(["base_reserve", "cannot_absorb", "capped", "coverage", "final_round", "member_exposure"].sort());
  });
});
