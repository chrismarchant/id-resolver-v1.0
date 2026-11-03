/**
 * reporting-feed.v1 (docs/contracts/reporting-feed.v1.md): the scope-wide,
 * commit-safe pull feed of company observations and company-erasure
 * tombstones for the client Insights consumer.
 *
 * Nothing here can carry an IP, a fingerprint, a provider payload, a header,
 * an observation reference (the entrance id) or person data.
 */

export const FEED_CONTRACT = "reporting-feed.v1" as const;
export const FEED_VERSION = "1" as const;
export const FEED_DEFAULT_LIMIT = 200;
export const FEED_MAX_LIMIT = 500;

/** Item kinds in stream order within one transaction id: observations sort before tombstones. */
export const FEED_KIND_OBSERVATION = 0 as const;
export const FEED_KIND_TOMBSTONE = 1 as const;
export type FeedKind = typeof FEED_KIND_OBSERVATION | typeof FEED_KIND_TOMBSTONE;

/**
 * A position in the one totally ordered stream: the writing transaction's
 * top-level xid8, then the kind, then the row's own id. Positions compare
 * lexicographically. All three parts are unsigned 64-bit values.
 */
export interface FeedPosition {
  txid: bigint;
  kind: FeedKind;
  id: bigint;
}

/** The position before every item; "omit `after`" means start here. */
export const FEED_START: FeedPosition = Object.freeze({ txid: 0n, kind: FEED_KIND_OBSERVATION, id: 0n });

export function compareFeedPositions(a: FeedPosition, b: FeedPosition): number {
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export const ACQUISITION_CLASSES = ["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"] as const;
export type AcquisitionClass = (typeof ACQUISITION_CLASSES)[number];

export interface FeedObservationRecord {
  type: "observation";
  position: FeedPosition;
  observationId: bigint;
  companyId: number;
  domain: string;
  organisationName: string | null;
  observedAt: Date;
  method: "cache" | "provider";
  pageKey: string | null;
  acquisition: AcquisitionClass | null;
  entranceContract: string | null;
}

export interface FeedTombstoneRecord {
  type: "company_erased";
  position: FeedPosition;
  tombstoneId: bigint;
  companyId: number;
  erasedAt: Date;
}

export type FeedRecord = FeedObservationRecord | FeedTombstoneRecord;

export interface FeedPage {
  /** At most `limit` items, strictly after the requested position, in stream order. */
  items: FeedRecord[];
  /** More finished items exist after the last returned one right now. */
  hasMore: boolean;
  /**
   * The request position lies strictly before the scope's retention
   * watermark: items after it may have been pruned. `items` is then empty.
   */
  expired: boolean;
  /**
   * Internal, never on the wire: the snapshot xmin the page was cut at. Every
   * transaction with an id below it had finished; no item at a position below
   * (horizon, 0, 0) can appear after this read.
   */
  horizon: bigint;
}

// ---- wire format -------------------------------------------------------------

export interface FeedScopeWire {
  installation_id: string;
  website_id: string;
}

export interface FeedObservationWire {
  type: "observation";
  /** Decimal string (64-bit safe). */
  observation_id: string;
  company_id: number;
  domain: string;
  organisation_name: string | null;
  observed_at: string;
  method: "cache" | "provider";
  page_key: string | null;
  acquisition: AcquisitionClass | null;
  entrance_contract: string | null;
}

export interface FeedTombstoneWire {
  type: "company_erased";
  /** Decimal string (64-bit safe). */
  tombstone_id: string;
  company_id: number;
  erased_at: string;
}

export type FeedItemWire = FeedObservationWire | FeedTombstoneWire;

export interface ReportingFeedResponse {
  version: typeof FEED_VERSION;
  contract: typeof FEED_CONTRACT;
  scope: FeedScopeWire;
  items: FeedItemWire[];
  /** Always present; with no new items it encodes the same position as the request. */
  next_cursor: string;
  has_more: boolean;
}

/** 410: the cursor lies before the retention watermark. The consumer must alert and resynchronise. */
export interface FeedCursorExpiredResponse {
  version: typeof FEED_VERSION;
  error: "cursor_expired";
}

export const FEED_CURSOR_EXPIRED_STATUS = 410;
