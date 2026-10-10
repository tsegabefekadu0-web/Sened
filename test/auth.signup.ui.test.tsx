import { act, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  replace: vi.fn(),
  session: { status: "signed-out" } as { status: string }
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/auth/browserClient", () => ({
  getBrowserSupabase: () => ({ auth: { signInWithOtp: h.signInWithOtp, verifyOtp: h.verifyOtp, signOut: vi.fn() } })
}));
vi.mock("@/lib/auth/useSession", () => ({ useSession: () => h.session }));
vi.mock("@/lib/auth/finishSignIn", async () => {
  const real = await vi.importActual<typeof import("@/lib/auth/finishSignIn")>("@/lib/auth/finishSignIn");
  return { ...real, completeProfileFromSignUp: vi.fn().mockResolvedValue(undefined) };
});

import { AuthCard } from "@/components/auth/AuthCard";
import { RESEND_COOLDOWN_SECONDS, isNoAccountError } from "@/lib/auth/rateLimit";
import { stashPendingInvite } from "@/lib/ledger/clientInvites";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
const type = (id: string, value: string) => fireEvent.change($(id), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  h.session = { status: "signed-out" };
  h.signInWithOtp.mockResolvedValue({ error: null });
  h.verifyOtp.mockResolvedValue({ error: null });
});

describe("sign up", () => {
  it("sends name and phone as metadata and creates the user", async () => {
    render(<AuthCard mode="sign-up" />);
    type("auth-name", "Abebe Kebede");
    type("auth-email", "abebe@example.com");
    type("auth-phone", "0911 223344");
    submit();
    await waitFor(() => expect(h.signInWithOtp).toHaveBeenCalledTimes(1));
    const arg = h.signInWithOtp.mock.calls[0][0];
    expect(arg.email).toBe("abebe@example.com");
    expect(arg.options.shouldCreateUser).toBe(true);
    expect(arg.options.data).toEqual({ name: "Abebe Kebede", phone: "911223344" });
    await waitFor(() => expect($("auth-code")).toBeTruthy());
  });

  it("REJECTS a missing name before anything is sent", async () => {
    render(<AuthCard mode="sign-up" />);
    type("auth-email", "abebe@example.com");
    submit();
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(h.signInWithOtp).not.toHaveBeenCalled();
  });
});

describe("sign in", () => {
  it("never creates an account, and points an unknown email to sign up", async () => {
    h.signInWithOtp.mockResolvedValue({ error: { status: 422, code: "otp_disabled", message: "Signups not allowed for otp" } });
    render(<AuthCard mode="sign-in" />);
    type("auth-email", "new@example.com");
    submit();
    await waitFor(() => expect(document.querySelector('a[href="/sign-up"][class*="underline"]')).toBeTruthy());
    expect(h.signInWithOtp.mock.calls[0][0].options.shouldCreateUser).toBe(false);
    expect(h.signInWithOtp.mock.calls[0][0].options.data).toBeUndefined();
    expect(document.querySelectorAll('a[href="/sign-up"]').length).toBeGreaterThan(1);
  });

  it("locks the send button for the cooldown after a link is sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AuthCard mode="sign-in" />);
      type("auth-email", "abebe@example.com");
      submit();
      await waitFor(() => expect($("auth-code")).toBeTruthy());
      const resend = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(String(RESEND_COOLDOWN_SECONDS)));
      expect(resend).toBeTruthy();
      expect((resend as HTMLButtonElement).disabled).toBe(true);
      for (let i = 0; i <= RESEND_COOLDOWN_SECONDS; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
      }
      await waitFor(() => expect((resend as HTMLButtonElement).disabled).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies the 6-digit code and goes to /home", async () => {
    render(<AuthCard mode="sign-in" />);
    type("auth-email", "abebe@example.com");
    submit();
    await waitFor(() => expect($("auth-code")).toBeTruthy());
    type("auth-code", "123456");
    submit();
    await waitFor(() => expect(h.verifyOtp).toHaveBeenCalledWith({ email: "abebe@example.com", token: "123456", type: "email" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/home"));
  });

  it("goes to the pending invite after the code is accepted", async () => {
    stashPendingInvite("a".repeat(43));
    render(<AuthCard mode="sign-in" />);
    type("auth-email", "abebe@example.com");
    submit();
    await waitFor(() => expect($("auth-code")).toBeTruthy());
    type("auth-code", "654321");
    submit();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/join"));
  });

  it("REJECTS a wrong code with a plain message and stays on the page", async () => {
    h.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    render(<AuthCard mode="sign-in" />);
    type("auth-email", "abebe@example.com");
    submit();
    await waitFor(() => expect($("auth-code")).toBeTruthy());
    type("auth-code", "000000");
    submit();
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe("isNoAccountError", () => {
  it("recognises the signups-disabled responses", () => {
    expect(isNoAccountError({ code: "otp_disabled" })).toBe(true);
    expect(isNoAccountError({ message: "Signups not allowed for otp" })).toBe(true);
    expect(isNoAccountError({ status: 429, code: "over_email_send_rate_limit" })).toBe(false);
    expect(isNoAccountError(null)).toBe(false);
  });
});
