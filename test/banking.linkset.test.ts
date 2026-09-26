import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createProductionBankProviderAdapter } from "@/lib/banking/adapter";
import { assessBankProviderResult } from "@/lib/banking/matching";
import {
  createMaskedAccountFingerprint,
  isLinksEtConfigured,
  LinksEtBankProviderAdapter,
  normalizeMaskedAccount,
  parseReceiptAmount,
  parseReceiptTimestamp,
  type LinksEtConfig
} from "@/lib/banking/linkset";
import { createInMemoryBankVerificationService } from "@/lib/banking/service";
import type {
  BankAccountBinding,
  BankProvider,
  BankProviderResult
} from "@/lib/banking/types";

const fingerprintKey = Buffer.alloc(32, 9);

const config: LinksEtConfig = {
  apiKey: "vk_live_test_key",
  baseUrl: "https://links.et",
  waitMs: 800,
  timeoutMs: 5_000,
  fingerprintKey,
  etbOffsetMinutes: 180,
  timestampToleranceSeconds: 900
};

const treasuryMask = "2519********";
const memberMask = "0911********";

const lookup = {
  provider: "telebirr" as const,
  transactionReference: "ABCD1234EF",
  accountFingerprintHmac: createMaskedAccountFingerprint("telebirr", treasuryMask, fingerprintKey)
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function adapterFor(provider: BankProvider, fetchImpl: typeof fetch): LinksEtBankProviderAdapter {
  return new LinksEtBankProviderAdapter({ provider, config, fetchImpl });
}

/** Builds a fetch stub that records its calls and returns a fixed response. */
function stubFetch(response: Response | (() => Response | Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === "function" ? response() : response.clone();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const telebirrReceipt = {
  source: "telebirr-html",
  payerName: "Selam Bekele",
  payerTelebirrNo: memberMask,
  payerAccountType: "Individual Customer",
  creditedPartyName: "Mesfin Equb Treasury",
  creditedPartyAccountNo: treasuryMask,
  transactionStatus: "Completed",
  receiptNo: "ABCD1234EF",
  paymentDate: "25-09-2026 10:30:00",
  settledAmount: "5000 Birr",
  serviceFee: "1.74 Birr",
  serviceFeeVAT: "0.26 Birr",
  totalPaidAmount: "5002 Birr",
  paymentReason: "Send Money to Registered Customer",
  paymentMode: "telebirr",
  paymentChannel: "API/App"
};

function telebirrEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    providerKey: "telebirr",
    resolvedUrl: "https://transactioninfo.ethiotelecom.et/receipt/ABCD1234EF",
    httpStatus: 200,
    fetchedAt: "2026-09-25T07:30:01.000Z",
    rawHtmlLength: 25_928,
    error: null,
    receipt: { ...telebirrReceipt, ...overrides }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("links.et adapter configuration", () => {
  it("fails closed when no links.et key is configured", async () => {
    vi.stubEnv("LINKS_ET_API_KEY", "");
    vi.stubEnv("BANK_REFERENCE_HMAC_KEY", "");

    expect(isLinksEtConfigured()).toBe(false);
    const adapter = createProductionBankProviderAdapter("telebirr");

    expect(adapter.isConfigured()).toBe(false);
    await expect(adapter.verify(lookup)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED"
    });
  });

  it("builds a real HTTP adapter once a key is configured", () => {
    vi.stubEnv("LINKS_ET_API_KEY", "vk_live_configured");
    vi.stubEnv("BANK_REFERENCE_HMAC_KEY", fingerprintKey.toString("base64"));

    expect(isLinksEtConfigured()).toBe(true);
    const adapter = createProductionBankProviderAdapter("cbe");

    expect(adapter.isConfigured()).toBe(true);
    expect(adapter).toBeInstanceOf(LinksEtBankProviderAdapter);
  });

  it("refuses a key that is not a links.et key", async () => {
    vi.stubEnv("LINKS_ET_API_KEY", "sk-not-a-links-et-key");
    vi.stubEnv("BANK_REFERENCE_HMAC_KEY", fingerprintKey.toString("base64"));

    const { readLinksEtConfigFromEnvironment } = await import("@/lib/banking/linkset");
    expect(() => readLinksEtConfigFromEnvironment()).toThrow(/not a links\.et API key/i);
  });
});

describe("links.et wire contract", () => {
  it("POSTs to /api/verify with the key, an idempotency key, and waitMs", async () => {
    const { impl, calls } = stubFetch(jsonResponse(telebirrEnvelope()));

    await adapterFor("telebirr", impl).verify(lookup);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://links.et/api/verify");
    const init = calls[0]?.init;
    const headers = init?.headers as Record<string, string>;
    expect(init?.method).toBe("POST");
    expect(headers["x-api-key"]).toBe("vk_live_test_key");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      reference: "ABCD1234EF",
      waitMs: 800
    });
  });

  it("sends a full url for non-telebirr providers", async () => {
    const receiptUrl = "https://apps.cbe.com.et/receipt/FT00000000";
    const { impl, calls } = stubFetch(
      jsonResponse({
        ok: true,
        providerKey: "cbe",
        receipt: {
          source: "cbe-pdf",
          payerName: "Selam Bekele",
          payerAccount: "1****0000",
          receiverName: "Treasury",
          receiverAccount: "1000******01",
          paymentDate: "9/25/2026, 10:30:00 AM",
          reference: "FT00000000",
          transferredAmount: 5000,
          totalAmount: 5001.74,
          currency: "ETB"
        }
      })
    );

    await adapterFor("cbe", impl).verify({
      provider: "cbe",
      transactionReference: receiptUrl,
      accountFingerprintHmac: "a".repeat(64)
    });

    expect(JSON.parse(String(calls[0]?.init.body)).url).toBe(receiptUrl);
  });

  it("keeps the idempotency key stable across retries so a retry is safe", async () => {
    const { impl, calls } = stubFetch(jsonResponse({ ok: true, ...{} }));
    const adapter = adapterFor("telebirr", impl);

    await adapter.verify(lookup).catch(() => undefined);
    await adapter.verify(lookup).catch(() => undefined);

    const keyOf = (call: { init: RequestInit }) =>
      (call.init.headers as Record<string, string>)["Idempotency-Key"];
    expect(keyOf(calls[0]!)).toBe(keyOf(calls[1]!));
  });
});

