import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc
  }))
}));

import { GET } from "@/app/api/bank-verifications/[verificationId]/route";
import { POST } from "@/app/api/bank-verifications/route";
import { createGetHandler, createPostHandler } from "@/lib/banking/routeHandlers";
import type { BankVerificationService } from "@/lib/banking/service";

const userId = "11111111-1111-4111-8111-111111111111";
const verificationId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";

const requestBody = {
  provider: "telebirr",
  bankAccountBindingId: bindingId,
  providerReference: "TX-SECRET-001",
  amount: "25.00",
  currency: "ETB",
  direction: "inbound",
  occurredAt: "2026-09-25T10:30:00.000Z",
  idempotencyKey: "bank-intent-001"
};

const publicVerification = {
  verificationId,
  provider: "telebirr" as const,
  state: "VERIFIED" as const,
  reasonCode: "VERIFIED" as const,
  amount: "25.00",
  currency: "ETB" as const,
  direction: "inbound" as const,
  occurredAt: "2026-09-25T10:30:00.000Z",
  createdAt: "2026-09-25T10:30:00.000Z",
  updatedAt: "2026-09-25T10:30:01.000Z"
};

function request(body: unknown, bearer = "token"): Request {
  return new Request("http://localhost/api/bank-verifications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function fakeService() {
  return {
    create: vi.fn().mockResolvedValue({ verification: publicVerification, replayed: false }),
    get: vi.fn().mockResolvedValue(publicVerification)
  } as unknown as BankVerificationService;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: userId, app_metadata: { role: "treasurer" } } },
    error: null
  });
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/bank-verifications", () => {
  it("401s without a Bearer token", async () => {
    const response = await POST(request(requestBody, ""));

    expect(response.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("REJECTS (400) client-supplied status, actor, hashes, and raw account fields", async () => {
    const service = fakeService();
    const handler = createPostHandler(() => service);
    const response = await handler(
      request({
        ...requestBody,
        status: "VERIFIED",
        actorId: userId,
        entryHash: "0".repeat(64),
        accountNumber: "251234567890",
        sender: "raw-sender",
        receiver: "raw-receiver"
      })
    );

    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("bounds the request body before service work", async () => {
    const service = fakeService();
    const handler = createPostHandler(() => service);
    const response = await handler(
      request({
        ...requestBody,
        providerReference: "X".repeat(9_000)
      })
    );

    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("403s an authenticated member without a verified ledger role", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: userId, app_metadata: { role: "member" } } },
      error: null
    });
    const service = fakeService();
    const handler = createPostHandler(() => service);

    const response = await handler(request(requestBody));

    expect(response.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("returns only the safe public DTO and no-store headers", async () => {
    const service = fakeService();
    const handler = createPostHandler(() => service);
    const response = await handler(request(requestBody));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual(publicVerification);
    expect(payload).not.toHaveProperty("providerReference");
    expect(payload).not.toHaveProperty("userId");
    expect(payload).not.toHaveProperty("groupId");
    expect(service.create).toHaveBeenCalledWith(requestBody, { userId });
  });

  it("503s before creating any intent when the production provider is unconfigured", async () => {
    const response = await POST(request(requestBody));

    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/bank-verifications/[verificationId]", () => {
  function getRequest(bearer = "token"): Request {
    return new Request(`http://localhost/api/bank-verifications/${verificationId}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
    });
  }

  it("401s without a Bearer token", async () => {
    const response = await GET(getRequest(""), { params: { verificationId } });

    expect(response.status).toBe(401);
  });

  it("returns a safe DTO for the authenticated owner", async () => {
    const service = fakeService();
    const handler = createGetHandler(() => service);
    const response = await handler(getRequest(), { params: { verificationId } });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual(publicVerification);
    expect(payload).not.toHaveProperty("providerReference");
    expect(service.get).toHaveBeenCalledWith(verificationId, { userId });
  });

  it("404s an invalid verification identifier", async () => {
    const service = fakeService();
    const handler = createGetHandler(() => service);
    const response = await handler(getRequest(), { params: { verificationId: "not-an-id" } });

    expect(response.status).toBe(404);
    expect(service.get).not.toHaveBeenCalled();
  });
});
