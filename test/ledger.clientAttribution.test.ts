import { describe, expect, it, vi } from "vitest";

import { attributePayer, supersedePayer } from "@/lib/ledger/clientAttribution";

const GROUP = "22222222-2222-4222-8222-222222222222";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CYCLE = "66666666-6666-4666-8666-666666666666";
const input = { groupId: GROUP, entryId: ENTRY, memberUserId: MEMBER };

function deps(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { deps: { getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch }, fetchImpl };
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = (revision = 1, replayed = false) => ({ attribution: { revision }, replayed });

describe("attributePayer", () => {
  it("POSTs only the entry, the member and the optional cycle and round, with the Bearer token", async () => {
    const { deps: d, fetchImpl } = deps(json(okBody(), 201));
    const result = await attributePayer({ ...input, cycleId: CYCLE, round: 2 }, d);
    expect(result).toEqual({ status: "ok", replayed: false, revision: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ledger/attributions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ...input, cycleId: CYCLE, round: 2 });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("sends no cycle or round, and no recorder, when none is given", async () => {
    const { deps: d, fetchImpl } = deps(json(okBody(), 201));
    await attributePayer(input, d);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(Object.keys(body).sort()).toEqual(["entryId", "groupId", "memberUserId"]);
  });

  it("sends the channel and note only when given, and a correction distinguishes absent (keep) from null (clear)", async () => {
    const { deps: d, fetchImpl } = deps(json(okBody(), 201));
    await attributePayer({ ...input, channel: "cash", note: "Hand to hand" }, d);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      ...input,
      channel: "cash",
      note: "Hand to hand"
    });

    fetchImpl.mockClear();
    await supersedePayer({ ...input, reason: "Receipt book shows cash" }, d);
    const kept = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect("channel" in kept).toBe(false);
    expect("note" in kept).toBe(false);

    fetchImpl.mockClear();
    await supersedePayer({ ...input, reason: "Removing what was recorded", channel: null, note: null }, d);
    const cleared = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(cleared).toMatchObject({ channel: null, note: null });
  });

  it("reports a replay as ok with replayed set", async () => {
    expect(await attributePayer(input, deps(json(okBody(1, true), 200)).deps)).toEqual({ status: "ok", replayed: true, revision: 1 });
  });

  it("names each refusal by its database code", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "attribution_bank_verified", "bank_verified"],
      [409, "attribution_entry_corrected", "corrected"],
      [409, "attribution_exists", "exists"],
      [409, "attribution_unchanged", "unchanged"],
      [422, "attribution_not_contribution", "not_contribution"],
      [404, "ledger_entry_not_found", "entry_not_found"],
      [404, "ledger_member_not_found", "member_not_found"],
      [404, "ledger_cycle_not_found", "cycle_not_found"],
      [404, "attribution_not_found", "attribution_not_found"],
      [409, "something_new", "other"]
    ];
    for (const [status, error, code] of cases) {
      expect(await attributePayer(input, deps(json({ error }, status)).deps), error).toEqual({ status: "refused", code });
    }
  });

  it("maps the other statuses", async () => {
    expect(await attributePayer(input, deps(json({ error: "forbidden" }, 403)).deps)).toEqual({ status: "forbidden" });
    expect(await attributePayer(input, deps(json({ error: "unauthorized" }, 401)).deps)).toEqual({ status: "unauthorized" });
    expect(await attributePayer(input, deps(json({}, 429)).deps)).toEqual({ status: "rate-limited" });
    expect(await attributePayer(input, deps(json({}, 502)).deps)).toEqual({ status: "error" });
    expect(await attributePayer(input, deps(new Error("offline")).deps)).toEqual({ status: "error" });
  });

  it("does not call a malformed success a success", async () => {
    expect(await attributePayer(input, deps(json({ replayed: false }, 201)).deps)).toEqual({ status: "error" });
    expect(await attributePayer(input, deps(new Response("not json", { status: 201 })).deps)).toEqual({ status: "error" });
  });

  it("is unauthorized with no session token", async () => {
    const result = await attributePayer(input, { getToken: async () => null, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(result).toEqual({ status: "unauthorized" });
  });
});

describe("supersedePayer", () => {
  it("PUTs the same body with the reason", async () => {
    const { deps: d, fetchImpl } = deps(json(okBody(2), 201));
    const result = await supersedePayer({ ...input, reason: "The receipt book names another member" }, d);
    expect(result).toEqual({ status: "ok", replayed: false, revision: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ledger/attributions");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ ...input, reason: "The receipt book names another member" });
  });
});
