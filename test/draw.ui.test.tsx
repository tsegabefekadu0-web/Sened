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
  await user.click(screen.getByRole("button", { name: "ቃል መዋጮ አስገባ" }));
  await screen.findByRole("button", { name: "ዘመኑን አሳይ" });
}

describe("DrawBoard ceremony", () => {
  it("adopts the dead Mesob assets rather than inventing new art", async () => {
    const { container } = render(<DrawBoard />);
    const viewBoxes = () =>
      Array.from(container.querySelectorAll("svg")).map((svg) => svg.getAttribute("viewBox"));

    // MesobIcon (0 0 54 62) is what the ceremony rests on.
    expect(viewBoxes()).toContain("0 0 54 62");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ቃል መዋጮ አስገባ" }));
    await screen.findByRole("button", { name: "ዘመኑን አሳይ" });
    await user.click(screen.getByRole("button", { name: "ዘመኑን አሳይ" }));

    // MesobBasket (0 0 70 82) is the celebration. Both had zero importers at
    // `main`; the ceremony is what gives them a home.
    await waitFor(() => {
      expect(viewBoxes()).toContain("0 0 70 82");
    });
  });

  it("shows the three ceremony steps in order", () => {
    render(<DrawBoard />);

    expect(screen.getByText("ደረጃ 1 — ቃል መዋጮ")).toBeInTheDocument();
    expect(screen.getByText("ደረጃ 2 — መስበር")).toBeInTheDocument();
    expect(screen.getByText("ደረጃ 3 — ማረጋገጥ")).toBeInTheDocument();
  });

  it("publishes a commitment and roster digest after sealing", async () => {
    render(<DrawBoard />);
    expect(screen.getByText("እጅግ ቃል መዋጮ አልተሰጠም።")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ቃል መዋጮ አስገባ" }));

    await waitFor(() => {
      expect(screen.getByText("ቃል መዋጮው ተሸጥቷል፤ አባላቱ ተሸጥተዋል።")).toBeInTheDocument();
    });
    expect(panel("commitment").getAllByText(/^[0-9a-f]{64}$/).length).toBeGreaterThanOrEqual(2);
  });

  it("verifies an honest reveal on-device and names a winner", async () => {
    await sealCommitment();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ዘመኑን አሳይ" }));

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
    await user.click(screen.getByRole("button", { name: "ዘመኑን አሳይ" }));

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
    await user.click(screen.getByRole("button", { name: "ዘመኑን አሳይ" }));

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
    expect(risk.getByText(/ማስጠንቀቂያው/)).toBeInTheDocument();
  });

  it("keeps a past winner out of the remaining draws", async () => {
    await sealCommitment();
    const user = userEvent.setup();

    for (let round = 1; round <= 2; round += 1) {
      await user.click(screen.getByRole("button", { name: "ዘመኑን አሳይ" }));
      await waitFor(() => {
        expect(screen.getByText("እጣ ተጠናቋል")).toBeInTheDocument();
      });
      await user.click(screen.getByRole("button", { name: "ወደ ቀጣይ ዙር ቀጥል" }));
      if (round < 2) {
        await user.click(screen.getByRole("button", { name: "ቃል መዋጮ አስገባ" }));
        await screen.findByRole("button", { name: "ዘመኑን አሳይ" });
      }
    }

    expect(screen.getByText("ዙር 3 / 8")).toBeInTheDocument();
    expect(panel("rotation").getAllByText("አሸናፊ ሆነዋል")).toHaveLength(2);
  });

  it("switches to English without losing the ceremony", async () => {
    const user = userEvent.setup();
    render(<DrawPage />);

    await user.click(screen.getByRole("button", { name: "Switch to English" }));

    expect(screen.getByText("Mesob draw ceremony")).toBeInTheDocument();
    expect(screen.getByText("Step 1 — Commit")).toBeInTheDocument();
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
