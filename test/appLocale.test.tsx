import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { getLocaleOverride, setLocaleOverride, useAppLocale } from "@/lib/appLocale";

function Probe({ fallback }: { readonly fallback: "en" | "am" }) {
  const [locale, setLocale] = useAppLocale(fallback);
  return (
    <button type="button" data-testid="probe" onClick={() => setLocale((value) => (value === "am" ? "en" : "am"))}>
      {locale}
    </button>
  );
}

describe("useAppLocale", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses the screen's own fallback until somebody overrides the language", () => {
    render(<Probe fallback="am" />);
    expect(screen.getByTestId("probe")).toHaveTextContent("am");
  });

  it("follows an override made later, such as the voice assistant's switchLanguage", () => {
    render(<Probe fallback="am" />);
    act(() => setLocaleOverride("en"));
    expect(screen.getByTestId("probe")).toHaveTextContent("en");
    expect(getLocaleOverride()).toBe("en");
    expect(window.localStorage.getItem("sened.locale.v1")).toBe("en");
  });

  it("keeps working as a plain toggle on the screen", () => {
    render(<Probe fallback="en" />);
    act(() => screen.getByTestId("probe").click());
    expect(screen.getByTestId("probe")).toHaveTextContent("am");
  });
});
