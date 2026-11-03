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

/**
 * The projection schema (sql/0001_idr_projection.sql, idr_schema_version())
 * this code requires. The engine refuses to run against any other.
 */
export const PROJECTION_SCHEMA_VERSION = 3;

export interface SyncState {
  /** idr_schema_version() of the installed SQL; null when the installed SQL predates it. */
  schemaVersion: number | null;
  cursor: string | null;
  needsResync: boolean;
  /**
   * The cursor the resolver rejected with 400, kept by Store.resetCursor until
   * the first page from null is applied. While set (with cursor null), each
   * run re-presents it before replaying, so a prune past it becomes a 410 and
   * a recorded gap rather than a silent loss.
   */
  resetFromCursor: string | null;
  /** An unresolved continuity gap is recorded (see Store.recordGap). */
  gapOpen: boolean;
}

export interface ApplyPageArgs {
  expectedCursor: string | null;
  /** Compare-and-set on the stored reset_from_cursor too; a successful apply clears it. */
  expectedResetFrom: string | null;
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
  | "cursor_rejected"
  | "store_error"
  | "schema_mismatch"
  | "reconcile_mismatch";

export interface RecordStatusArgs {
  status: SyncStatus;
  /** true marks the projection as needing a resync; null leaves it unchanged. */
  needsResync: boolean | null;
}

/** The only gap kind: the resolver answered 410 cursor_expired. */
export type GapKind = "cursor_expired";

export interface RecordGapArgs {
  kind: GapKind;
  /** The cursor that got the 410 (compare-and-set against the stored one). */
  expectedCursor: string | null;
}

export interface RecordGapResult {
  /** A durable gap record exists for this incident (inserted now or already open). */
  recorded: boolean;
  /** This call inserted it (false: an open gap of this kind already existed). */
  newGap: boolean;
  /**
   * The stored cursor no longer equals expectedCursor: another run applied
   * pages past that position, so nothing was missed there. Nothing was
   * written; the run ends cas_conflict.
   */
  superseded: boolean;
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
  /**
   * Compare-and-set reset of the stored cursor to null (start of the resolver's
   * buffer): only if the stored cursor still equals expectedCursor. Returns
   * false when another invocation changed it. Keeps the projection. In the
   * same transaction, keeps the rejected cursor as resetFromCursor until the
   * first page from null is applied.
   */
  resetCursor(expectedCursor: string): Promise<boolean>;
  /**
   * A potential synchronisation continuity gap (410 cursor_expired).
   * Compare-and-set on the cursor that got the 410: if the stored cursor has
   * moved on, write nothing and report superseded. Otherwise, in ONE
   * transaction: mark needs_resync (status needs_resync) and append a durable
   * gap record, unless an unresolved gap of this kind is already open (never a
   * duplicate). The record is never deleted; a later resync does not erase it.
   */
  recordGap(args: RecordGapArgs): Promise<RecordGapResult>;
  /**
   * After a run that drained the resolver's buffer up to drainedCursor: mark
   * open gaps resolved whose detection precedes the resync request that
   * started the replay now drained (ordered by generation under the state row
   * lock), only while the stored cursor is still drainedCursor. Rebuilt from
   * the retained buffer, NOT recovered. Returns how many were resolved.
   */
  resolveGaps(drainedCursor: string): Promise<number>;
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
  /** status needs_resync: whether the continuity gap is durably recorded (null: no gap this run). */
  gap: RecordGapResult | null;
  /** Open gaps this run marked resolved after draining the buffer post-resync. */
  gapsResolved: number;
}
