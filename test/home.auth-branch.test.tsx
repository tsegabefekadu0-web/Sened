import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  session: { status: "signed-out" } as { status: string; accessToken?: string; email?: string | null },
  modalProps: [] as Array<Record<string, unknown>>
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => hoisted.session }));
vi.mock("@/components/voice/VoiceModal", () => ({
  VoiceModal: (props: Record<string, unknown>) => {
    hoisted.modalProps.push(props);
    return null;
  }
}));

import SenedHome from "@/app/page";
import { translate } from "@/lib/i18n";

function lastProps() {
  return hoisted.modalProps[hoisted.modalProps.length - 1];
}

describe("home voice flow: signed-in / signed-out branches", () => {
  beforeEach(() => {
    hoisted.modalProps.length = 0;
  });

  it.each(["signed-out", "unconfigured", "loading"])(
    "keeps the on-device record path when %s",
    (status) => {
      hoisted.session = { status };
      render(<SenedHome />);
      expect(lastProps().onRecordLocally).toBeTypeOf("function");
      expect(lastProps().onRequestVerification).toBeUndefined();
    }
  );

  it("switches the primary action to bank verification when signed in", () => {
    hoisted.session = { status: "signed-in", accessToken: "tok", email: "t@example.com" };
    render(<SenedHome />);
    expect(lastProps().onRequestVerification).toBeTypeOf("function");
    expect(lastProps().onRecordLocally).toBeUndefined();
  });

  it.each(["signed-out", "unconfigured"])("keeps the honest Profile placeholder when %s", async (status) => {
    hoisted.session = { status };
    render(<SenedHome />);
    await userEvent.setup().click(screen.getByRole("button", { name: translate("am", "shell.nav.profile") }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("region")).toBeInTheDocument();
  });
});
