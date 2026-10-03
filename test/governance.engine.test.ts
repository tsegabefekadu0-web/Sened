import { describe, expect, it } from "vitest";

import { CITATION_CATALOGUE, CITATION_IDS, SCHOLARXIV_COLLECTION_ID, listCitations } from "@/lib/governance/citations";
import {
  CLAIM_WAITING_DAYS_BY_TRUST,
  EQUB_PENALTY_BPS_BY_TRUST,
  IDDIR_PENALTY_BPS_BY_TRUST,
  RESERVE_BPS_BY_TRUST,
  formatBps,
  recommendGovernance
} from "@/lib/governance/engine";
import { GovernanceError } from "@/lib/governance/errors";
import { PARAMETER_KEYS, type BylawClause, type GovernanceInput } from "@/lib/governance/types";
import { dictionaries } from "@/lib/i18n";
import { planReserve } from "@/lib/draw/risk";

const equb: GovernanceInput = {
  groupType: "equb",
  memberCount: 12,
  contributionAmount: "1000.00",
  cycleLengthDays: 30,
  trust: "mixed"
};

const iddir: GovernanceInput = {
  groupType: "iddir",
  memberCount: 40,
  contributionAmount: "100.00",
  cycleLengthDays: 30,
  trust: "close",
  typicalClaimAmount: "20000.00",
  currentFundBalance: "5000.00"
};

function clause(input: GovernanceInput, id: BylawClause["id"]): BylawClause {
  const found = recommendGovernance(input).clauses.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`no clause ${id}`);
  }
  return found;
}

function param(c: BylawClause, key: string): string | number {
  const found = c.parameters.find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`no parameter ${key}`);
  }
  return found.value;
}

describe("citation catalogue", () => {
  it("contains exactly the README references with their real arXiv ids", () => {
    expect(CITATION_IDS).toHaveLength(6);
    expect(CITATION_CATALOGUE.abebe2022.arxivId).toBe("2203.12486");
    expect(CITATION_CATALOGUE.wang2021.arxivId).toBe("2204.12374");
    expect(CITATION_CATALOGUE.sowon2023.arxivId).toBe("2309.00226");
    expect(CITATION_CATALOGUE.kester2013.arxivId).toBe("1307.7789");
    expect(CITATION_CATALOGUE.dercon2006.arxivId).toBeNull();
    expect(CITATION_CATALOGUE.besley1993.arxivId).toBeNull();
    expect(SCHOLARXIV_COLLECTION_ID).toBe("6aaf5269f7a1121dbd049897");
  });

  it("links arXiv papers to arxiv.org and gives journal articles no link", () => {
    for (const citation of listCitations()) {
      expect(citation.url).toBe(citation.arxivId === null ? null : `https://arxiv.org/abs/${citation.arxivId}`);
    }
  });

  it("has an aligned finding string for every paper in both languages", () => {
    for (const id of CITATION_IDS) {
      const key = `governance.cite.${id}.finding` as keyof typeof dictionaries.en;
      expect(dictionaries.en[key]).toBeTruthy();
      expect(dictionaries.am[key]).toBeTruthy();
    }
  });
});

