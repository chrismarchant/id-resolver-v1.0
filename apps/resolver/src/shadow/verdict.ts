/**
 * Normalised verdicts for the watch-only source comparison. Pure.
 *
 * An API source's answer becomes exactly one verdict. Vetoes come first, in
 * this order, whatever the company type says: anonymous (VPN, proxy, Tor,
 * relay) > hosting (data centre, a hosting network, company type hosting) >
 * mobile. Then the company type: business, education, government or banking
 * with a domain canonicaliseDomain accepts is `business`, without one
 * `business_no_domain`; isp is `isp`; anything else (or no company) is `none`.
 * Without a company object the ASN type decides between isp, hosting and none.
 */
import { canonicaliseDomain, sameOrganisation } from "../resolution/qualify.js";
import type { ApiSourceOutcome, ApiVerdict, IpnetdbResult } from "./types.js";

/** Company types that name an organisation a visitor could work for. */
export const BUSINESS_COMPANY_TYPES: ReadonlySet<string> = new Set(["business", "education", "government", "banking"]);

/** The verdict for one API source's outcome; null = the source is not configured (`disabled`). */
export function apiVerdict(outcome: ApiSourceOutcome | null): ApiVerdict {
  if (outcome === null) return { verdict: "disabled" };
  if (outcome.kind !== "ok") return { verdict: outcome.kind };
  const s = outcome.signals;
  const name = s.companyName;
  const type = s.companyType;
  if (s.anonymous) return { verdict: "anonymous", name };
  if (s.hosting || type === "hosting" || (type === null && s.asnType === "hosting")) return { verdict: "hosting", name };
  if (s.mobile) return { verdict: "mobile", name };
  if (type !== null) {
    if (BUSINESS_COMPANY_TYPES.has(type)) {
      const domain = canonicaliseDomain(s.companyDomain);
      return domain !== null ? { verdict: "business", domain, name } : { verdict: "business_no_domain", name };
    }
    return { verdict: type === "isp" ? "isp" : "none", name };
  }
  return { verdict: s.asnType === "isp" ? "isp" : "none", name };
}

/** The company name a verdict carries (any non-error verdict), for IPNetDB corroboration. */
export function verdictName(v: ApiVerdict): string | null {
  return "name" in v ? v.name : null;
}

/** Whether IPNetDB's prefix or AS entity is the same organisation as any of `names` (sameOrganisation). */
export function ipnetdbCorroborates(result: IpnetdbResult, names: readonly (string | null | undefined)[]): boolean {
  if (result.verdict !== "found") return false;
  const entities = [result.prefixEntity, result.asEntity].filter((e): e is string => typeof e === "string" && e.length > 0);
  return names.some((n) => typeof n === "string" && n.length > 0 && entities.some((e) => sameOrganisation(e, n)));
}
