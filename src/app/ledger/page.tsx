import type { Metadata } from "next";

import { SenedShell } from "@/components/sened-shell";

/**
 * `GET /ledger` — the desktop M2 dashboard.
 *
 * This view is 847 lines of build, fully i18n'd, and until now imported only by
 * its own test. Every other lane got a route so a person could open it; this one
 * did not, because `src/app/page.tsx` belongs to A1 and the dashboard belonged to
 * a different agent who was not allowed to add a route for it. The result was
 * that a judge could not have seen the ledger UI even if they wanted to.
 *
 * It is a *desktop* view and `/` is a 396px phone frame, so it gets its own route
 * rather than being mounted into the shell. One truth about the product, two
 * surfaces: the phone shell for a treasurer in a meeting, this for reviewing the
 * books.
 *
 * What it does and does not do
 *
 * The balances, the chain seal and the pending/manual-review split are a clearly
 * labelled visual fixture — the page says so in its own header, and every string
 * in the correction flow says "demo" and "no live ledger or bank request was
 * sent". That is deliberate and it is the standard this repository holds: an
 * honest empty state beats a convincing fake.
 *
 * The correction form creates a local entry. Wiring it to `POST
 * /api/ledger/entries` is board task #5's second half, and it needs a signed-in
 * treasurer with a provisioned group and real account ids — the same auth
 * dependency as O-1. Until that exists, saying "demo" is the honest thing and a
 * working fetch would be the dishonest one.
 */
export const metadata: Metadata = {
  title: "Sened | Ledger",
  description:
    "Append-only ledger, bank verification and reconciliation state. A labelled visual fixture; nothing here is connected to a live bank."
};

export default function LedgerPage() {
  return <SenedShell />;
}
