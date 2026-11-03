/**
 * Persistence contract. Implemented in src/db (PostgreSQL) and by in-memory
 * fakes in tests. Raw IPs never reach this layer: keys carry only the HMAC
 * fingerprint. Implementations must be safe under concurrent callers in
 * separate processes.
 */
import type { Acquisition } from "./api.js";
import type { FeedPage, FeedPosition } from "./reporting-feed.js";

export const CACHE_STATUSES = [
  "pending", // reservation held; lease_expires_at governs ownership
  "qualified",
  "no_match",
  "excluded",
  "unknown",
  "provider_error",
  "uncertain",
] as const;

export type CacheStatus = (typeof CACHE_STATUSES)[number];

export interface CacheKey {
  installationId: string;
  websiteId: string;
  keyVersion: number;
  /** 32-byte HMAC-SHA-256 output. */
  ipFingerprint: Buffer;
}

export interface CacheCompany {
  domain: string;
  organisationName: string | null;
  qualificationCategory: string;
}

export interface CacheRow {
  status: Exclude<CacheStatus, "pending">;
  company: CacheCompany | null;
  /** Durable company identity linked to this row (null unless qualified). */
  companyId: number | null;
  checkedAt: Date;
  expiresAt: Date;
}

/**
 * Lease authority is the DATABASE clock: leases are created, judged live or
 * expired, taken over and fenced with clock_timestamp() inside the database.
 * Workers never supply a timestamp for those decisions; they receive the
 * database-derived expiry and the remaining lease as a duration, which they
 * may count down with their own clock (durations do not depend on clock
 * offset). Result timestamps (checkedAt) are metadata only.
 */
export type ReservationResult =
  /** A fresh (unexpired, non-pending) row exists; use it, no provider call. */
  | { kind: "fresh"; row: CacheRow }
  /** Caller now owns the lookup. `token` must be presented on commit. */
  | { kind: "acquired"; token: string; leaseExpiresAt: Date; leaseRemainingMs: number }
  /** Another worker holds a live lease (by database time). */
  | { kind: "pending"; leaseExpiresAt: Date; leaseRemainingMs: number };

export interface CommitOutcome {
  status: Exclude<CacheStatus, "pending">;
  company: CacheCompany | null;
  /** Result metadata (when the provider answered, as the worker saw it); never a lease or expiry input. */
  checkedAt: Date;
  /** Freshness window; expires_at is computed by the database as clock_timestamp() + ttlMs at commit. */
  ttlMs: number;
}

export type CommitResult =
  /** The fence held; `companyId` is the durable identity created or reused (null for non-qualified outcomes). */
  | { kind: "committed"; companyId: number | null }
  /** The reservation expired or was taken over; nothing was written. */
  | { kind: "lost_lease" };

export interface CacheRepository {
  /** Returns a fresh (by database time) non-pending row, or null. Never blocks. */
  readFresh(key: CacheKey): Promise<CacheRow | null>;
  /**
   * Atomically: return a fresh row if one exists; otherwise acquire the lookup
   * if the row is absent, expired, or pending with an expired lease; otherwise
   * report pending. Exactly one concurrent caller may receive "acquired" for a
   * given key while a lease is live.
   */
  reserve(key: CacheKey, opts: { leaseMs: number }): Promise<ReservationResult>;
  /**
   * Fenced write: succeeds only if `token` still owns a live lease.
   * Returns "lost_lease" when the reservation expired or was taken over.
   */
  commit(key: CacheKey, token: string, outcome: CommitOutcome): Promise<"committed" | "lost_lease">;
  /** Same fenced write as `commit`, additionally returning the linked company id. */
  commitResolved(key: CacheKey, token: string, outcome: CommitOutcome): Promise<CommitResult>;
  /**
   * Release a reservation without a result (e.g. cap exhausted before dispatch).
   * The row becomes immediately expired so the next caller may try again.
   * No-op if the token no longer owns the lease.
   */
  release(key: CacheKey, token: string): Promise<void>;
  /** Delete rows expired by database time in bounded batches. Returns rows deleted. */
  pruneExpired(limit: number): Promise<number>;
}

export const USAGE_COUNTERS = [
  "resolver_requests",
  "cache_hits",
  "provider_attempts",
  "domain_resolutions",
  "qualified_matches",
  "no_matches",
  "excluded_results",
  "unknown_results",
  "failures",
  "uncertain_outcomes",
] as const;

export type UsageCounter = (typeof USAGE_COUNTERS)[number];

export interface UsageScope {
  installationId: string;
  websiteId: string;
  /** "YYYY-MM" for monthly periods, "YYYY-MM-DD" for daily. */
  periodKey: string;
}

export type ProviderAttemptReservation = "reserved" | "cap_exhausted" | "disabled";

export interface UsageSnapshot extends Record<UsageCounter, number> {
  periodKey: string;
  /** Credits the provider itself reported (sum). Never inferred. */
  providerCreditsReported: number;
  /** Locally estimated credits (sum). Clearly labelled estimate. */
  providerCreditsEstimated: number;
}

export interface UsageRepository {
  /**
   * Atomically increment provider_attempts if below `cap` AND the deployment
   * kill switch is off. The increment is never rolled back: a crash after
   * reservation still counts, so concurrent callers cannot exceed the cap.
   */
  reserveProviderAttempt(scope: UsageScope, cap: number): Promise<ProviderAttemptReservation>;
  increment(scope: UsageScope, counter: UsageCounter, delta?: number): Promise<void>;
  addProviderCredits(scope: UsageScope, credits: { reported?: number; estimated?: number }): Promise<void>;
  snapshot(scope: UsageScope): Promise<UsageSnapshot>;
}

