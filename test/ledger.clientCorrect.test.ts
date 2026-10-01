import { describe, expect, it, vi } from "vitest";
import { postCorrection } from "@/lib/ledger/clientCorrect";
import type { LedgerEntryRequest } from "@/lib/ledger/types";

const REQUEST: LedgerEntryRequest = {
  groupId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "corr-key-1",
  occurredAt: "2026-10-01T10:00:00.000Z",
  entryType: "correction",
  correctsEntryId: "11111111-1111-4111-8111-111111111111",
  rationale: "Wrong member was credited",
  postings: [
    { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", direction: "credit", amount: "5.00" },
    { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", direction: "debit", amount: "5.00" }
  ]
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deps(...responses: Array<Response | Error>) {
  const fetchImpl = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchImpl.mockRejectedValueOnce(response);
    } else {
      fetchImpl.mockResolvedValueOnce(response);
    }
  }
  return { getToken: async () => "tok", fetchImpl };
}

describe("postCorrection", () => {
  it("POSTs the JSON body with the Bearer token", async () => {
    const d = deps(json({ entry: { sequence: "9" }, replayed: false }, 201));
    await postCorrection(REQUEST, d);
    const [url, init] = d.fetchImpl.mock.calls[0];
    expect(url).toBe("/api/ledger/entries");
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok");
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it("maps 201 to created", async () => {
    expect(await postCorrection(REQUEST, deps(json({ entry: { sequence: "9" }, replayed: false }, 201)))).toEqual({
      status: "created",
      sequence: "9",
      replayed: false
    });
  });

  it("counts a 200 replay of the same key as success", async () => {
    expect(await postCorrection(REQUEST, deps(json({ entry: { sequence: "9" }, replayed: true }, 200)))).toEqual({
      status: "created",
      sequence: "9",
      replayed: true
    });
  });

  it("treats a success with no entry sequence as unconfirmed", async () => {
    expect(await postCorrection(REQUEST, deps(json({}, 201)))).toEqual({ status: "error" });
  });

  it.each([
    [400, "invalid"],
    [422, "invalid"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [409, "conflict"],
    [429, "rate-limited"],
    [404, "error"],
    [502, "error"],
    [503, "error"]
  ])("maps HTTP %i to %s", async (status, expected) => {
    expect(await postCorrection(REQUEST, deps(json({ error: "x" }, status)))).toEqual({ status: expected });
  });

  it("reports error on a network failure", async () => {
    expect(await postCorrection(REQUEST, deps(new Error("offline")))).toEqual({ status: "error" });
  });

  it("returns unauthorized and sends nothing with no token", async () => {
    const fetchImpl = vi.fn();
    expect(await postCorrection(REQUEST, { getToken: async () => null, fetchImpl })).toEqual({ status: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the same idempotency key when the caller retries the same request", async () => {
    const d = deps(new Error("offline"), json({ entry: { sequence: "9" }, replayed: true }, 200));
    await postCorrection(REQUEST, d);
    await postCorrection(REQUEST, d);
    const keys = d.fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body as string).idempotencyKey);
    expect(keys).toEqual(["corr-key-1", "corr-key-1"]);
  });
});