describe("links.et receipt normalization", () => {
  it("normalizes a settled telebirr receipt into verified evidence", async () => {
    const { impl } = stubFetch(jsonResponse(telebirrEnvelope()));

    const result = (await adapterFor("telebirr", impl).verify(lookup)) as BankProviderResult;

    expect(result.provider).toBe("telebirr");
    expect(result.kind).toBe("settled");
    expect(result.evidence).toMatchObject({
      providerTransactionId: "ABCD1234EF",
      // settledAmount, not totalPaidAmount: the fee is not part of the
      // contribution and matching on the total would reject every real payment.
      amount: "5000.00",
      currency: "ETB",
      direction: "inbound",
      occurredAt: "2026-09-25T07:30:00.000Z"
    });
    expect(result.evidence?.senderFingerprint).toBe(
      createMaskedAccountFingerprint("telebirr", memberMask, fingerprintKey)
    );
    expect(result.evidence?.receiverFingerprint).toBe(lookup.accountFingerprintHmac);
  });

  it("infers outbound when the treasury account is the sender", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        telebirrEnvelope({
          payerTelebirrNo: treasuryMask,
          creditedPartyAccountNo: memberMask
        })
      )
    );

    const result = (await adapterFor("telebirr", impl).verify(lookup)) as BankProviderResult;

    expect(result.evidence?.direction).toBe("outbound");
  });

  it("treats a non-completed telebirr transaction as unsettled", async () => {
    const { impl } = stubFetch(
      jsonResponse(telebirrEnvelope({ transactionStatus: "Pending" }))
    );

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "unsettled" });
    expect(result).not.toHaveProperty("evidence");
  });

  it("normalizes an awash receipt with its nested customer/transaction shape", async () => {
    const { impl } = stubFetch(
      jsonResponse({
        ok: true,
        providerKey: "awash",
        receipt: {
          source: "awash-html",
          customer: { customerName: "Selam", accountNo: "XXXXX******XXXX/BANK" },
          transaction: {
            transactionTime: "2026-09-25 10:30:00 AM",
            transactionType: "IPS Bank Transfer",
            amount: "5000 ETB",
            senderName: "Selam",
            senderAccount: "XXXXX*******XXX",
            beneficiaryName: "Treasury",
            beneficiaryAccount: "1000000000000",
            transactionId: "000000000000000"
          }
        }
      })
    );

    const result = (await adapterFor("awash", impl).verify({
      provider: "awash",
      transactionReference: "https://awashpay.awashbank.com:8225/receipt/x",
      accountFingerprintHmac: "b".repeat(64)
    })) as BankProviderResult;

    expect(result.kind).toBe("settled");
    expect(result.evidence).toMatchObject({
      providerTransactionId: "000000000000000",
      amount: "5000.00",
      currency: "ETB",
      occurredAt: "2026-09-25T07:30:00.000Z"
    });
  });

  it("rejects a CBE Birr receipt presented against a CBE binding", async () => {
    // links.et rule 1: switch on receipt.source. cbebirr-pdf is a different
    // product and must not satisfy a CBE binding.
    const { impl } = stubFetch(
      jsonResponse({
        ok: true,
        providerKey: "cbe",
        receipt: { source: "cbebirr-pdf", reference: "FT00000000", transferredAmount: 5000 }
      })
    );

    const result = await adapterFor("cbe", impl).verify({
      provider: "cbe",
      transactionReference: "https://cbepay1.cbe.com.et/x",
      accountFingerprintHmac: "a".repeat(64)
    });

    expect(result).toMatchObject({ kind: "invalid_response" });
  });

  it("rejects an envelope whose providerKey disagrees with the binding", async () => {
    const { impl } = stubFetch(
      jsonResponse({ ...(telebirrEnvelope() as object), providerKey: "cbe" })
    );

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "invalid_response" });
  });

  it.each([
    ["a missing receipt", { ok: true, providerKey: "telebirr" }],
    ["a missing source", { ok: true, providerKey: "telebirr", receipt: { receiptNo: "X" } }],
    ["a non-ok envelope", { ok: false, error: { code: "invalid_request" } }],
    ["a receipt with no reference", telebirrEnvelope({ receiptNo: undefined })],
    ["a receipt with no usable amount", telebirrEnvelope({ settledAmount: "n/a", totalPaidAmount: "n/a" })]
  ])("treats %s as an invalid response", async (_label, payload) => {
    const { impl } = stubFetch(jsonResponse(payload));

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "invalid_response" });
  });
});

