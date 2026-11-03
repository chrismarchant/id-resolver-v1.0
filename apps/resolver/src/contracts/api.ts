/**
 * Frozen V0.1 public API contract (see docs/API_CONTRACT.md).
 *
 * Nothing in this module may carry a raw IP, an IP fingerprint, a secret or a
 * raw provider payload. The website only ever sees the types below.
 */

export const API_VERSION = "1" as const;

/**
 * Business outcomes. All are returned with HTTP 200 and all of them permit the
 * website to render its default public variant. Only `qualified` carries a
 * company context.
 */
export const RESOLUTION_STATUSES = [
  "qualified", // approved company context available
  "no_match", // provider found no company domain for this address
  "excluded", // a domain was found but it is a network owner (ISP, hosting, CDN, mobile, ...)
  "unknown", // insufficient evidence to qualify the association
  "pending", // another lookup for the same address is in flight; render default
  "ineligible", // address is private/reserved/otherwise never enriched
  "disabled", // paid enrichment is disabled (kill switch) or the local call cap is exhausted
  "uncertain", // provider timed out after dispatch; suppressed for a window
  "unavailable", // internal failure (provider error, child failure, database); render default
] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export type ResolutionSource = "cache" | "provider" | "none";

export interface CompanyQualification {
  /** Provider-derived category used to accept the association, e.g. "COM". */
  category: string;
  /** Where the evidence came from. V0.1 only has one source. */
  source: "provider_usage_type";
}

export interface CompanyContext {
  /** Canonical lowercase registrable host, e.g. "example.com". */
  domain: string;
  organisation_name: string | null;
  qualification: CompanyQualification;
  /** ISO-8601 timestamp of the provider resolution that produced this context. */
  resolved_at: string;
}

export interface ResolveRequestBody {
  website_id: string;
  ip: string;
  request_id?: string;
  /**
   * Optional bounded opaque idempotency reference for the company observation
   * this request may record (^[A-Za-z0-9_-]{16,64}$; generate it randomly,
   * server-side; never derive it from an IP, an email or a fingerprint). A
   * repeated reference within the installation/website scope never records a
   * second observation. When omitted the resolver generates one, so a retried
   * request counts as a separate observation.
   */
  observation_ref?: string;
}

export interface ResolveResponse {
  version: typeof API_VERSION;
  status: ResolutionStatus;
  company: CompanyContext | null;
  source: ResolutionSource;
  request_id?: string;
  /** Present only when `status` is `qualified`. Server-to-server data: never ship it to the browser. */
  company_id?: number;
  /**
   * Present only when `status` is `qualified`: true when the company had an
   * accepted observation in this installation/website scope before this
   * request; false when this is its first; null when the activity write
   * failed and the answer is unknown.
   */
  previously_seen_company?: boolean | null;
  /** Present only when `status` is `qualified`: whether this request's observation was durably recorded. */
  activity_recorded?: boolean;
  /** Present only when `status` is `qualified`: the reference the observation was recorded under. */
  observation_ref?: string;
}

export const ERROR_CODES = [
  "unauthorized", // 401 missing/invalid credential
  "forbidden", // 403 website_id does not match this installation
  "invalid_request", // 400 schema violation, malformed address, bad request id, unknown route
  "not_found", // 404 reporting: company not observed in this scope
  "payload_too_large", // 413
  "rate_limited", // 429
  "overloaded", // 503 concurrency bound reached
  "not_ready", // 503 dependencies unavailable
  "internal", // 500
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorResponse {
  version: typeof API_VERSION;
  error: ErrorCode;
  request_id?: string;
}

/** request_id: optional caller correlation id, echoed back verbatim when valid. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** observation_ref: optional opaque idempotency reference; at least 16 characters so random values cannot collide by accident. */
export const OBSERVATION_REF_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** website_id and installation_id share the same bounded identifier grammar. */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Maximum accepted length of the `ip` string before parsing. */
export const MAX_IP_LENGTH = 64;

// ---------------------------------------------------------------------------
// Reporting API (version 1). Server-to-server, read-only, separate credential.
// Scope (installation, website) comes from deployment configuration. Nothing
// here can carry an IP, a fingerprint, a provider payload or a person.
// ---------------------------------------------------------------------------

export const REPORTING_API_VERSION = "1" as const;
export const REPORTING_MAX_LIMIT = 100;
export const REPORTING_DEFAULT_LIMIT = 50;
/** Longest date range a summary may cover (inclusive days). */
export const REPORTING_MAX_RANGE_DAYS = 366;

export interface ReportingCompany {
  company_id: number;
  domain: string;
  organisation_name: string | null;
  first_observed_at: string;
  last_observed_at: string;
  observation_count: number;
}

export interface ReportingObservation {
  observation_id: number;
  observed_at: string;
  source: "cache" | "provider";
  observation_ref: string;
  /** True for the company's first accepted observation in this scope. */
  company_first: boolean;
}

export interface ReportingScope {
  installation_id: string;
  website_id: string;
}

export interface ReportingCompaniesResponse {
  version: typeof REPORTING_API_VERSION;
  scope: ReportingScope;
  /** `id`: stable enumeration by immutable company id (default); `recent`: display order by mutable last activity. */
  order: "id" | "recent";
  items: ReportingCompany[];
  next_cursor: string | null;
}

export interface ReportingCompanyDetailResponse {
  version: typeof REPORTING_API_VERSION;
  scope: ReportingScope;
  company: ReportingCompany;
  observations: ReportingObservation[];
  next_cursor: string | null;
}

export interface ReportingSummaryResponse {
  version: typeof REPORTING_API_VERSION;
  scope: ReportingScope;
  /** Inclusive UTC calendar dates as requested. */
  from: string;
  to: string;
  observations: number;
  observed_companies: number;
  newly_observed_companies: number;
  previously_observed_companies: number;
}
