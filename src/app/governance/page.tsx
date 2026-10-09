"use client";

import React, { useState } from "react";

import { AppHeader, LanguageSwitch } from "@/components/ui/AppHeader";
import { BottomNav } from "@/components/ui/BottomNav";
import { Button, Card, Screen } from "@/components/ui/primitives";
import { FIELD_CLASS } from "@/components/ui/SimpleScreen";
import { CITATION_CATALOGUE } from "@/lib/governance/citations";
import { recommendGovernance } from "@/lib/governance/engine";
import { ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import type { GovernanceInput, GovernanceRecommendation, GroupType, TrustLevel } from "@/lib/governance/types";
import { useT } from "@/lib/ui/useT";

const TRUST: readonly TrustLevel[] = ["close", "mixed", "new"];

function amount(raw: string, allowZero: boolean): string | null {
  const v = raw.trim();
  if (!ETB_DECIMAL_PATTERN.test(v)) return null;
  const [w, f = ""] = v.split(".");
  const c = `${w}.${(f + "00").slice(0, 2)}`;
  return !allowZero && c === "0.00" ? null : c;
}
function whole(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/**
 * `/governance`: advisory bylaw clauses for an Equb or Iddir. Computed on this
 * device by the deterministic governance engine; nothing is saved and nothing
 * reaches the ledger.
 */
export default function GovernancePage() {
  const { t } = useT();
  const [type, setType] = useState<GroupType>("equb");
  const [members, setMembers] = useState("");
  const [contribution, setContribution] = useState("");
  const [days, setDays] = useState("");
  const [trust, setTrust] = useState<TrustLevel>("close");
  const [claim, setClaim] = useState("");
  const [fund, setFund] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GovernanceRecommendation | null>(null);

  const build = (): GovernanceInput | string => {
    const m = whole(members, 2, 500);
    const d = whole(days, 1, 366);
    const c = amount(contribution, false);
    if (m === null) return t("governance.error.memberCount");
    if (c === null) return t("governance.error.amount");
    if (d === null) return t("governance.error.cycleLength");
    const base = { groupType: type, memberCount: m, contributionAmount: c, cycleLengthDays: d, trust };
    if (type === "equb") return base;
    const tc = amount(claim, false);
    const fb = amount(fund, true);
    if (tc === null) return t("governance.error.amount");
    if (fb === null) return t("governance.error.balance");
    return { ...base, typicalClaimAmount: tc, currentFundBalance: fb };
  };
  const run = (): boolean => {
    setError(null);
    const input = build();
    if (typeof input === "string") {
      setError(input);
      return false;
    }
    try {
      setResult(recommendGovernance(input));
      return true;
    } catch {
      setError(t("governance.error.engine"));
      return false;
    }
  };
  const field = (label: string, hint: string, value: string, set: (v: string) => void, inputMode: "numeric" | "decimal") => (
    <label className="flex flex-col gap-1.5">
      <span lang="am" className="text-sm font-bold text-soft">
        {label}
      </span>
      <input value={value} onChange={(e) => set(e.target.value)} inputMode={inputMode} className={FIELD_CLASS} />
      <span className="text-xs text-muted">{hint}</span>
    </label>
  );

  return (
    <Screen>
      <main className="flex grow flex-col">
        <AppHeader title={t("governance.eyebrow")} subtitle="Bylaws" bottom={72} ribbon={32} right={<LanguageSwitch />} />
        <Card className="snd-rise flex flex-col gap-4 p-5" style={{ margin: "-34px 16px 0" }}>
          <p lang="am" className="m-0 rounded-2xl bg-hair2 px-3.5 py-3 text-sm leading-[1.5] text-soft">
            {t("governance.advisory")}
          </p>
          <div className="flex flex-col gap-2">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("governance.q.groupType")}
            </span>
            <div className="grid grid-cols-2 gap-3">
              {(["equb", "iddir"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={type === g}
                  onClick={() => setType(g)}
                  lang="am"
                  className="h-12 rounded-3xl text-base font-bold"
                  style={type === g ? { background: "var(--prim)", color: "var(--primt)", border: "none" } : { background: "var(--card)", color: "var(--ink)", border: "1.5px solid var(--chipb)" }}
                >
                  {t(g === "equb" ? "governance.option.equb" : "governance.option.iddir")}
                </button>
              ))}
            </div>
          </div>
          {field(t("governance.q.memberCount"), t("governance.q.memberCount.hint"), members, setMembers, "numeric")}
          {field(t("governance.q.contribution"), t("governance.q.contribution.hint"), contribution, setContribution, "decimal")}
          {field(t("governance.q.cycleLength"), t("governance.q.cycleLength.hint"), days, setDays, "numeric")}
          <div className="flex flex-col gap-2">
            <span lang="am" className="text-sm font-bold text-soft">
              {t("governance.q.trust")}
            </span>
            <div className="grid grid-cols-3 gap-2">
              {TRUST.map((x) => (
                <button
                  key={x}
                  type="button"
                  aria-pressed={trust === x}
                  onClick={() => setTrust(x)}
                  lang="am"
                  className="h-11 rounded-3xl text-[15px] font-bold"
                  style={trust === x ? { background: "var(--prim)", color: "var(--primt)", border: "none" } : { background: "var(--card)", color: "var(--ink)", border: "1.5px solid var(--chipb)" }}
                >
                  {t(`governance.trust.${x}` as "governance.trust.close")}
                </button>
              ))}
            </div>
          </div>
          {type === "iddir" ? (
            <>
              {field(t("governance.q.typicalClaim"), t("governance.q.typicalClaim.hint"), claim, setClaim, "decimal")}
              {field(t("governance.q.fundBalance"), t("governance.q.fundBalance.hint"), fund, setFund, "decimal")}
            </>
          ) : null}
          {error ? (
            <p role="alert" lang="am" className="m-0 text-sm font-bold" style={{ color: "var(--dng)" }}>
              {error}
            </p>
          ) : null}
          <Button onPress={run} errorLabel={t("ui.tryAgain")}>
            {t("governance.seeResults")}
          </Button>
        </Card>

        {result ? (
          <section className="mx-4 mt-5 flex flex-col gap-3" aria-label={t("governance.results.title")} data-testid="governance-results">
            <h2 lang="am" className="mx-1 my-0 font-serif text-[25px] font-bold">
              {t("governance.results.title")}
            </h2>
            {result.warnings.map((w) => (
              <p key={w.code} lang="am" role="note" className="m-0 rounded-2xl px-4 py-3 text-sm font-bold leading-[1.5]" style={{ background: "var(--chipcol-bg)", color: "var(--chipcol)" }}>
                {t(w.messageKey, w.vars)}
              </p>
            ))}
            {result.clauses.map((c) => (
              <Card key={c.id} className="flex flex-col gap-2 p-5">
                <span lang="am" className="text-xs font-bold text-muted">
                  {t(`governance.topic.${c.topic}` as "governance.topic.late_payment")}
                </span>
                <h3 lang="am" className="m-0 font-serif text-lg font-bold">
                  {t(c.titleKey)}
                </h3>
                <p lang="am" className="m-0 text-base leading-[1.55]">
                  {t(c.summaryKey, c.vars)}
                </p>
                <p lang="am" className="m-0 text-sm leading-[1.5] text-muted">
                  {t(c.rationaleKey, c.vars)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {c.citations.map((id) => (
                    <a key={id} href={CITATION_CATALOGUE[id].url ?? undefined} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-2xl border border-hair bg-bg px-3 text-xs font-bold">
                      {CITATION_CATALOGUE[id].label}
                    </a>
                  ))}
                </div>
              </Card>
            ))}
            <p lang="am" className="m-0 px-1 text-sm leading-[1.5] text-muted">
              {t("governance.results.disclaimer")}
            </p>
          </section>
        ) : null}
        <div style={{ height: 28 }} />
      </main>
      <BottomNav active={null} />
    </Screen>
  );
}
