/**
 * Website-facing API contract: `entrance.v1` (docs/contracts/entrance.v1.md,
 * owner decision D2). The website's server reports an eligible document
 * request; the resolver answers with a status acknowledgement only.
 *
 * Nothing in this module may carry a raw IP, an IP fingerprint, a secret, a
 * raw provider payload, or (D2) any company identity: the website only ever
 * sees the response types below.
 */

export const API_VERSION = "1" as const;

/**
 * Business outcomes. All are returned with HTTP 200 and every one of them
 * lets the website continue unchanged. None carries company data.
 */
export const RESOLUTION_STATUSES = [
  "qualified", // a company association was accepted (see `recorded` for the observation)
  "no_match", // provider found no company domain for this address
  "excluded", // a domain was found but it is a network owner (ISP, hosting, CDN, mobile, ...)
  "unknown", // insufficient evidence to qualify the association
  "pending", // another lookup for the same address is in flight
  "ineligible", // address is private/reserved/otherwise never enriched
  "disabled", // paid enrichment is disabled (kill switch) or the local call cap is exhausted
  "uncertain", // provider timed out after dispatch; suppressed for a window
  "unavailable", // internal failure or deadline (provider error, database, overrun)
] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export type ResolutionSource = "cache" | "provider" | "none";

/** The only contract version this resolver accepts on POST /v1/entrances. */
export const ENTRANCE_CONTRACT = "entrance.v1" as const;

/** Closed acquisition vocabulary, derived on the website server from the referrer host and utm_medium. */
export const ACQUISITION_CLASSES = ["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"] as const;
export type Acquisition = (typeof ACQUISITION_CLASSES)[number];

/** entrance_id: random, generated server-side per entrance; the observation idempotency key. */
export const ENTRANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Id of the website adapter rule set that admitted the request, e.g. `tsa-1`. */
export const ELIGIBILITY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}$/;
/** Grammar of a stored entrance contract id (the 0005 CHECK constraint). */
export const ENTRANCE_CONTRACT_PATTERN = /^[a-z][a-z0-9-]{0,31}\.v[0-9]{1,3}$/;
/** RFC 3339 timestamp in UTC (`Z`), optional fraction of up to nine digits. */
export const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** occurred_at further than this from resolver time is rejected (bounds replay of captured requests). */
export const OCCURRED_AT_MAX_SKEW_MS = 300_000;
export const PAGE_KEY_MAX_LENGTH = 256;

const PAGE_KEY_FORBIDDEN = /[?#\s\p{Cc}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** page_key: 1-256 characters (code points), starts with `/`, no `?`, `#`, whitespace or control characters. */
export function isValidPageKey(value: string): boolean {
  if (!value.startsWith("/") || LONE_SURROGATE.test(value) || PAGE_KEY_FORBIDDEN.test(value)) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= PAGE_KEY_MAX_LENGTH;
}

/** A real instant written exactly as RFC 3339 UTC (rejects e.g. 2026-02-30 or 24:00:00). Returns ms since epoch or null. */
export function parseOccurredAt(value: string): number | null {
  if (!OCCURRED_AT_PATTERN.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null;
}

export interface EntranceRequestBody {
  contract: typeof ENTRANCE_CONTRACT;
  website_id: string;
  /** Trusted client IP chosen by the adapter's trust policy; transient, never stored, logged or returned. */
  ip: string;
  entrance_id: string;
  occurred_at: string;
  page_key: string;
  acquisition: Acquisition;
  eligibility: string;
}

/** The complete response: an acknowledgement, never company data (D2). */
export interface EntranceResponse {
  version: typeof API_VERSION;
  status: ResolutionStatus;
  source: ResolutionSource;
  /** true only when a company observation is durably recorded for this entrance_id (qualified outcomes only). */
  recorded: boolean;
}

export const ERROR_CODES = [
  "unauthorized", // 401 missing/invalid credential
  "forbidden", // 403 website_id does not match this installation
  "invalid_request", // 400 schema violation, malformed address, occurred_at out of bounds, unknown route
  "not_found", // 404 reporting: company not observed in this scope
  "payload_too_large", // 413
  "rate_limited", // 429
  "overloaded", // 503 concurrency bound reached
  "not_ready", // 503 dependencies unavailable or shutting down
  "internal", // 500
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Error body: the code only; no message, stack trace or echoed input. */
export interface ErrorResponse {
  version: typeof API_VERSION;
  error: ErrorCode;
}

/** Opaque observation reference (the entrance_id for entrance.v1); at least 16 characters so random values cannot collide by accident. */
export const OBSERVATION_REF_PATTERN = ENTRANCE_ID_PATTERN;
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
