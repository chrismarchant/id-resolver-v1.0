/**
 * Verdicts (src/shadow/verdict.ts) and the comparison (src/shadow/compare.ts):
 * veto precedence, every waterfall verdict, Enrich agreement, IPNetDB
 * corroboration and the closed metric allowlist. Pure functions; example
 * domains and names only.
 */
import { describe, expect, it } from "vitest";
import { compare, enrichCategory, sameDomain } from "../../src/shadow/compare.js";
import {
  API_VERDICTS,
  ENRICH_CATEGORIES,
  IPNETDB_VERDICTS,
  METRIC_PATTERN,
  SHADOW_METRICS,
  WATERFALL_VERDICTS,
  type ApiSignals,
  type ApiVerdict,
  type EnrichSummary,
  type IpnetdbResult,
} from "../../src/shadow/types.js";
import { apiVerdict, ipnetdbCorroborates } from "../../src/shadow/verdict.js";

const signals = (s: Partial<ApiSignals> = {}): ApiSignals => ({
  companyName: "Example Corp Ltd",
  companyDomain: "example.com",
  companyType: "business",
  asnType: "isp",
  mobile: false,
  hosting: false,
  anonymous: false,
  ...s,
});
const ok = (s: Partial<ApiSignals> = {}) => ({ kind: "ok" as const, signals: signals(s) });

describe("apiVerdict", () => {
  it.each([
    ["business with a domain", ok(), "business"],
    ["education", ok({ companyType: "education", companyDomain: "example.edu" }), "business"],
    ["government", ok({ companyType: "government", companyDomain: "example.gov" }), "business"],
    ["banking", ok({ companyType: "banking", companyDomain: "bank.example" }), "business"],
    ["business without a domain", ok({ companyDomain: null }), "business_no_domain"],
    ["business with an implausible domain", ok({ companyDomain: "192.0.2.1" }), "business_no_domain"],
    ["isp company", ok({ companyType: "isp" }), "isp"],
    ["hosting company", ok({ companyType: "hosting" }), "hosting"],
    ["unknown company type", ok({ companyType: "other" }), "none"],
    ["no company, isp ASN", ok({ companyType: null, companyName: null, companyDomain: null, asnType: "isp" }), "isp"],
    ["no company, hosting ASN", ok({ companyType: null, companyName: null, companyDomain: null, asnType: "hosting" }), "hosting"],
    ["no company, business ASN", ok({ companyType: null, companyName: null, companyDomain: null, asnType: "business" }), "none"],
    ["no company, no ASN", ok({ companyType: null, companyName: null, companyDomain: null, asnType: null }), "none"],
    ["a business company on a hosting ASN is still a business", ok({ asnType: "hosting" }), "business"],
    // Veto precedence: anonymous > hosting > mobile, before the company type.
    ["data centre flag over business", ok({ hosting: true }), "hosting"],
    ["mobile flag over business", ok({ mobile: true }), "mobile"],
    ["anonymous over business", ok({ anonymous: true }), "anonymous"],
    ["anonymous over hosting and mobile", ok({ anonymous: true, hosting: true, mobile: true }), "anonymous"],
    ["hosting over mobile", ok({ hosting: true, mobile: true }), "hosting"],
    ["hosting company type over mobile", ok({ companyType: "hosting", mobile: true }), "hosting"],
    ["mobile over isp", ok({ companyType: "isp", mobile: true }), "mobile"],
  ])("%s -> %s", (_label, outcome, verdict) => {
    expect(apiVerdict(outcome).verdict).toBe(verdict);
  });

  it("keeps the canonical domain and the name in memory for the comparison", () => {
    expect(apiVerdict(ok({ companyDomain: "WWW.Example.COM" }))).toEqual({ verdict: "business", domain: "example.com", name: "Example Corp Ltd" });
    expect(apiVerdict(ok({ companyType: "isp", companyName: "Example Broadband" }))).toEqual({ verdict: "isp", name: "Example Broadband" });
  });

  it.each(["auth", "quota", "error", "timeout"] as const)("%s passes through; null is disabled", (kind) => {
    expect(apiVerdict({ kind })).toEqual({ verdict: kind });
    expect(apiVerdict(null)).toEqual({ verdict: "disabled" });
  });
});