describe("links.et error mapping", () => {
  it("maps 202 to unsettled so the reconciliation queue resumes it", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        { processingStatus: "queued", requestId: "550e8400-e29b-41d4-a716-446655440000" },
        { status: 202 }
      )
    );

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "unsettled" });
  });

  it("maps 429 rate_limited to rate_limited and honours Retry-After", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        { ok: false, error: { code: "rate_limited", message: "slow down" } },
        { status: 429, headers: { "retry-after": "42" } }
      )
    );

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 42 });
  });

  it("does not treat quota_exceeded as a short-timer rate limit", async () => {
    // A quota can be days out; retrying on a seconds timer would hammer all month.
    const { impl } = stubFetch(
      jsonResponse(
        { ok: false, error: { code: "quota_exceeded", used: 200, cap: 200 } },
        { status: 429, headers: { "retry-after": "86400" } }
      )
    );

    const result = await adapterFor("telebirr", impl).verify(lookup);

    expect(result).toMatchObject({ kind: "provider_error" });
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });

  it("fails closed on 401 rather than retrying a revoked key", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        { ok: false, error: { code: "revoked_key", message: "revoked" } },
        { status: 401 }
      )
    );

    await expect(adapterFor("telebirr", impl).verify(lookup)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED"
    });
  });

  it("maps 502 to a retryable provider error", async () => {
    const { impl } = stubFetch(
      jsonResponse({ ok: false, error: "parsed PDF but didn't look like a CBE receipt" }, { status: 502 })
    );

    expect(await adapterFor("telebirr", impl).verify(lookup)).toMatchObject({
      kind: "provider_error"
    });
  });

  it("maps 503 provider_down to rate_limited honouring Retry-After", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        { ok: false, error: { code: "provider_down", message: "bank down" } },
        { status: 503, headers: { "retry-after": "300" } }
      )
    );

    expect(await adapterFor("telebirr", impl).verify(lookup)).toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 300
    });
  });

  it("maps a malformed body to invalid_response", async () => {
    const { impl } = stubFetch(new Response("<html>gateway</html>", { status: 200 }));

    expect(await adapterFor("telebirr", impl).verify(lookup)).toMatchObject({
      kind: "invalid_response"
    });
  });

  it("maps a network failure to provider_error", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    expect(await adapterFor("telebirr", impl).verify(lookup)).toMatchObject({
      kind: "provider_error"
    });
  });

  it("maps an aborted request to timeout", async () => {
    const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (init?.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return jsonResponse(telebirrEnvelope());
    }) as unknown as typeof fetch;

    const impatient = new LinksEtBankProviderAdapter({
      provider: "telebirr",
      config: { ...config, waitMs: 10, timeoutMs: 10 },
      fetchImpl: impl
    });

    expect(await impatient.verify(lookup)).toMatchObject({ kind: "timeout" });
  });
});

