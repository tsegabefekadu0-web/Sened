import type { Metadata } from "next";

import { GovernanceWorkspace } from "@/components/governance/GovernanceWorkspace";
import { translate } from "@/lib/i18n";

export const metadata: Metadata = {
  title: translate("en", "governance.documentTitle"),
  description:
    "Recommended bylaw and penalty clauses for an Equb or Iddir, with citation tags linking to the research behind them. Advisory only."
};

/**
 * `GET /governance` — the M5 governance copilot. Advisory only: it never writes
 * to the ledger.
 */
export default function GovernancePage() {
  return <GovernanceWorkspace />;
}