describe("ipnetdbCorroborates", () => {
  const found: IpnetdbResult = { verdict: "found", prefixEntity: "Example Corp Limited", asEntity: "Example Transit Inc", asn: 64496 };
  it("matches the prefix or AS entity against any named company (sameOrganisation)", () => {
    expect(ipnetdbCorroborates(found, ["EXAMPLE CORP LTD"])).toBe(true);
    expect(ipnetdbCorroborates(found, [null, "Example Transit, Inc."])).toBe(true);
    expect(ipnetdbCorroborates(found, ["Example Holdings"])).toBe(false);
    expect(ipnetdbCorroborates(found, [null, undefined, ""])).toBe(false);
    expect(ipnetdbCorroborates({ verdict: "not_found" }, ["Example Corp Ltd"])).toBe(false);
    expect(ipnetdbCorroborates({ verdict: "found", prefixEntity: null, asEntity: null, asn: null }, ["Example Corp Ltd"])).toBe(false);
  });
});

describe("compare", () => {
  const biz = (domain: string, name: string | null = "Example Corp Ltd"): ApiVerdict => ({ verdict: "business", domain, name });
  const v = (verdict: Exclude<ApiVerdict["verdict"], "business">, name: string | null = null): ApiVerdict =>
    ["error", "timeout", "quota", "auth", "disabled"].includes(verdict) ? ({ verdict } as ApiVerdict) : ({ verdict, name } as ApiVerdict);
  const qualified = (domain: string, organisationName: string | null = null): EnrichSummary => ({ kind: "resolved", domain, usageType: "COM", status: "qualified", organisationName });
  const NO_DOMAIN: EnrichSummary = { kind: "no_domain" };
  const NOT_CALLED: EnrichSummary = { kind: "not_called", reason: "provider_disabled" };
  const FOUND: IpnetdbResult = { verdict: "found", prefixEntity: "Example Network Services", asEntity: "Example Network Services", asn: 64496 };
  const NONE: IpnetdbResult = { verdict: "not_found" };

  type Row = [label: string, ipapi: ApiVerdict, iplocate: ApiVerdict, ipnetdb: IpnetdbResult, hostingRange: boolean, enrich: EnrichSummary, waterfall: string, extra: string[]];
  const rows: Row[] = [
    // high: two or more claims name the same domain
    ["both API sources agree", biz("example.com"), biz("example.com"), NONE, false, NO_DOMAIN, "high", ["enrich_call_avoidable"]],
    ["API source and Enrich agree", biz("example.com"), v("isp"), NONE, false, qualified("example.com"), "high", ["enrich_call_avoidable", "enrich_agrees"]],
    ["subdomain counts as the same", biz("sales.example.com"), biz("example.com"), NONE, false, qualified("example.com"), "high", ["enrich_call_avoidable", "enrich_agrees"]],
    // medium: one claim, from an API source
    ["one API source names a business", biz("example.com"), v("none"), NONE, false, NO_DOMAIN, "medium", ["enrich_call_avoidable"]],
    ["one business, the other isp", v("isp"), biz("example.org"), NONE, false, NOT_CALLED, "medium", ["enrich_call_avoidable"]],
    ["one business, the other failed", biz("example.com"), v("timeout"), { verdict: "unavailable" }, false, NO_DOMAIN, "medium", ["enrich_call_avoidable"]],
    ["one business, the other without a domain", biz("example.com"), v("business_no_domain", "Example Corp"), NONE, false, NO_DOMAIN, "medium", ["enrich_call_avoidable"]],
    // vetoed: a veto and no business claim
    ["hosting", v("hosting"), v("isp"), NONE, false, NO_DOMAIN, "vetoed", ["enrich_call_avoidable"]],
    ["anonymous", v("none"), v("anonymous"), NONE, false, NO_DOMAIN, "vetoed", ["enrich_call_avoidable"]],
    ["mobile", v("mobile"), v("isp"), NONE, false, NOT_CALLED, "vetoed", ["enrich_call_avoidable"]],
    ["published hosting range", v("error"), v("quota"), { verdict: "unavailable" }, true, NO_DOMAIN, "vetoed", ["enrich_call_avoidable", "hosting_range_matched"]],
    ["veto with an unqualified Enrich domain", v("hosting"), v("hosting"), NONE, false, { kind: "resolved", domain: "example.net", usageType: "DCH", status: "excluded" }, "vetoed", ["enrich_call_avoidable"]],
    // conflict: claims disagree, or a claim and a veto
    ["API sources name different domains", biz("example.com"), biz("example.org"), NONE, false, NO_DOMAIN, "conflict", ["enrich_call_needed"]],
    ["API source and Enrich disagree", biz("example.com"), v("none"), NONE, false, qualified("example.org"), "conflict", ["enrich_call_needed", "enrich_disagrees"]],
    ["business and hosting", biz("example.com"), v("hosting"), NONE, false, NO_DOMAIN, "conflict", ["enrich_call_needed"]],
    ["business and anonymous", v("anonymous"), biz("example.com"), NONE, false, NO_DOMAIN, "conflict", ["enrich_call_needed"]],
    ["business and mobile", biz("example.com"), v("mobile"), NONE, false, NO_DOMAIN, "conflict", ["enrich_call_needed"]],
    ["business in a published hosting range", biz("example.com"), v("none"), NONE, true, NO_DOMAIN, "conflict", ["enrich_call_needed", "hosting_range_matched"]],
    ["Enrich business vetoed by an API source", v("hosting"), v("isp"), NONE, false, qualified("example.com"), "conflict", ["enrich_call_needed"]],
    ["three claims, one disagrees", biz("example.com"), biz("example.com"), NONE, false, qualified("example.org"), "conflict", ["enrich_call_needed", "enrich_disagrees"]],
    // inconclusive: no veto, no business (Enrich still needed)
    ["isp and none", v("isp"), v("none"), NONE, false, NO_DOMAIN, "inconclusive", ["enrich_call_needed"]],
    ["business without a domain", v("business_no_domain", "Example Corp"), v("isp"), FOUND, false, NO_DOMAIN, "inconclusive", ["enrich_call_needed"]],
    ["only Enrich knows the business", v("isp"), v("none"), NONE, false, qualified("example.com"), "inconclusive", ["enrich_call_needed"]],
    ["API sources failed but IPNetDB answered", v("error"), v("auth"), FOUND, false, NO_DOMAIN, "inconclusive", ["enrich_call_needed"]],
    ["API sources failed, IPNetDB found nothing", v("timeout"), v("disabled"), NONE, false, NO_DOMAIN, "inconclusive", ["enrich_call_needed"]],
    // no_data: every extra source failed
    ["everything failed", v("error"), v("timeout"), { verdict: "unavailable" }, false, NO_DOMAIN, "no_data", ["enrich_call_needed"]],
    ["quota, auth and disabled", v("quota"), v("auth"), { verdict: "disabled" }, false, { kind: "error", category: "server" }, "no_data", ["enrich_call_needed"]],
    ["only Enrich answered", v("disabled"), v("disabled"), { verdict: "disabled" }, false, qualified("example.com"), "no_data", ["enrich_call_needed"]],
  ];

  it.each(rows)("%s -> waterfall_%s", (_label, ipapi, iplocate, ipnetdb, hostingRangeMatched, enrich, waterfall, extra) => {
    const c = compare({ ipapi, iplocate, ipnetdb, hostingRangeMatched, enrich });
    expect(c.waterfall).toBe(waterfall);
    expect(c.metrics).toContain(`waterfall_${waterfall}`);
    expect(c.metrics.filter((m) => m.startsWith("waterfall_"))).toHaveLength(1);
    expect(c.metrics.filter((m) => m === "enrich_call_avoidable" || m === "enrich_call_needed")).toHaveLength(1);
    for (const m of extra) expect(c.metrics).toContain(m);
    for (const m of ["enrich_agrees", "enrich_disagrees", "hosting_range_matched"]) if (!extra.includes(m)) expect(c.metrics).not.toContain(m);
    expect(c.metrics[0]).toBe("observed");
    expect(c.metrics).toContain(`ipapi_${ipapi.verdict}`);
    expect(c.metrics).toContain(`iplocate_${iplocate.verdict}`);
    expect(c.metrics).toContain(`ipnetdb_${ipnetdb.verdict}`);
    expect(c.metrics).toContain(`enrich_${enrichCategory(enrich)}`);
    expect(new Set(c.metrics).size).toBe(c.metrics.length);
    for (const m of c.metrics) expect(SHADOW_METRICS).toContain(m);
  });

  it("covers every waterfall verdict", () => {
    expect(new Set(rows.map((r) => r[6]))).toEqual(new Set(WATERFALL_VERDICTS));
  });

  it("Enrich categories: qualified is resolved_business; any other resolved status is resolved_other", () => {
    expect(enrichCategory(qualified("example.com"))).toBe("resolved_business");
    for (const status of ["excluded", "unknown"] as const) expect(enrichCategory({ kind: "resolved", domain: "example.com", usageType: "ISP", status })).toBe("resolved_other");
    expect(enrichCategory(NO_DOMAIN)).toBe("no_domain");
    expect(enrichCategory({ kind: "error", category: "auth" })).toBe("error");
    expect(enrichCategory({ kind: "timeout" })).toBe("timeout");
    for (const reason of ["provider_disabled", "kill_switch", "cap_exhausted", "deadline_exceeded", "database_error", "internal_error", "unknown"] as const) {
      expect(enrichCategory({ kind: "not_called", reason })).toBe("not_called");
    }
  });

  it("counts IPNetDB corroboration against names from ipapi.is, IPLocate or Enrich", () => {
    const base = { ipnetdb: FOUND, hostingRangeMatched: false };
    expect(compare({ ...base, ipapi: v("isp", "Example Network Services Ltd"), iplocate: v("none"), enrich: NO_DOMAIN }).metrics).toContain("ipnetdb_corroborates");
    expect(compare({ ...base, ipapi: v("error"), iplocate: biz("example.com", "Example Network Services"), enrich: NO_DOMAIN }).metrics).toContain("ipnetdb_corroborates");
    expect(compare({ ...base, ipapi: v("error"), iplocate: v("error"), enrich: qualified("example.com", "EXAMPLE NETWORK SERVICES LIMITED") }).metrics).toContain("ipnetdb_corroborates");
    expect(compare({ ...base, ipapi: biz("example.com", "Other Example Group"), iplocate: v("none"), enrich: NO_DOMAIN }).metrics).not.toContain("ipnetdb_corroborates");
    expect(compare({ ...base, ipnetdb: NONE, ipapi: v("isp", "Example Network Services"), iplocate: v("none"), enrich: NO_DOMAIN }).metrics).not.toContain("ipnetdb_corroborates");
  });

  it("sameDomain: equal, or one a subdomain of the other, never a mere suffix", () => {
    expect(sameDomain("example.com", "example.com")).toBe(true);
    expect(sameDomain("a.example.com", "example.com")).toBe(true);
    expect(sameDomain("example.com", "a.b.example.com")).toBe(true);
    expect(sameDomain("badexample.com", "example.com")).toBe(false);
    expect(sameDomain("example.com", "example.org")).toBe(false);
  });

  it("subdomains of one domain that are not related to each other disagree", () => {
    const c = compare({ ipapi: biz("a.example.com"), iplocate: biz("b.example.com"), ipnetdb: NONE, hostingRangeMatched: false, enrich: NO_DOMAIN });
    expect(c.waterfall).toBe("conflict");
  });
});

describe("metric allowlist", () => {
  it("every name matches the table's CHECK and is unique", () => {
    for (const m of SHADOW_METRICS) expect(m).toMatch(METRIC_PATTERN);
    expect(new Set(SHADOW_METRICS).size).toBe(SHADOW_METRICS.length);
  });

  it("holds exactly the per-source verdicts, comparison counters and runner counters", () => {
    const expected = [
      "observed",
      "ipapi_requests",
      "iplocate_requests",
      ...API_VERDICTS.map((v) => `ipapi_${v}`),
      ...API_VERDICTS.map((v) => `iplocate_${v}`),
      ...IPNETDB_VERDICTS.map((v) => `ipnetdb_${v}`),
      "ipnetdb_corroborates",
      "hosting_range_matched",
      ...ENRICH_CATEGORIES.map((c) => `enrich_${c}`),
      ...WATERFALL_VERDICTS.map((w) => `waterfall_${w}`),
      "enrich_call_avoidable",
      "enrich_call_needed",
      "enrich_agrees",
      "enrich_disagrees",
      "dropped_overload",
      "dropped_duplicate",
    ];
    expect([...SHADOW_METRICS].sort()).toEqual(expected.sort());
  });
});