describe("equb recommendations", () => {
  it("produces late, replacement and default-protection clauses, and no iddir clauses", () => {
    const result = recommendGovernance(equb);
    expect(result.advisoryOnly).toBe(true);
    expect(result.clauses.map((entry) => entry.id)).toEqual(["late.equb", "replacement.equb", "default.reserve"]);
  });

  it("is deterministic", () => {
    expect(recommendGovernance(equb)).toEqual(recommendGovernance({ ...equb }));
  });

  it("sizes the late penalty from trust, in exact minor units", () => {
    const late = clause(equb, "late.equb");
    expect(param(late, "penaltyBps")).toBe(EQUB_PENALTY_BPS_BY_TRUST.mixed);
    expect(param(late, "penaltyAmount")).toBe("30.00"); // 3% of 1000.00
    expect(param(late, "graceDays")).toBe(3); // ceil(30/10)
    expect(param(late, "suspendAfterMissed")).toBe(2);
    expect(late.citations).toEqual(["besley1993", "abebe2022"]);
  });

  it("scales penalties up as familiarity falls", () => {
    const bps = (trust: GovernanceInput["trust"]) => param(clause({ ...equb, trust }, "late.equb"), "penaltyBps");
    expect([bps("close"), bps("mixed"), bps("new")]).toEqual([200, 300, 500]);
  });

  it("clamps the grace period between 1 and 5 days", () => {
    const grace = (cycleLengthDays: number) => param(clause({ ...equb, cycleLengthDays }, "late.equb"), "graceDays");
    expect(grace(1)).toBe(1);
    expect(grace(7)).toBe(1);
    expect(grace(14)).toBe(2);
    expect(grace(366)).toBe(5);
  });

  it("rounds a tiny penalty down rather than inventing cents", () => {
    const late = clause({ ...equb, contributionAmount: "0.50", trust: "close" }, "late.equb");
    expect(param(late, "penaltyAmount")).toBe("0.01"); // 2% of 0.50
  });

  it("requires more vouchers and a larger vote from newer groups, never more than members-1", () => {
    expect(param(clause({ ...equb, trust: "close" }, "replacement.equb"), "voucherCount")).toBe(1);
    expect(param(clause({ ...equb, trust: "new" }, "replacement.equb"), "voucherCount")).toBe(2);
    expect(param(clause({ ...equb, trust: "new", memberCount: 2 }, "replacement.equb"), "voucherCount")).toBe(1);
    expect(param(clause({ ...equb, trust: "new" }, "replacement.equb"), "voteThresholdBps")).toBe(7500);
    expect(param(clause(equb, "replacement.equb"), "maxOutstandingAmount")).toBe("11000.00");
  });

  it("ties the default reserve to the draw risk model", () => {
    const reserve = clause(equb, "default.reserve");
    const plan = planReserve({
      drawId: "x",
      round: 1,
      potAmount: "12000.00",
      reserveRatioBps: RESERVE_BPS_BY_TRUST.mixed,
      totalRounds: 12,
      contributionAmount: "1000.00",
      eligibleCount: 12
    });
    expect(param(reserve, "round1ReserveAmount")).toBe("3999.60"); // capped at 3333 bps of 12000.00
    expect(plan.capped).toBe(true);
    expect(Number(param(reserve, "round1ReserveAmount")) * 100).toBe(Number(plan.reserveMinor));
    expect(Number(param(reserve, "round1PayoutAmount")) * 100).toBe(Number(plan.payoutMinor));
    expect(param(reserve, "worstCaseExposure")).toBe("11000.00");
    // Round 8 owes 4 x 1000.00 = 4000.00, just over the 3999.60 ceiling
    // (3333 bps, not exactly a third), so it is still capped; round 9 is not.
    expect(param(reserve, "guarantorThroughRound")).toBe(8);
    expect(reserve.citations).toEqual(["abebe2022", "besley1993"]);
  });

  it("warns that guarantors are needed when the reserve cap binds", () => {
    const result = recommendGovernance(equb);
    expect(result.warnings.map((entry) => entry.code)).toContain("GUARANTOR_NEEDED");
  });

  it("flags a very small group and a long cycle", () => {
    const result = recommendGovernance({ ...equb, memberCount: 3, cycleLengthDays: 60 });
    const codes = result.warnings.map((entry) => entry.code);
    expect(codes).toContain("SMALL_GROUP");
    expect(codes).toContain("LONG_CYCLE");
  });

  it("handles the smallest group (two members)", () => {
    const result = recommendGovernance({ ...equb, memberCount: 2 });
    const reserve = result.clauses.find((entry) => entry.id === "default.reserve") as BylawClause;
    expect(param(reserve, "guarantorThroughRound")).toBe(1);
    expect(param(reserve, "worstCaseExposure")).toBe("1000.00");
  });

  it("handles the largest group and amount without overflow", () => {
    const result = recommendGovernance({
      ...equb,
      memberCount: 500,
      contributionAmount: "1000000000.00"
    });
    expect(result.clauses).toHaveLength(3);
  });

  it("keeps the reserve ratio below the draw engine's ceiling for every trust level", () => {
    for (const trust of ["close", "mixed", "new"] as const) {
      expect(RESERVE_BPS_BY_TRUST[trust]).toBeLessThan(3333);
    }
  });

  it("lists distinct citations in first-use order", () => {
    expect(recommendGovernance(equb).citations).toEqual(["besley1993", "abebe2022", "wang2021"]);
  });
});

