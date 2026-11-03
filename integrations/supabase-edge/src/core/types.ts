/** Runtime-agnostic types for the reporting-feed.v1 sync engine. */

/** Observation as projected from the feed (only whitelisted contract fields). */
export interface FeedObservation {
  type: "observation";
  observation_id: string;
  company_id: number;
  domain: string;
  organisation_name: string | null;
  observed_at: string;
  method: string;
  page_key: string | null;
  acquisition: string | null;
  entrance_contract: string | null;
}

export interface FeedTombstone {
  type: "company_erased";
  tombstone_id: string;
  company_id: number;
  erased_at: string;
}

export type FeedItem = FeedObservation | FeedTombstone;

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string;
  hasMore: boolean;
}

export interface SyncState {
  cursor: string | null;
  needsResync: boolean;
}

export interface ApplyPageArgs {
  expectedCursor: string | null;
  nextCursor: string;
  items: FeedItem[];
}

export interface ApplyPageResult {
  /** false when the stored cursor did not equal expectedCursor (CAS lost). */
  applied: boolean;
  observations: number;
  tombstones: number;
}

export type SyncStatus =
  | "ok"
  | "partial"
  | "needs_resync"
  | "auth_failed"
  | "rate_limited"
  | "upstream_error"
  | "cas_conflict"
  | "contract_error"
  | "store_error"
  | "reconcile_mismatch";

export interface RecordStatusArgs {
  status: SyncStatus;
  /** true marks the projection as needing a resync; null leaves it unchanged. */
  needsResync: boolean | null;
}

export interface LocalCounts {
  observations: number;
  observedCompanies: number;
}

/**
 * Persistence port. Implementations MUST make applyPage atomic and
 * compare-and-set on the cursor: apply the items, tombstones and the cursor
 * advance in one transaction, only if the stored cursor equals expectedCursor.
 */
export interface Store {
  getState(): Promise<SyncState>;
  applyPage(args: ApplyPageArgs): Promise<ApplyPageResult>;
  recordStatus(args: RecordStatusArgs): Promise<void>;
  /** Inclusive UTC calendar days (YYYY-MM-DD). */
  localCounts(fromDay: string, toDay: string): Promise<LocalCounts>;
}

export interface SyncConfig {
  /** Resolver base URL, no trailing path. */
  baseUrl: string;
  /** Read-only reporting bearer token. Never logged or returned. */
  token: string;
  /** Must equal scope.installation_id in every response. */
  installationId: string;
  pageLimit: number;
  maxPages: number;
  /** Overall wall-clock budget per invocation. */
  budgetMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Number of complete UTC days (ending yesterday) to reconcile; 0 disables. */
  reconcileDays: number;
}

export interface SyncDeps {
  fetch: typeof fetch;
  store: Store;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Returns [0,1); injected so backoff is deterministic in tests. */
  random: () => number;
}

export interface ReconcileOutcome {
  checked: boolean;
  matched: boolean | null;
  from: string | null;
  to: string | null;
  reason: string | null;
}

/** Counts and status only. Never contains resolver data or credentials. */
export interface SyncResult {
  status: SyncStatus;
  pages: number;
  observations: number;
  tombstones: number;
  reconcile: ReconcileOutcome | null;
}
