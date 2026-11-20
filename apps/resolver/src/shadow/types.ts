/**
 * Watch-only source comparison (SHADOW_SOURCES_MODE): shared types.
 *
 * Three extra IP-intelligence sources (ipapi.is, IPLocate, IPNetDB) are
 * looked up beside the existing Enrich lookup, never instead of it, and only
 * DAILY AGGREGATE COUNTS of what they said are stored (source_shadow_counts,
 * migration 0015). Nothing here changes how a visit is resolved, qualified or
 * recorded. An address, a domain or a company name exists only in memory for
 * the duration of one comparison and is never stored or logged.
 */
import type { ResolutionStatus } from "../contracts/api.js";
import type { ProviderErrorCategory } from "../contracts/provider.js";

/** The two API sources, by their metric prefix. */
export const API_SOURCES = ["ipapi", "iplocate"] as const;
export type ApiSource = (typeof API_SOURCES)[number];

/**
 * What an API source said about one address, reduced in its adapter to an
 * allowlist. The domain and name are kept in memory only, for the comparison.
 */
export interface ApiSignals {
  /** Canonical company name (canonicaliseOrganisationName), or null. */
  companyName: string | null;
  /** Canonical company domain (canonicaliseDomain), or null when absent or not a plausible host name. */
  companyDomain: string | null;
  /** The company object's type, lowercased (business, isp, hosting, education, government, banking...), or null. */
  companyType: string | null;
  /** The ASN object's type, lowercased, or null. Used only when there is no company object. */
  asnType: string | null;
  /** A mobile network (ipapi.is is_mobile; IPLocate has no mobile flag). */
  mobile: boolean;
  /** A data centre or hosting network (is_datacenter, is_hosting or a hosting object). */
  hosting: boolean;
  /** VPN, proxy, Tor or relay (iCloud Private Relay) traffic. */
  anonymous: boolean;
}

/** One API lookup. Adapters never throw: every failure maps to one of these kinds. */
export type ApiSourceOutcome =
  | { kind: "ok"; signals: ApiSignals }
  /** 401/403: the key was rejected. */
  | { kind: "auth" }
  /** 429 or a documented quota error code. */
  | { kind: "quota" }
  /** Network failure, redirect, 5xx, an oversize or malformed body, any other status. */
  | { kind: "error" }
  /** The per-source timeout (SHADOW_TIMEOUT_MS) or the runner's abort elapsed. */
  | { kind: "timeout" };

export interface ApiSourceAdapter {
  readonly source: ApiSource;
  /** Never throws; must respect `signal`; never logs. */
  lookup(canonicalIp: string, opts: { signal: AbortSignal }): Promise<ApiSourceOutcome>;
}

/** Normalised verdict of one API source (src/shadow/verdict.ts). `disabled`: the source has no key. */
export const API_VERDICTS = [
  "business",
  "business_no_domain",
  "isp",
  "hosting",
  "mobile",
  "anonymous",
  "none",
  "error",
  "timeout",
  "quota",
  "auth",
  "disabled",
] as const;
export type ApiVerdictName = (typeof API_VERDICTS)[number];

export type ApiVerdict =
  | { verdict: "business"; domain: string; name: string | null }
  | { verdict: "business_no_domain" | "isp" | "hosting" | "mobile" | "anonymous" | "none"; name: string | null }
  | { verdict: "error" | "timeout" | "quota" | "auth" | "disabled" };

/** IPNetDB (the local prefix database). `disabled`: IPNETDB_ENABLED=false; `unavailable`: not loaded (yet) or unreadable. */
export const IPNETDB_VERDICTS = ["found", "not_found", "bogon", "unavailable", "disabled"] as const;
export type IpnetdbVerdictName = (typeof IPNETDB_VERDICTS)[number];

export type IpnetdbResult =
  | { verdict: "found"; prefixEntity: string | null; asEntity: string | null; asn: number | null }
  | { verdict: "not_found" | "bogon" | "unavailable" | "disabled" };

/** Why the pipeline did not call Enrich for an observed address (`unknown`: no answer from the pipeline within 30 s). */
export const ENRICH_NOT_CALLED_REASONS = ["provider_disabled", "kill_switch", "cap_exhausted", "deadline_exceeded", "database_error", "internal_error", "unknown"] as const;
export type EnrichNotCalledReason = (typeof ENRICH_NOT_CALLED_REASONS)[number];

