import { NextResponse } from "next/server";

import { authenticateRead } from "@/lib/authRead";
import { SupabaseBankVerificationRepository } from "@/lib/banking/server";

export const runtime = "nodejs";

/**
 * `GET /api/bank-account-bindings` — the caller's own bindings.
 *
 * The first of the two reads the voice → bank hand-off was missing. A client
 * cannot derive a binding id — it is minted when an account is bound — and a
 * verification request is unusable without one, so without this a treasurer
 * could hold a perfectly valid binding and still be unable to name it.
 *
 * The response carries no account fingerprints and no sealed reference: those
 * are HMACs over masked account numbers and exist to be compared server-side. A
 * treasurer only needs to recognise which account they bound.
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
    const bindings = await new SupabaseBankVerificationRepository(auth.client).listBindings({
      userId: auth.userId
    });
    return NextResponse.json(
      { bindings },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    // A storage failure is 502, not an empty list. "You have no accounts" and
    // "we could not read your accounts" must not look the same on screen.
    return NextResponse.json(
      { error: "storage_failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