describe("links.et value parsing", () => {
  it.each([
    ["102 Birr", "102.00"],
    ["100 ETB", "100.00"],
    ["1,250.50", "1250.50"],
    ["5000", "5000.00"],
    [260, "260.00"],
    [0.61, "0.61"]
  ])("parses amount %s as %s", (input, expected) => {
    expect(parseReceiptAmount(input)).toBe(expected);
  });

  it.each([["0"], ["-5"], ["n/a"], [""], [null], [undefined], [-1], [0]])(
    "refuses to coerce amount %s",
    (input) => {
      expect(parseReceiptAmount(input)).toBeNull();
    }
  );

  it.each([
    ["251********", "251********"],
    ["1****0000", "1****0000"],
    // Awash appends a branch suffix that is not part of the account identity.
    ["XXXXX******XXXX/BANK", "XXXXX******XXXX"],
    ["  0911 **  1234 ", "0911**1234"]
  ])("normalizes masked account %s", (input, expected) => {
    expect(normalizeMaskedAccount(input)).toBe(expected);
  });

  it("keeps masked-account fingerprints in a separate domain from references", () => {
    const account = createMaskedAccountFingerprint("telebirr", treasuryMask, fingerprintKey);
    const reference = createMaskedAccountFingerprint("telebirr", treasuryMask, fingerprintKey);
    expect(account).toBe(reference);
    expect(account).not.toBe(
      createMaskedAccountFingerprint("cbe", treasuryMask, fingerprintKey)
    );
  });

  it.each([
    ["25-09-2026 10:30:00", "telebirr-html", "2026-09-25T07:30:00.000Z"],
    ["9/25/2026, 10:30:00 AM", "cbe-pdf", "2026-09-25T07:30:00.000Z"],
    ["2026-01-01T00:00:00Z", "mb-json", "2026-01-01T00:00:00.000Z"],
    ["2026-09-25 10:30:00 AM", "awash-html", "2026-09-25T07:30:00.000Z"],
    ["2026-09-25 12:30:00 PM", "awash-html", "2026-09-25T09:30:00.000Z"]
  ])("parses %s (%s) as %s", (input, source, expected) => {
    expect(parseReceiptTimestamp(input, source, 180)).toBe(expected);
  });

  it.each([["not a date"], [""], [null], ["2026-13-45 99:99:99"]])(
    "refuses unparseable timestamp %s",
    (input) => {
      expect(parseReceiptTimestamp(input, "telebirr-html", 180)).toBeNull();
    }
  );
});

