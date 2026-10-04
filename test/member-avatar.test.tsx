import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemberAvatar } from "@/components/cultural/MemberAvatar";
import {
  DEFAULT_TIBEB_FRAME,
  TIBEB_FRAMES,
  isMemberAttire,
  pickTibebFrame
} from "@/lib/memberAvatarStyle";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;

describe("pickTibebFrame", () => {
  it("is deterministic: the same member id always gets the same frame", () => {
    for (let n = 1; n <= 50; n += 1) {
      expect(pickTibebFrame(uuid(n))).toBe(pickTibebFrame(uuid(n)));
    }
  });

  it("ignores letter case in the id", () => {
    expect(pickTibebFrame("ABCDEF12-aaaa-4aaa-8aaa-000000000001")).toBe(pickTibebFrame("abcdef12-AAAA-4aaa-8aaa-000000000001"));
  });

  it("spreads ids over every frame, none unused or dominant", () => {
    const counts = new Map<string, number>();
    for (let n = 1; n <= 400; n += 1) {
      const frame = pickTibebFrame(uuid(n));
      counts.set(frame, (counts.get(frame) ?? 0) + 1);
    }
    for (const frame of TIBEB_FRAMES) {
      expect(counts.get(frame) ?? 0, frame).toBeGreaterThan(40);
    }
  });

  it("falls back to the neutral default with no id", () => {
    expect(pickTibebFrame(undefined)).toBe(DEFAULT_TIBEB_FRAME);
    expect(pickTibebFrame(null)).toBe(DEFAULT_TIBEB_FRAME);
    expect(pickTibebFrame("")).toBe(DEFAULT_TIBEB_FRAME);
  });

  it("takes only an id: there is no name parameter to infer anything from", () => {
    expect(pickTibebFrame.length).toBe(1);
  });

  it("recognises only the two chosen attires", () => {
    expect(isMemberAttire("gabi")).toBe(true);
    expect(isMemberAttire("netela")).toBe(true);
    for (const other of ["tibeb", "male", "female", "", null, undefined, 1]) {
      expect(isMemberAttire(other)).toBe(false);
    }
  });
});

describe("MemberAvatar", () => {
  it("draws the frame its member id selects, and no shawl unless one was chosen", () => {
    const id = uuid(7);
    render(<MemberAvatar memberId={id} name="Member 00000007" />);
    const avatar = screen.getByTestId("member-avatar");
    expect(avatar).toHaveAttribute("data-frame", pickTibebFrame(id));
    expect(avatar).toHaveAttribute("data-attire", "none");
    expect(avatar.querySelector("[data-attire]")).toBeNull();
  });

  it.each(TIBEB_FRAMES)("renders the %s frame as decoration hidden from assistive tech", (frame) => {
    let id = "";
    for (let n = 1; n < 500 && !id; n += 1) {
      if (pickTibebFrame(uuid(n)) === frame) id = uuid(n);
    }
    render(<MemberAvatar memberId={id} name="Abebech" />);
    const svg = screen.getByTestId("member-avatar-frame");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg?.querySelectorAll("polygon, polyline, rect").length).toBeGreaterThan(4);
  });

  it("has an accessible name from the member name when there is no photo", () => {
    render(<MemberAvatar memberId={uuid(3)} name="Abebech" />);
    expect(screen.getByRole("img", { name: "Abebech" })).toBeInTheDocument();
  });

  it("uses the photo's alt text when there is a photo, with no extra role on the frame", () => {
    render(<MemberAvatar memberId={uuid(3)} name="Abebech" photo="/avatars/woman_photo.png" />);
    expect(screen.getByAltText("Abebech")).toBeInTheDocument();
    expect(screen.getByTestId("member-avatar")).not.toHaveAttribute("role");
  });

  it("draws a Gabi or Netela only when chosen, with a different shape and a text label for each", () => {
    const { unmount } = render(<MemberAvatar memberId={uuid(1)} name="Kebede" attire="gabi" attireLabel="wearing a gabi" />);
    expect(screen.getByTestId("member-avatar")).toHaveAttribute("data-attire", "gabi");
    expect(screen.getByRole("img", { name: "Kebede — wearing a gabi" })).toBeInTheDocument();
    const gabi = screen.getByTestId("member-avatar").querySelector('[data-attire="gabi"]')?.innerHTML;
    unmount();

    render(<MemberAvatar memberId={uuid(1)} name="Kebede" attire="netela" attireLabel="wearing a netela" />);
    expect(screen.getByRole("img", { name: "Kebede — wearing a netela" })).toBeInTheDocument();
    const netela = screen.getByTestId("member-avatar").querySelector('[data-attire="netela"]')?.innerHTML;
    expect(gabi).toBeTruthy();
    expect(netela).toBeTruthy();
    expect(gabi).not.toBe(netela);
  });

  it("ignores an attire it does not know instead of guessing", () => {
    render(<MemberAvatar memberId={uuid(1)} name="Kebede" attire={"female" as never} />);
    expect(screen.getByTestId("member-avatar")).toHaveAttribute("data-attire", "none");
  });

  it("uses only design-token classes for colour, no hard-coded hex in the frame", () => {
    render(<MemberAvatar memberId={uuid(5)} name="Selam" attire="netela" />);
    const markup = screen.getByTestId("member-avatar-frame")!.outerHTML;
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markup).toMatch(/terracotta|gold|parchment|coffee/);
  });
});
