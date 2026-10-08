import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VoiceModal } from "@/components/voice/VoiceModal";
import { parseContributionUtterance } from "@/lib/voice/parser";

/**
 * The mic dock must not be a dead end, and it must not lie about what it did.
 *
 * `page.tsx` used to pass nothing, so the submit control was permanently
 * disabled and a fully working Amharic/Oromo parser led nowhere. A treasurer
 * during a Sunday meeting has no signed-in session and often no connection, so
 * the honest path is a provisional note kept on the device.
 *
 * Three things are asserted, and the third is the one that matters most: the
 * local path is available, it says it is local, and it never claims to have
 * reached a bank.
 */

/** ROADMAP 3.1's reference sentence, as escapes. */
const AMHARIC = "\u1208\u1218\u1235\u12a8\u1228\u121d \u12c8\u122d \u12a5\u1241\u1265 5,000 \u1265\u122d \u1274\u120c\u1265\u122d \u12a0\u1235\u1308\u1265\u127b\u1208\u1201 \u1261\u1325\u1229 9BF42 \u1290\u12cd";

async function typeSentence(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole("button", { name: "Or type it" }));
  await user.type(screen.getByLabelText("What was heard"), text);
}

describe("the voice modal with no verifier wired", () => {
  it("offers a local record instead of a permanently disabled button", async () => {
    const user = userEvent.setup();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={vi.fn()} locale="en" />);

    await typeSentence(user, AMHARIC);

    const record = screen.getByRole("button", { name: /Record on this device/i });
    expect(record).toBeEnabled();
    // The real submission control is not offered at all, because it would be a
    // promise this build cannot keep.
    expect(screen.queryByRole("button", { name: /Send to the bank/i })).not.toBeInTheDocument();
  });

  it("says the note is only a draft until the bank check makes it final", async () => {
    const user = userEvent.setup();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={vi.fn()} locale="en" />);

    await typeSentence(user, AMHARIC);

    // One short sentence replaces the two disclaimer paragraphs: still no promise of a receipt.
    expect(screen.getByText("This is only a draft. It becomes final after the bank check.")).toBeInTheDocument();
  });

  it("hands the caller the extraction and states where the text came from", async () => {
    const user = userEvent.setup();
    const onRecordLocally = vi.fn();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={onRecordLocally} locale="en" />);

    await typeSentence(user, AMHARIC);
    await user.click(screen.getByRole("button", { name: /Record on this device/i }));

    expect(onRecordLocally).toHaveBeenCalledTimes(1);
    const [draft, origin] = onRecordLocally.mock.calls[0]!;
    expect(draft.amount).toBe(5000);
    expect(draft.provider).toBe("telebirr");
    expect(draft.txRef).toBe("9BF42");
    // Typed, not spoken. The store records this distinction and the modal is the
    // only thing that knows it, so it must be stated rather than inferred.
    expect(origin).toEqual({ transcriptSource: "human-typed" });
  });

  it("never marks the note verified, on any path", async () => {
    const user = userEvent.setup();
    const onRecordLocally = vi.fn();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={onRecordLocally} locale="en" />);

    await typeSentence(user, AMHARIC);
    await user.click(screen.getByRole("button", { name: /Record on this device/i }));

    const [draft] = onRecordLocally.mock.calls[0]!;
    expect(draft.status).toBe("PROVISIONAL");
    expect(draft.verified).toBe(false);
  });

  it("reports a failed write instead of closing as though it worked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VoiceModal
        isOpen
        onClose={onClose}
        onRecordLocally={vi.fn().mockRejectedValue(new Error("quota exceeded"))}
        locale="en"
      />
    );

    await typeSentence(user, AMHARIC);
    await user.click(screen.getByRole("button", { name: /Record on this device/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be saved on this device/i
    );
    // A closed modal and a "success" would be the lie this assertion exists to
    // prevent: the treasurer would walk away believing the note was recorded.
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("with a verifier wired, verification stays the primary action", () => {
  it("shows the bank submission and not the local record", async () => {
    const user = userEvent.setup();
    render(
      <VoiceModal
        isOpen
        onClose={() => {}}
        onRecordLocally={vi.fn()}
        onRequestVerification={vi.fn()}
        locale="en"
      />
    );

    await typeSentence(user, AMHARIC);

    expect(screen.getByRole("button", { name: /Send to the bank/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Record on this device/i })).not.toBeInTheDocument();
  });

  it("does not close when the bank has not verified", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VoiceModal
        isOpen
        onClose={onClose}
        onRecordLocally={vi.fn()}
        onRequestVerification={vi.fn().mockResolvedValue({ verified: false })}
        locale="en"
      />
    );

    await typeSentence(user, AMHARIC);
    await user.click(screen.getByRole("button", { name: /Send to the bank/i }));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a sound extraction and a blocked one", () => {
  it("keeps the record control disabled when the amount is unusable", async () => {
    const user = userEvent.setup();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={vi.fn()} locale="en" />);

    await typeSentence(user, "9,999,999,999,999 birr");

    expect(screen.getByRole("button", { name: /Record on this device/i })).toBeDisabled();
  });

  it("agrees with the parser about what is sound", () => {
    // Guards against the modal and the parser drifting apart.
    const draft = parseContributionUtterance(AMHARIC);
    expect(draft.blocking).toBe(false);
    expect(draft.amountWire).toBe("5000.00");
  });
});

describe("the draft is read back in the reader's own script", () => {
  it("shows the Ethiopian month in Ge'ez and the amount in birr in Amharic", async () => {
    const user = userEvent.setup();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={vi.fn()} locale="am" />);

    await user.click(screen.getByRole("button", { name: "ወይም ይጻፉ" }));
    await user.type(screen.getByLabelText("የተሰማው"), AMHARIC);

    expect(screen.getByText("መስከረም")).toBeInTheDocument(); // መስከረም
    expect(screen.getByText("5,000 ብር")).toBeInTheDocument(); // 5,000 ብር
    expect(screen.queryByText(/Meskerem|ETB/)).not.toBeInTheDocument();
  });

  it("keeps Latin month and ETB in English", async () => {
    const user = userEvent.setup();
    render(<VoiceModal isOpen onClose={() => {}} onRecordLocally={vi.fn()} locale="en" />);

    await typeSentence(user, AMHARIC);

    expect(screen.getByText("Meskerem")).toBeInTheDocument();
    expect(screen.getByText("5,000 ETB")).toBeInTheDocument();
  });
});

describe("the voice modal as a sheet", () => {
  it("has a close button of at least 48px, closes on Escape, and gives focus back to its opener", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          <VoiceModal isOpen={open} onClose={() => setOpen(false)} locale="en" />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "opener" });

    await user.click(opener);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toMatch(/h-12 w-12/);
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(opener).toHaveFocus();
  });
});