describe("end-to-end verification through the service", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const groupId = "22222222-2222-4222-8222-222222222222";
  const tenantId = "99999999-9999-4999-8999-999999999999";
  const bindingId = "33333333-3333-4333-8333-333333333333";
  const ledgerAccountId = "44444444-4444-4444-8444-444444444444";

  const binding: BankAccountBinding = {
    id: bindingId,
    userId,
    groupId,
    tenantId,
    ledgerAccountId,
    provider: "telebirr",
    currency: "ETB",
    accountLabel: "Treasury mobile money",
    accountFingerprintHmac: createMaskedAccountFingerprint("telebirr", treasuryMask, fingerprintKey),
    senderFingerprintHmac: createMaskedAccountFingerprint("telebirr", memberMask, fingerprintKey),
    receiverFingerprintHmac: createMaskedAccountFingerprint("telebirr", treasuryMask, fingerprintKey),
    active: true
  };

  const request = {
    provider: "telebirr" as const,
    bankAccountBindingId: bindingId,
    providerReference: "ABCD1234EF",
    amount: "5000.00",
    currency: "ETB",
    direction: "inbound" as const,
    // The treasurer's declared time, four minutes after the bank's 10:30 EAT.
    occurredAt: "2026-09-25T07:34:00.000Z",
    idempotencyKey: "bank-intent-linkset-001"
  };

  it("VERIFIES a matching receipt and posts to the ledger sink", async () => {
    const { impl } = stubFetch(jsonResponse(telebirrEnvelope()));
    const postVerifiedContribution = vi.fn(async () => "55555555-5555-4555-8555-555555555555");
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: adapterFor("telebirr", impl) },
      hmacKey: fingerprintKey,
      ledgerSink: { postVerifiedContribution },
      // The treasury declares a time; the bank's own clock is authoritative
      // within the adapter's tolerance rather than to the millisecond.
      clock: () => new Date("2026-09-25T07:35:00.000Z")
    });

    const result = await service.create(request, { userId });

    expect(result.verification.state).toBe("VERIFIED");
    expect(postVerifiedContribution).toHaveBeenCalledTimes(1);
  });

  it("REJECTS a receipt whose amount disagrees with the declared contribution", async () => {
    const { impl } = stubFetch(jsonResponse(telebirrEnvelope({ settledAmount: "4000 Birr" })));
    const postVerifiedContribution = vi.fn(async () => "55555555-5555-4555-8555-555555555555");
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: adapterFor("telebirr", impl) },
      hmacKey: fingerprintKey,
      ledgerSink: { postVerifiedContribution }
    });

    const result = await service.create(request, { userId });

    expect(result.verification.state).toBe("REJECTED");
    expect(result.verification.reasonCode).toBe("AMOUNT_MISMATCH");
    expect(postVerifiedContribution).not.toHaveBeenCalled();
  });

  it("REJECTS a receipt sent by a different account", async () => {
    const { impl } = stubFetch(
      jsonResponse(telebirrEnvelope({ payerTelebirrNo: "0777********" }))
    );
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: adapterFor("telebirr", impl) },
      hmacKey: fingerprintKey
    });

    const result = await service.create(request, { userId });

    expect(result.verification.state).toBe("REJECTED");
    expect(result.verification.reasonCode).toBe("SENDER_MISMATCH");
  });

  it("keeps an unverifiable receipt pending instead of committing it", async () => {
    const { impl } = stubFetch(jsonResponse({}, { status: 503 }));
    const postVerifiedContribution = vi.fn(async () => "55555555-5555-4555-8555-555555555555");
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: adapterFor("telebirr", impl) },
      hmacKey: fingerprintKey,
      ledgerSink: { postVerifiedContribution }
    });

    const result = await service.create(request, { userId });

    expect(result.verification.state).toBe("PENDING_RECONCILIATION");
    expect(postVerifiedContribution).not.toHaveBeenCalled();
  });

  it("never leaks the provider reference or masked account into the public result", async () => {
    const { impl } = stubFetch(jsonResponse(telebirrEnvelope()));
    const service = createInMemoryBankVerificationService({
      bindings: [binding],
      adapters: { telebirr: adapterFor("telebirr", impl) },
      hmacKey: fingerprintKey
    });

    const result = await service.create(request, { userId });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("ABCD1234EF");
    expect(serialized).not.toContain(treasuryMask);
    expect(serialized).not.toContain(memberMask);
  });
});

