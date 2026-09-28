import { NextResponse } from "next/server";

import { authenticateRead } from "@/lib/authRead";
import { listMyGroups } from "@/lib/ledger/groups";

export const runtime = "nodejs";

/**
 * `GET /api/my-groups` — the caller's groups and their chart of accounts.
 *
 * The ledger account resolver looks an account up by **code**, and a client
 * cannot know a group's codes without being told them. That makes this the read
 * the ledger correction form depends on: without the chart, a group looks
 * unprovisioned and every write is correctly refused, with nothing to show the
 * treasurer why.
 *
 * The groups are whatever `list_my_groups_v1()` returns for `auth.uid()`. There
 * is no default group and no fallback, because guessing which group someone is
 * acting for is how money ends up on the wrong ledger.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRead(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const groups = await listMyGroups(auth.client);
    return NextResponse.json(
      { groups },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "storage_failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
