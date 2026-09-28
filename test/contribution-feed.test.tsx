import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ContributionFeed, type MemberContribution } from "@/components/contributions/ContributionFeed";
import { translate, type MessageKey } from "@/lib/i18n";

/**
 * §12.3: no fabricated trust signals.
 *
 * This file is a guard, not a UI test. The component it covers used to derive a
 * bank badge from a *spoken channel name* and hard-code
 * `verifiedBy: "Links.et Core Trust Engine"` plus `Verified 0.4s` into every
 * receipt. Nothing in the treasury had verified anything; the badge was a
 * string. A judge tapping it would have concluded the entire verification
 * engine was a mock, which is the one conclusion this product cannot afford.
 *
 * So the assertions below are about what must never appear.
 */

const PROVISIONAL: MemberContribution = {
  id: "1",
  name: "Gabi Member",
  avatar: "/avatars/woman_photo.png",
  channel: "telebirr",
  transactionId: "C0970153",
  amount: 5000,
  status: "PROVISIONAL"
};

const VERIFIED: MemberContribution = {
  id: "2",
  name: "Awa Member",
  avatar: "/avatars/elder_photo.png",
  channel: "cbe",
  transactionId: "C0370320",
  amount: 1500,
  status: "VERIFIED",
  verifiedBy: "links.et",
  verifiedAt: "2026-09-26T09:30:11.000Z"
};

describe("a provisional contribution is shown as pending, never as verified", () => {
  it("labels a provisional row as awaiting verification", () => {
    render(<ContributionFeed contributions={[PROVISIONAL]} />);

    expect(screen.getByText("በመጠባበቅ ላይ")).toBeInTheDocument();
    expect(screen.queryByText("የተረጋገጠ የባንክ ክፍያ")).not.toBeInTheDocument();
  });

  it("names no verifier and no latency for a provisional row", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed contributions={[PROVISIONAL]} />);

    await user.click(screen.getByText("Gabi Member"));

    expect(screen.getByText("በመጠባበቅ ላይ — አልተረጋገጠም")).toBeInTheDocument();
    expect(screen.getByText(/ይህ ልይል ከተናገረ ስለሆነ ነው/)).toBeInTheDocument();

    // The two fabrications this file exists to prevent.
    expect(screen.queryByText("Links.et Core Trust Engine")).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified 0\.4s/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0\.4s/);
  });

  it("does not invent an amount when the extraction carried none", () => {
    render(<ContributionFeed contributions={[{ ...PROVISIONAL, amount: undefined }]} />);
    expect(screen.queryByText("5,000 ETB")).not.toBeInTheDocument();
  });
});

describe("only a real verification result may produce a bank badge", () => {
  it("shows the badge and the provider that actually answered", async () => {
    const user = userEvent.setup();
    render(<ContributionFeed contributions={[VERIFIED]} />);

    expect(screen.getByText("ሲቢኤ ብር")).toBeInTheDocument();

    await user.click(screen.getByText("Awa Member"));
    expect(screen.getByText("የተረጋገጠ የባንክ ክፍያ")).toBeInTheDocument();
    expect(screen.getByText("links.et")).toBeInTheDocument();
    expect(screen.getByText("2026-09-26T09:30:11.000Z")).toBeInTheDocument();
  });

  it("fails closed: VERIFIED with no provenance renders as pending", () => {
    // The type says a verified row carries a verifier. A row that lies about
    // it must not be able to buy a green badge by setting one boolean.
    const lying: MemberContribution = { ...VERIFIED, verifiedBy: "   " };

    render(<ContributionFeed contributions={[lying]} />);

    expect(screen.getByText("በመጠባበቅ ላይ")).toBeInTheDocument();
    expect(screen.queryByText("ሲቢኤ ብር")).not.toBeInTheDocument();
  });

  it("does not let a channel name imply verification", () => {
    // The original defect: `telebirrVerified: entry.channel === "Telebirr"`.
    const spoken: MemberContribution = { ...PROVISIONAL, channel: "telebirr" };

    render(<ContributionFeed contributions={[spoken]} />);

    expect(screen.queryByText("ቴሌብር")).not.toBeInTheDocument();
    expect(screen.getByText("በመጠባበቅ ላይ")).toBeInTheDocument();
  });
});

describe("an empty feed says so", () => {
  it("shows an honest empty state instead of fixture rows with bank badges", () => {
    render(<ContributionFeed contributions={[]} />);

    expect(screen.getByText("እስካሁል ምንም ልይል የለም")).toBeInTheDocument();
    expect(screen.queryByText("Links.et Core Trust Engine")).not.toBeInTheDocument();
  });
});

describe("§12.6 — the shell's copy exists in both languages", () => {
  // The Gen A components used to hard-code Amharic and never call `t()`. This is
  // a standing non-negotiable, and `test/i18n.test.ts` only proves the *keys*
  // have an `am` twin — not that the components use them.
  const SHELL_KEYS = [
    "shell.debter.label",
    "shell.debter.ariaLabel",
    "shell.debter.potBalance",
    "shell.debter.currency",
    "shell.debter.nextDraw",
    "shell.header.listen",
    "shell.header.groupName",
    "shell.header.subtitle",
    "shell.nav.home",
    "shell.nav.ledger",
    "shell.nav.members",
    "shell.nav.profile",
    "shell.nav.voiceAria",
    "shell.feed.title",
    "shell.feed.pending",
    "shell.feed.reference",
    "shell.feed.verifiedTitle",
    "shell.feed.unverifiedTitle",
    "shell.feed.channel",
    "shell.feed.notAContribution",
    "shell.feed.empty",
    "shell.feed.close"
  ];

  it.each(SHELL_KEYS)("%s has an English and an Amharic value", (key) => {
    const typed = key as MessageKey;
    expect(translate("en", typed).trim().length).toBeGreaterThan(0);
    expect(translate("am", typed).trim().length).toBeGreaterThan(0);
    // The Amharic must actually be Amharic, not a copy of the English.
    expect(translate("am", typed)).toMatch(/[\u1200-\u137f]/);
  });

  it("renders the feed in English when asked", () => {
    render(<ContributionFeed contributions={[PROVISIONAL]} locale="en" />);

    expect(screen.getByText("Member contributions")).toBeInTheDocument();
    expect(screen.getByText("Awaiting verification")).toBeInTheDocument();
    // The Ge'ez is the default, not the only option.
    expect(screen.queryByText("የአባላት ልይሎች")).not.toBeInTheDocument();
  });

  it("names the channel in whichever language is active", async () => {
    // The channel is a receipt field, not a row badge — a pending row shows the
    // pending state, and the rail the member named is only asserted when someone
    // opens the detail.
    const user = userEvent.setup();
    const { unmount } = render(<ContributionFeed contributions={[PROVISIONAL]} locale="en" />);
    await user.click(screen.getByText("Gabi Member"));
    expect(screen.getByText("Telebirr")).toBeInTheDocument();
    unmount();

    const second = userEvent.setup();
    render(<ContributionFeed contributions={[PROVISIONAL]} locale="am" />);
    await second.click(screen.getByText("Gabi Member"));
    expect(screen.getByText("ቴሌብር")).toBeInTheDocument();
  });
});
