import { afterEach, describe, expect, it, vi } from "vitest";
import { authedFetch, NotSignedInError } from "@/lib/auth/authedFetch";
import { getAccessToken, getBrowserSupabase, isAuthConfigured } from "@/lib/auth/browserClient";
import { requestBankVerification } from "@/lib/voice/clientVerify";
import { parseContributionUtterance } from "@/lib/voice/parser";

const BINDING = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllEnvs());

describe("browser auth client", () => {
  it("fails closed with no Supabase environment", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(isAuthConfigured()).toBe(false);
    expect(getBrowserSupabase()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });

  it("builds a client when both variables are present", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    expect(isAuthConfigured()).toBe(true);
    expect(getBrowserSupabase()).not.toBeNull();
  });
});

describe("authedFetch", () => {
  it("attaches the Bearer token and overwrites a caller Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    await authedFetch(
      "/api/x",
      { method: "POST", body: "{}", headers: { Authorization: "Bearer forged" } },
      { getToken: async () => "tok", fetchImpl }
    );
    const headers = fetchImpl.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("REJECTS (throws, sends nothing) when there is no token", async () => {
    const fetchImpl = vi.fn();
    await expect(
      authedFetch("/api/x", {}, { getToken: async () => null, fetchImpl })
    ).rejects.toBeInstanceOf(NotSignedInError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("requestBankVerification (signed-in voice path)", () => {
  const draft = parseContributionUtterance("Telebirr 500 birr transaction C0970153");
  const deps = (fetchImpl: typeof fetch) => ({
    getToken: async () => "tok",
    fetchImpl,
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    newKey: () => "voice-key-1"
  });
  const binding = { id: BINDING, groupId: BINDING, provider: "telebirr", currency: "ETB", accountLabel: "Pot", active: true };

  it("parsed a postable draft", () => {
    expect(draft.provider).toBe("telebirr");
    expect(draft.txRef).not.toBeNull();
  });

  it("POSTs the intent to /api/bank-verifications and reports VERIFIED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ bindings: [binding] }))
      .mockResolvedValueOnce(json({ verificationId: "v1", state: "VERIFIED" }, 201));
    const result = await requestBankVerification(draft, deps(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ verified: true, verificationId: "v1" });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("/api/bank-verifications");
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({
      provider: "telebirr",
      bankAccountBindingId: BINDING,
      currency: "ETB",
      occurredAt: "2026-10-01T09:00:00.000Z",
      idempotencyKey: "voice-key-1"
    });
  });

  it("does not call a pending reconciliation verified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ bindings: [binding] }))
      .mockResolvedValueOnce(json({ verificationId: "v2", state: "PENDING_RECONCILIATION" }, 202));
    const result = await requestBankVerification(draft, deps(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ verified: false, notice: "voice.verify.pending" });
  });

  it("sends nothing when no binding matches the rail", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ bindings: [{ ...binding, provider: "cbe" }] }));
    const result = await requestBankVerification(draft, deps(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ verified: false, notice: "voice.verify.noBinding" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to guess between two matching accounts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ bindings: [binding, { ...binding, id: "4f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b" }] }));
    const result = await requestBankVerification(draft, deps(fetchImpl as unknown as typeof fetch));
    expect(result.notice).toBe("voice.verify.ambiguousBinding");
  });

  it("reports signed out when there is no token", async () => {
    const fetchImpl = vi.fn();
    const result = await requestBankVerification(draft, {
      getToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ verified: false, notice: "voice.verify.signedOut" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failed server response as not verified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ bindings: [binding] }))
      .mockResolvedValueOnce(json({ error: "ledger_unavailable" }, 503));
    const result = await requestBankVerification(draft, deps(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ verified: false, notice: "voice.verify.failed" });
  });
});