describe("iddir recommendations", () => {
  it("produces late, transfer and emergency-fund clauses, and no equb clauses", () => {
    expect(recommendGovernance(iddir).clauses.map((entry) => entry.id)).toEqual([
      "late.iddir",
      "replacement.iddir",
      "emergency.fund"
    ]);
  });

  it("uses gentler penalties than an equb", () => {
    for (const trust of ["close", "mixed", "new"] as const) {
      expect(IDDIR_PENALTY_BPS_BY_TRUST[trust]).toBeLessThan(EQUB_PENALTY_BPS_BY_TRUST[trust]);
    }
    const late = clause(iddir, "late.iddir");
    expect(param(late, "penaltyAmount")).toBe("1.00"); // 1% of 100.00
    expect(param(late, "claimsSuspendedAfterMissed")).toBe(3);
    expect(late.citations).toEqual(["dercon2006", "besley1993"]);
  });

  it("sizes the emergency fund from the typical claim and reports the shortfall", () => {
    const fund = clause(iddir, "emergency.fund");
    expect(param(fund, "reserveClaimsCovered")).toBe(2); // 40 households: 25-99
    expect(param(fund, "targetReserve")).toBe("40000.00");
    expect(param(fund, "fundingGap")).toBe("35000.00");
    expect(param(fund, "perCycleCollection")).toBe("4000.00");
    expect(param(fund, "cyclesToTarget")).toBe(9); // ceil(35000/4000)
    expect(param(fund, "medicalAdvanceAmount")).toBe("10000.00");
    expect(fund.citations).toEqual(["dercon2006"]);
  });

  it("holds more claims in reserve for small pools and fewer for large ones", () => {
    const claims = (memberCount: number) =>
      param(clause({ ...iddir, memberCount }, "emergency.fund"), "reserveClaimsCovered");
    expect(claims(10)).toBe(3);
    expect(claims(24)).toBe(3);
    expect(claims(25)).toBe(2);
    expect(claims(99)).toBe(2);
    expect(claims(100)).toBe(1);
  });

  it("needs no further cycles when the fund already meets the target", () => {
    const fund = clause({ ...iddir, currentFundBalance: "90000.00" }, "emergency.fund");
    expect(param(fund, "fundingGap")).toBe("0.00");
    expect(param(fund, "cyclesToTarget")).toBe(0);
  });

  it("treats a missing balance as zero", () => {
    const { currentFundBalance: _omit, ...rest } = iddir;
    void _omit;
    const fund = clause(rest, "emergency.fund");
    expect(param(fund, "currentBalance")).toBe("0.00");
    expect(param(fund, "fundingGap")).toBe("40000.00");
  });

  it("warns when the fund would take more than two years to fill", () => {
    const result = recommendGovernance({ ...iddir, contributionAmount: "1.00", currentFundBalance: "0.00" });
    expect(result.warnings.map((entry) => entry.code)).toContain("SLOW_FUND");
  });

  it("lengthens the claim waiting period for newer groups", () => {
    const waiting = (trust: GovernanceInput["trust"]) =>
      param(clause({ ...iddir, trust }, "replacement.iddir"), "claimWaitingDays");
    expect([waiting("close"), waiting("mixed"), waiting("new")]).toEqual([
      CLAIM_WAITING_DAYS_BY_TRUST.close,
      CLAIM_WAITING_DAYS_BY_TRUST.mixed,
      CLAIM_WAITING_DAYS_BY_TRUST.new
    ]);
  });
});

describe("input validation", () => {
  it.each([
    ["one member", { ...equb, memberCount: 1 }],
    ["501 members", { ...equb, memberCount: 501 }],
    ["fractional members", { ...equb, memberCount: 2.5 }],
    ["zero cycle", { ...equb, cycleLengthDays: 0 }],
    ["367-day cycle", { ...equb, cycleLengthDays: 367 }],
    ["zero contribution", { ...equb, contributionAmount: "0.00" }],
    ["malformed amount", { ...equb, contributionAmount: "abc" }],
    ["absurd amount", { ...equb, contributionAmount: "99999999999.00" }],
    ["unknown trust", { ...equb, trust: "bad" as never }],
    ["unknown group type", { ...equb, groupType: "other" as never }],
    ["equb with an iddir claim", { ...equb, typicalClaimAmount: "100.00" }],
    ["iddir with no claim", { ...iddir, typicalClaimAmount: undefined }],
    ["iddir with zero claim", { ...iddir, typicalClaimAmount: "0.00" }]
  ])("rejects %s", (_name, input) => {
    expect(() => recommendGovernance(input as GovernanceInput)).toThrow(GovernanceError);
  });
});

describe("every clause is fully translated", () => {
  const clauses = [
    ...recommendGovernance(equb).clauses,
    ...recommendGovernance(iddir).clauses
  ];

  it("has title, summary and rationale text in both languages without leftover placeholders", () => {
    for (const entry of clauses) {
      for (const locale of ["en", "am"] as const) {
        for (const key of [entry.titleKey, entry.summaryKey, entry.rationaleKey]) {
          const template = dictionaries[locale][key];
          expect(template.length).toBeGreaterThan(0);
          for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
            expect(entry.vars, `${entry.id}/${locale} uses {${name}}`).toHaveProperty(name);
          }
        }
      }
    }
  });

  it("has a label for every parameter", () => {
    for (const key of PARAMETER_KEYS) {
      const messageKey = `governance.param.${key}` as keyof typeof dictionaries.en;
      expect(dictionaries.en[messageKey]).toBeTruthy();
      expect(dictionaries.am[messageKey]).toBeTruthy();
    }
  });
});

describe("formatBps", () => {
  it("trims trailing zeros", () => {
    expect(formatBps(200)).toBe("2");
    expect(formatBps(250)).toBe("2.5");
    expect(formatBps(6667)).toBe("66.67");
  });
});