/** What the existing Enrich lookup did for the observed address, handed over by the pipeline. In memory only. */
export type EnrichSummary =
  | {
      kind: "resolved";
      /** Canonical domain Enrich returned. */
      domain: string;
      usageType: string | null;
      /** The status the pipeline resolved the visit to (qualified = qualify() accepted it as a business). */
      status: ResolutionStatus;
      /** Enrich's organisation name, for IPNetDB corroboration only. */
      organisationName?: string | null;
    }
  | { kind: "no_domain" }
  | { kind: "error"; category: ProviderErrorCategory }
  | { kind: "timeout" }
  | { kind: "not_called"; reason: EnrichNotCalledReason };

export const ENRICH_CATEGORIES = ["resolved_business", "resolved_other", "no_domain", "error", "timeout", "not_called"] as const;
export type EnrichCategory = (typeof ENRICH_CATEGORIES)[number];

export const WATERFALL_VERDICTS = ["high", "medium", "vetoed", "conflict", "inconclusive", "no_data"] as const;
export type WaterfallVerdict = (typeof WATERFALL_VERDICTS)[number];

/** Metric names: ^[a-z0-9_]{1,64}$ (the table's CHECK). */
export const METRIC_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * The closed allowlist of counters in source_shadow_counts. One row per
 * (installation, website, UTC day, metric). docs/contracts/source-shadow.v1.md
 * explains each one.
 */
export const SHADOW_METRICS = [
  "observed",
  // Requests reserved against SHADOW_<SOURCE>_DAILY_LIMIT (src/db/shadow-repo.ts), counted before the request is sent.
  "ipapi_requests",
  "iplocate_requests",
  "ipapi_business",
  "ipapi_business_no_domain",
  "ipapi_isp",
  "ipapi_hosting",
  "ipapi_mobile",
  "ipapi_anonymous",
  "ipapi_none",
  "ipapi_error",
  "ipapi_timeout",
  "ipapi_quota",
  "ipapi_auth",
  "ipapi_disabled",
  "iplocate_business",
  "iplocate_business_no_domain",
  "iplocate_isp",
  "iplocate_hosting",
  "iplocate_mobile",
  "iplocate_anonymous",
  "iplocate_none",
  "iplocate_error",
  "iplocate_timeout",
  "iplocate_quota",
  "iplocate_auth",
  "iplocate_disabled",
  "ipnetdb_found",
  "ipnetdb_not_found",
  "ipnetdb_bogon",
  "ipnetdb_unavailable",
  "ipnetdb_disabled",
  "ipnetdb_corroborates",
  "hosting_range_matched",
  "enrich_resolved_business",
  "enrich_resolved_other",
  "enrich_no_domain",
  "enrich_error",
  "enrich_timeout",
  "enrich_not_called",
  "waterfall_high",
  "waterfall_medium",
  "waterfall_vetoed",
  "waterfall_conflict",
  "waterfall_inconclusive",
  "waterfall_no_data",
  "enrich_call_avoidable",
  "enrich_call_needed",
  "enrich_agrees",
  "enrich_disagrees",
  // Counted by the runner (src/shadow/runner.ts), not by compare.
  "dropped_overload",
  "dropped_duplicate",
] as const;
export type ShadowMetric = (typeof SHADOW_METRICS)[number];

const METRIC_SET: ReadonlySet<string> = new Set(SHADOW_METRICS);
export const isShadowMetric = (v: unknown): v is ShadowMetric => typeof v === "string" && METRIC_SET.has(v);

/** Scope of one counter row: the deployment and a UTC calendar day (YYYY-MM-DD). */
export interface ShadowScope {
  installationId: string;
  websiteId: string;
  day: string;
}

/** Handed back by observe(); the pipeline reports Enrich's result through it exactly once. */
export interface ShadowHandle {
  /** Idempotent and synchronous; never throws. */
  complete(summary: EnrichSummary): void;
}

export interface ShadowObserveContext {
  /** The address is in a published cloud or crawler range (HOSTING_RANGES_MODE=shadow). */
  hostingRangeMatched?: boolean;
}

/**
 * What the pipeline sees (PipelineDeps.shadow). observe() is synchronous,
 * O(1) and never throws; it returns null when the address is not measured
 * (a repeat today, the queue full, shut down). It must copy whatever it keeps
 * from `dedupKey`: the pipeline zeroes the fingerprint Buffer after the job.
 */
export interface ShadowObserver {
  observe(canonicalIp: string, dedupKey: Buffer | string, context?: ShadowObserveContext): ShadowHandle | null;
}