describe("timestamp tolerance in matching", () => {
  const evidenceBase = {
    providerTransactionId: "ABCD1234EF",
    amount: "5000.00",
    currency: "ETB",
    direction: "inbound" as const,
    senderFingerprint: "a".repeat(64),
    receiverFingerprint: "b".repeat(64),
    occurredAt: "2026-09-25T07:30:00.000Z",
    settledAt: "2026-09-25T07:30:00.000Z"
  };

  const expectedBase = {
    amount: "5000.00",
    currency: "ETB",
    direction: "inbound" as const,
    senderFingerprint: "a".repeat(64),
    receiverFingerprint: "b".repeat(64),
    occurredAt: "2026-09-25T07:30:00.000Z"
  };

  it("requires exact equality by default", () => {
    const result: BankProviderResult = {
      provider: "telebirr",
      kind: "settled",
      evidence: evidenceBase
    };

    expect(
      assessBankProviderResult(result, {
        ...expectedBase,
        occurredAt: "2026-09-25T07:30:00.001Z"
      })
    ).toMatchObject({ state: "REJECTED", reasonCode: "TIMESTAMP_MISMATCH" });
  });

  it("accepts skew inside an explicit tolerance", () => {
    const result: BankProviderResult = {
      provider: "telebirr",
      kind: "settled",
      evidence: evidenceBase
    };

    expect(
      assessBankProviderResult(result, {
        ...expectedBase,
        occurredAt: "2026-09-25T07:39:00.000Z",
        timestampToleranceSeconds: 900
      })
    ).toMatchObject({ state: "VERIFIED" });
  });

  it("still rejects skew beyond the tolerance", () => {
    const result: BankProviderResult = {
      provider: "telebirr",
      kind: "settled",
      evidence: evidenceBase
    };

    expect(
      assessBankProviderResult(result, {
        ...expectedBase,
        occurredAt: "2026-09-25T08:30:00.000Z",
        timestampToleranceSeconds: 900
      })
    ).toMatchObject({ state: "REJECTED", reasonCode: "TIMESTAMP_MISMATCH" });
  });

  it("does not let tolerance excuse a wrong amount", () => {
    const result: BankProviderResult = {
      provider: "telebirr",
      kind: "settled",
      evidence: { ...evidenceBase, amount: "4000.00" }
    };

    expect(
      assessBankProviderResult(result, {
        ...expectedBase,
        occurredAt: "2026-09-25T07:31:00.000Z",
        timestampToleranceSeconds: 900
      })
    ).toMatchObject({ state: "REJECTED", reasonCode: "AMOUNT_MISMATCH" });
  });
});