export interface ControlsRepository {
  isEnrichmentEnabled(installationId: string): Promise<boolean>;
  setEnrichmentEnabled(installationId: string, enabled: boolean, reason: string): Promise<void>;
}

export interface CompanyRepository {
  /** Upsert by canonical domain; returns the stable company id. */
  upsert(company: { domain: string; organisationName: string | null }, now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// Durable company activity (augmentation). Nothing here carries an IP, a
// fingerprint, a provider payload, a header or a person identifier.
// ---------------------------------------------------------------------------

export const OBSERVATION_SOURCES = ["cache", "provider"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export interface ObservationScope {
  installationId: string;
  websiteId: string;
}

/**
 * Entrance evidence stored with an observation (migration 0005). Only the
 * normalised path, the closed acquisition class, the contract id and the
 * eligibility rule-set id: never a query string, referrer, UTM value,
 * header, user agent or IP.
 */
export interface ObservationContext {
  /** Normalised path (isValidPageKey). */
  pageKey: string;
  acquisition: Acquisition;
  /** e.g. "entrance.v1" (ENTRANCE_CONTRACT_PATTERN). */
  entranceContract: string;
  /** ELIGIBILITY_PATTERN. */
  eligibility: string;
}

export interface RecordObservationInput {
  scope: ObservationScope;
  companyId: number;
  /** Bounded opaque idempotency reference (^[A-Za-z0-9_-]{1,64}$), unique within the scope; the entrance_id for entrance.v1. */
  observationRef: string;
  source: ObservationSource;
  /** Server timestamp of the accepted resolution. */
  observedAt: Date;
  /**
   * Entrance evidence. Every entrance.v1 write carries it; it is optional only
   * so fixtures can seed observations without one (the columns are nullable,
   * and the feed contract allows null for older contracts).
   */
  context?: ObservationContext;
}

export type RecordObservationResult =
  /** A new observation row was written and the company's activity was updated atomically. */
  | { kind: "recorded"; observationId: number; previouslySeen: boolean }
  /** The reference was already used in this scope; nothing changed. `previouslySeen` is what the stored row decided. */
  | { kind: "duplicate"; observationId: number | null; previouslySeen: boolean; sameCompany: boolean };

export interface ActivityRepository {
  /**
   * Atomically (one transaction, serialised per company): decide whether the
   * company was previously observed in the scope, insert the observation
   * unless the reference was already used, and update the company's scope
   * stats and registry timestamps. Never updates anything on a duplicate.
   */
  recordObservation(input: RecordObservationInput): Promise<RecordObservationResult>;
  /** Retention: delete observations observed before `cutoff` in bounded batches. Stats and companies are kept. */
  pruneObservationsBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface CompanyActivitySummary {
  companyId: number;
  domain: string;
  organisationName: string | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
  observationCount: number;
}

export interface ObservationItem {
  observationId: number;
  observedAt: Date;
  source: ObservationSource;
  observationRef: string;
  companyFirst: boolean;
}

/**
 * Company listing orders. "id" is the stable enumeration (immutable key, no
 * company existing at the start of a walk is missed or repeated); "recent"
 * orders by mutable last activity and is for display only.
 */
export const COMPANY_ORDERS = ["id", "recent"] as const;
export type CompanyOrder = (typeof COMPANY_ORDERS)[number];

export type CompaniesCursor = { order: "id"; companyId: number } | { order: "recent"; lastObservedAt: Date; companyId: number };

export interface ObservationsCursor {
  observedAt: Date;
  observationId: number;
}

export interface Page<T, C> {
  items: T[];
  /** Cursor for the next page, or null when this page was the last. */
  nextCursor: C | null;
}

export interface ActivitySummary {
  observations: number;
  /** Distinct companies with at least one observation in the range. */
  observedCompanies: number;
  /** Companies whose first-ever observation in the scope falls in the range. */
  newlyObservedCompanies: number;
  /** Observed in the range and first observed before it (= observedCompanies - newlyObservedCompanies). */
  previouslyObservedCompanies: number;
}

export interface ReportingRepository {
  listCompanies(scope: ObservationScope, page: { limit: number; cursor: CompaniesCursor | null; order: CompanyOrder }): Promise<Page<CompanyActivitySummary, CompaniesCursor>>;
  getCompany(scope: ObservationScope, companyId: number): Promise<CompanyActivitySummary | null>;
  listObservations(
    scope: ObservationScope,
    companyId: number,
    page: { limit: number; cursor: ObservationsCursor | null },
  ): Promise<Page<ObservationItem, ObservationsCursor>>;
  /** Half-open range [from, to). */
  summary(scope: ObservationScope, range: { from: Date; to: Date }): Promise<ActivitySummary>;
  /**
   * reporting-feed.v1: up to `limit` (1..FEED_MAX_LIMIT) observations and
   * erasure tombstones strictly after `after` (null = the start of the
   * retained buffer) in stream order, restricted to transactions that had
   * finished when the reading statement's snapshot was taken. The retention
   * watermark check, the horizon and the rows come from ONE snapshot.
   */
  feed(scope: ObservationScope, page: { after: FeedPosition | null; limit: number }): Promise<FeedPage>;
  /**
   * The scope's retention watermark (the highest position deleted other than
   * by an erasure), or null when nothing was ever pruned. A plain read, not
   * tied to any feed snapshot: only for deciding between 400 and 410 for a
   * cursor whose tag does not verify, where nothing is served.
   */
  feedWatermark(scope: ObservationScope): Promise<FeedPosition | null>;
}

export function usagePeriodKey(period: "day" | "month", now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  if (period === "month") return `${y}-${m}`;
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
