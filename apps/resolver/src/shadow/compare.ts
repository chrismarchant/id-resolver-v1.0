/**
 * Comparison of the watch-only sources with the existing Enrich lookup for one
 * address, as the counters to increment. Pure and synchronous.
 *
 * The question it answers for the owner: would a waterfall (the cheaper
 * sources first, Enrich only when they cannot decide) have avoided this
 * Enrich call, and would it have agreed with Enrich?
 *
 * Business claims: a `business` verdict from ipapi.is or IPLocate (a company
 * domain), and Enrich's domain when the pipeline qualified it
 * (enrich resolved_business). Two claims name the same domain when their
 * canonical forms are equal or one is a subdomain of the other.
 *
 * Vetoes: hosting, anonymous or mobile from either API source, or a match in
 * the published cloud and crawler ranges (HOSTING_RANGES_MODE=shadow).
 *
 * Exactly one waterfall verdict per address, decided in this order:
 *   conflict      a business claim and a veto, or business claims that name
 *                 different domains;
 *   vetoed        a veto and no business claim;
 *   high          two or more claims name the same domain (at least one from
 *                 ipapi.is or IPLocate);
 *   medium        exactly one claim, from ipapi.is or IPLocate;
 *   no_data       ipapi.is and IPLocate failed (error, timeout, quota, auth or
 *                 not configured) and IPNetDB is unavailable or disabled;
 *   inconclusive  otherwise: isp, none or business_no_domain only, the case
 *                 where Enrich would still be needed. Enrich's own claim alone
 *                 lands here (or in no_data): the extra sources did not know.
 * enrich_call_avoidable for high, medium and vetoed; enrich_call_needed
 * otherwise. enrich_agrees / enrich_disagrees when Enrich's domain qualified
 * and ipapi.is or IPLocate named a business domain: agrees when every such
 * domain is the same as Enrich's.
 */
import { canonicaliseDomain } from "../resolution/qualify.js";
import { ipnetdbCorroborates, verdictName } from "./verdict.js";
import type { ApiVerdict, ApiVerdictName, EnrichCategory, EnrichSummary, IpnetdbResult, ShadowMetric, WaterfallVerdict } from "./types.js";

export { SHADOW_METRICS, type ShadowMetric } from "./types.js";

export interface CompareInput {
  ipapi: ApiVerdict;
  iplocate: ApiVerdict;
  ipnetdb: IpnetdbResult;
  /** The address is in a published cloud or crawler range (the pipeline's hosting-range match). */
  hostingRangeMatched: boolean;
  enrich: EnrichSummary;
}

export interface Comparison {
  waterfall: WaterfallVerdict;
  enrich: EnrichCategory;
  /** The counters to increment for this address, each once. */
  metrics: ShadowMetric[];
}

const VETO_VERDICTS: ReadonlySet<ApiVerdictName> = new Set(["hosting", "anonymous", "mobile"]);
const FAILED_VERDICTS: ReadonlySet<ApiVerdictName> = new Set(["error", "timeout", "quota", "auth", "disabled"]);

/** Equal canonical domains, or one a subdomain of the other (sales.example.com and example.com). */
export function sameDomain(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function enrichCategory(e: EnrichSummary): EnrichCategory {
  switch (e.kind) {
    case "resolved":
      return e.status === "qualified" ? "resolved_business" : "resolved_other";
    case "no_domain":
      return "no_domain";
    case "error":
      return "error";
    case "timeout":
      return "timeout";
    default:
      return "not_called";
  }
}

const allSame = (domains: readonly string[]): boolean => domains.every((a, i) => domains.every((b, j) => j <= i || sameDomain(a, b)));

export function compare(input: CompareInput): Comparison {
  const { ipapi, iplocate, ipnetdb, hostingRangeMatched, enrich } = input;
  const metrics: ShadowMetric[] = ["observed", `ipapi_${ipapi.verdict}`, `iplocate_${iplocate.verdict}`, `ipnetdb_${ipnetdb.verdict}`];

  const enrichName = enrich.kind === "resolved" ? (enrich.organisationName ?? null) : null;
  if (ipnetdbCorroborates(ipnetdb, [verdictName(ipapi), verdictName(iplocate), enrichName])) metrics.push("ipnetdb_corroborates");
  if (hostingRangeMatched) metrics.push("hosting_range_matched");

  const category = enrichCategory(enrich);
  metrics.push(`enrich_${category}`);

  const shadowClaims = [ipapi, iplocate].flatMap((v) => (v.verdict === "business" ? [v.domain] : []));
  const enrichClaim = category === "resolved_business" && enrich.kind === "resolved" ? canonicaliseDomain(enrich.domain) : null;
  const claims = enrichClaim !== null ? [...shadowClaims, enrichClaim] : shadowClaims;
  const veto = VETO_VERDICTS.has(ipapi.verdict) || VETO_VERDICTS.has(iplocate.verdict) || hostingRangeMatched;

  let waterfall: WaterfallVerdict;
  if (claims.length > 0 && (veto || !allSame(claims))) waterfall = "conflict";
  else if (veto) waterfall = "vetoed";
  else if (shadowClaims.length > 0) waterfall = claims.length >= 2 ? "high" : "medium";
  else if (FAILED_VERDICTS.has(ipapi.verdict) && FAILED_VERDICTS.has(iplocate.verdict) && (ipnetdb.verdict === "unavailable" || ipnetdb.verdict === "disabled")) {
    waterfall = "no_data";
  } else waterfall = "inconclusive";
  metrics.push(`waterfall_${waterfall}`);
  metrics.push(waterfall === "high" || waterfall === "medium" || waterfall === "vetoed" ? "enrich_call_avoidable" : "enrich_call_needed");

  if (enrichClaim !== null && shadowClaims.length > 0) {
    metrics.push(shadowClaims.every((d) => sameDomain(d, enrichClaim)) ? "enrich_agrees" : "enrich_disagrees");
  }
  return { waterfall, enrich: category, metrics };
}
