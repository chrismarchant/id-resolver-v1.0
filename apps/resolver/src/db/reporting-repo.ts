/**
 * Read-only reporting over durable company activity (implements
 * ReportingRepository). Every query is scoped by installation and website
 * supplied by the caller from deployment configuration, never from the
 * request. Pagination is keyset-based and stable under concurrent inserts.
 * Nothing here can return an IP, a fingerprint or a provider payload: those
 * tables are never joined.
 */
import type {
  ActivitySummary,
  CompaniesCursor,
  CompanyActivitySummary,
  ObservationItem,
  ObservationScope,
  ObservationsCursor,
  Page,
  ReportingRepository,
} from "../contracts/db.js";
import {
  compareFeedPositions,
  FEED_KIND_OBSERVATION,
  FEED_KIND_TOMBSTONE,
  FEED_MAX_LIMIT,
  type AcquisitionClass,
  type FeedPage,
  type FeedPosition,
  type FeedRecord,
} from "../contracts/reporting-feed.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";
import { queryFeedWatermark } from "./retention.js";

export const MAX_PAGE_LIMIT = 100;

/** Stable enumeration: immutable company id ascending. */
const LIST_COMPANIES_BY_ID_SQL = `
SELECT s.company_id, c.domain, c.organisation_name, s.first_observed_at, s.last_observed_at, s.observation_count
FROM company_scope_stats s
JOIN companies c ON c.id = s.company_id
WHERE s.installation_id = $1::text AND s.website_id = $2::text
  AND ($3::bigint IS NULL OR s.company_id > $3::bigint)
ORDER BY s.company_id ASC
LIMIT $4::integer`;

/** Display order: mutable last activity; a company active between pages moves ahead of the cursor. */
const LIST_COMPANIES_RECENT_SQL = `
SELECT s.company_id, c.domain, c.organisation_name, s.first_observed_at, s.last_observed_at, s.observation_count
FROM company_scope_stats s
JOIN companies c ON c.id = s.company_id
WHERE s.installation_id = $1::text AND s.website_id = $2::text
  AND ($3::timestamptz IS NULL OR (s.last_observed_at, s.company_id) < ($3::timestamptz, $4::bigint))
ORDER BY s.last_observed_at DESC, s.company_id DESC
LIMIT $5::integer`;

const GET_COMPANY_SQL = `
SELECT s.company_id, c.domain, c.organisation_name, s.first_observed_at, s.last_observed_at, s.observation_count
FROM company_scope_stats s
JOIN companies c ON c.id = s.company_id
WHERE s.installation_id = $1::text AND s.website_id = $2::text AND s.company_id = $3::bigint`;

/**
 * company_first is the persisted identity of the earliest observation
 * (company_scope_stats.first_observation_ref, see activity-repo): exactly the
 * row recorded under that reference, never a survivor promoted after the true
 * first row was pruned, and NULL identity (unreconstructable pre-migration
 * history) flags no row.
 */
const LIST_OBSERVATIONS_SQL = `
SELECT o.id, o.observed_at, o.source, o.observation_ref,
       COALESCE(o.observation_ref = s.first_observation_ref, false) AS company_first
FROM company_observations o
JOIN company_scope_stats s
  ON s.installation_id = o.installation_id AND s.website_id = o.website_id AND s.company_id = o.company_id
WHERE o.installation_id = $1::text AND o.website_id = $2::text AND o.company_id = $3::bigint
  AND ($4::timestamptz IS NULL OR (o.observed_at, o.id) < ($4::timestamptz, $5::bigint))
ORDER BY o.observed_at DESC, o.id DESC
LIMIT $6::integer`;

/**
 * Newly observed = active in the range AND the company's scoped earliest
 * observation (first_observed_at, maintained as LEAST over every accepted
 * observation and never pruned) falls in the range. Commit order is
 * irrelevant; the upper bound is implied because first_observed_at is never
 * later than any observation in the range.
 */
const SUMMARY_SQL = `
WITH in_range AS (
  SELECT company_id, count(*)::bigint AS n
  FROM company_observations
  WHERE installation_id = $1::text AND website_id = $2::text
    AND observed_at >= $3::timestamptz AND observed_at < $4::timestamptz
  GROUP BY company_id)
SELECT coalesce(sum(r.n), 0)::bigint AS observations,
       count(*)::bigint AS observed_companies,
       count(*) FILTER (WHERE s.first_observed_at >= $3::timestamptz)::bigint AS newly_observed_companies
FROM in_range r
JOIN company_scope_stats s
  ON s.installation_id = $1::text AND s.website_id = $2::text AND s.company_id = r.company_id`;

/**
 * reporting-feed.v1 page (docs/contracts/reporting-feed.v1.md). ONE statement,
 * run outside any explicit transaction, i.e. under READ COMMITTED with a
 * single statement snapshot S. Why that is sufficient, and necessary:
 *
 *  - pg_current_snapshot() returns the ACTIVE snapshot, which for a plain
 *    SELECT is S itself, the snapshot every CTE below reads with (all parts of
 *    a WITH query share one snapshot). The horizon, the observations, the
 *    tombstones and the retention watermark are therefore mutually consistent.
 *    Two separate statements under READ COMMITTED would NOT be: retention could
 *    commit between a watermark check and the row read and skip rows silently.
 *  - horizon = xmin(S): every top-level transaction id below it had finished
 *    when S was taken (committed => visible in S; aborted => never visible), so
 *    the set of items with txid < horizon can never grow again. Transactions
 *    that can still commit have txid >= horizon > every position handed out.
 *    Row txid is the inserting top-level transaction id, enforced by trigger
 *    (migration 0006), including inserts made inside SAVEPOINTs.
 *  - Within one txid all rows become visible atomically at its commit, so the
 *    (kind, id) tiebreak cannot be undercut by a later row of the same txid.
 *  - REPEATABLE READ or SERIALIZABLE would add nothing for a single read-only
 *    statement; the guarantee comes from the xmin cut, not the isolation level.
 *
 * $1/$2 scope; $3/$4 observations strictly after (txid, id); $5/$6 tombstones
 * strictly after (txid, id); $7 rows to fetch. The (kind) part of the cursor is
 * folded into $3..$6 by the caller. A row with no item columns (LEFT JOIN)
 * always carries the horizon and the watermark, even for an empty page.
 */
export const FEED_SQL = `
WITH snap AS MATERIALIZED (
  SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon
),
meta AS MATERIALIZED (
  SELECT s.horizon, w.pruned_through_txid AS wm_txid, w.pruned_through_id AS wm_id
  FROM snap s
  LEFT JOIN feed_retention_watermarks w ON w.installation_id = $1::text AND w.website_id = $2::text
),
obs AS (
  SELECT o.txid, 0 AS kind, o.id, o.company_id, c.domain, c.organisation_name, o.observed_at,
         o.source, o.page_key, o.acquisition, o.entrance_contract, NULL::timestamptz AS erased_at
  FROM company_observations o
  JOIN companies c ON c.id = o.company_id
  WHERE o.installation_id = $1::text AND o.website_id = $2::text
    AND (o.txid, o.id) > ($3::xid8, $4::bigint)
    AND o.txid < (SELECT horizon FROM snap)
  ORDER BY o.txid, o.id
  LIMIT $7::integer
),
tomb AS (
  SELECT t.txid, 1 AS kind, t.id, t.company_id, NULL::text AS domain, NULL::text AS organisation_name,
         NULL::timestamptz AS observed_at, NULL::text AS source, NULL::text AS page_key,
         NULL::text AS acquisition, NULL::text AS entrance_contract, t.erased_at
  FROM feed_tombstones t
  WHERE t.installation_id = $1::text AND t.website_id = $2::text
    AND (t.txid, t.id) > ($5::xid8, $6::bigint)
    AND t.txid < (SELECT horizon FROM snap)
  ORDER BY t.txid, t.id
  LIMIT $7::integer
),
items AS (
  SELECT * FROM obs
  UNION ALL
  SELECT * FROM tomb
  ORDER BY txid, kind, id
  LIMIT $7::integer
)
SELECT m.horizon::text AS horizon, m.wm_txid::text AS wm_txid, m.wm_id::text AS wm_id,
       i.txid::text AS txid, i.kind, i.id::text AS id, i.company_id::text AS company_id,
       i.domain, i.organisation_name, i.observed_at, i.source, i.page_key, i.acquisition,
       i.entrance_contract, i.erased_at
FROM meta m
LEFT JOIN items i ON true
ORDER BY i.txid, i.kind, i.id`;

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_XID8 = 18_446_744_073_709_551_615n;

interface FeedRow {
  horizon: string;
  wm_txid: string | null;
  wm_id: string | null;
  txid: string | null;
  kind: number | null;
  id: string | null;
  company_id: string | null;
  domain: string | null;
  organisation_name: string | null;
  observed_at: Date | null;
  source: "cache" | "provider" | null;
  page_key: string | null;
  acquisition: AcquisitionClass | null;
  entrance_contract: string | null;
  erased_at: Date | null;
}

function checkFeedPosition(p: FeedPosition): void {
  if (typeof p.txid !== "bigint" || p.txid < 0n || p.txid > MAX_XID8) throw new DbError("INVALID_CURSOR");
  if (p.kind !== FEED_KIND_OBSERVATION && p.kind !== FEED_KIND_TOMBSTONE) throw new DbError("INVALID_CURSOR");
  if (typeof p.id !== "bigint" || p.id < 0n || p.id > MAX_BIGINT) throw new DbError("INVALID_CURSOR");
}

/**
 * Lower bounds per table for "strictly after `after`": an observation cursor
 * admits tombstones of the same txid (kind 1 sorts after kind 0); a tombstone
 * cursor excludes every observation of its txid.
 */
function feedBounds(after: FeedPosition | null): { obs: [string, string]; tomb: [string, string] } {
  if (!after) return { obs: ["0", "0"], tomb: ["0", "0"] };
  const t = after.txid.toString();
  return after.kind === FEED_KIND_OBSERVATION
    ? { obs: [t, after.id.toString()], tomb: [t, "0"] }
    : { obs: [t, MAX_BIGINT.toString()], tomb: [t, after.id.toString()] };
}

function toCompanyId(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new DbError("INVALID_ID");
  return n;
}

function toFeedRecord(r: FeedRow): FeedRecord {
  const position: FeedPosition = {
    txid: BigInt(r.txid as string),
    kind: r.kind === FEED_KIND_TOMBSTONE ? FEED_KIND_TOMBSTONE : FEED_KIND_OBSERVATION,
    id: BigInt(r.id as string),
  };
  if (position.kind === FEED_KIND_TOMBSTONE) {
    return { type: "company_erased", position, tombstoneId: position.id, companyId: toCompanyId(r.company_id as string), erasedAt: r.erased_at as Date };
  }
  return {
    type: "observation",
    position,
    observationId: position.id,
    companyId: toCompanyId(r.company_id as string),
    domain: r.domain as string,
    organisationName: r.organisation_name,
    observedAt: r.observed_at as Date,
    method: r.source === "provider" ? "provider" : "cache",
    pageKey: r.page_key,
    acquisition: r.acquisition,
    entranceContract: r.entrance_contract,
  };
}

interface CompanyRow {
  company_id: string;
  domain: string;
  organisation_name: string | null;
  first_observed_at: Date;
  last_observed_at: Date;
  observation_count: string;
}

function toSummary(r: CompanyRow): CompanyActivitySummary {
  return {
    companyId: Number(r.company_id),
    domain: r.domain,
    organisationName: r.organisation_name,
    firstObservedAt: r.first_observed_at,
    lastObservedAt: r.last_observed_at,
    observationCount: Number(r.observation_count),
  };
}

function checkLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new DbError("INVALID_LIMIT");
  return limit;
}

function checkId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new DbError("INVALID_ID");
  return id;
}

export function createReportingRepository(pool: Pool, logger?: Logger): ReportingRepository {
  return {
    async listCompanies(scope, page): Promise<Page<CompanyActivitySummary, CompaniesCursor>> {
      const limit = checkLimit(page.limit);
      if (page.order !== "id" && page.order !== "recent") throw new DbError("INVALID_ORDER");
      if (page.cursor) {
        checkId(page.cursor.companyId);
        if (page.cursor.order !== page.order) throw new DbError("INVALID_CURSOR");
      }
      return guarded(logger, async () => {
        // Fetch one extra row to know whether a next page exists.
        const res =
          page.order === "id"
            ? await pool.query<CompanyRow>(LIST_COMPANIES_BY_ID_SQL, [scope.installationId, scope.websiteId, page.cursor?.companyId ?? null, limit + 1])
            : await pool.query<CompanyRow>(LIST_COMPANIES_RECENT_SQL, [
                scope.installationId,
                scope.websiteId,
                page.cursor?.order === "recent" ? page.cursor.lastObservedAt : null,
                page.cursor?.companyId ?? null,
                limit + 1,
              ]);
        const rows = res.rows.slice(0, limit).map(toSummary);
        const last = rows[rows.length - 1];
        let nextCursor: CompaniesCursor | null = null;
        if (res.rows.length > limit && last) {
          nextCursor = page.order === "id" ? { order: "id", companyId: last.companyId } : { order: "recent", lastObservedAt: last.lastObservedAt, companyId: last.companyId };
        }
        return { items: rows, nextCursor };
      });
    },

    async getCompany(scope, companyId) {
      checkId(companyId);
      return guarded(logger, async () => {
        const res = await pool.query<CompanyRow>(GET_COMPANY_SQL, [scope.installationId, scope.websiteId, companyId]);
        const r = res.rows[0];
        return r ? toSummary(r) : null;
      });
    },

    async listObservations(scope, companyId, page): Promise<Page<ObservationItem, ObservationsCursor>> {
      checkId(companyId);
      const limit = checkLimit(page.limit);
      if (page.cursor) checkId(page.cursor.observationId);
      return guarded(logger, async () => {
        const res = await pool.query<{ id: string; observed_at: Date; source: "cache" | "provider"; observation_ref: string; company_first: boolean }>(
          LIST_OBSERVATIONS_SQL,
          [scope.installationId, scope.websiteId, companyId, page.cursor?.observedAt ?? null, page.cursor?.observationId ?? null, limit + 1],
        );
        const rows: ObservationItem[] = res.rows.slice(0, limit).map((r) => ({
          observationId: Number(r.id),
          observedAt: r.observed_at,
          source: r.source,
          observationRef: r.observation_ref,
          companyFirst: r.company_first,
        }));
        const last = rows[rows.length - 1];
        const nextCursor = res.rows.length > limit && last ? { observedAt: last.observedAt, observationId: last.observationId } : null;
        return { items: rows, nextCursor };
      });
    },

    async summary(scope, range): Promise<ActivitySummary> {
      if (!(range.from < range.to)) throw new DbError("INVALID_RANGE");
      return guarded(logger, async () => {
        const res = await pool.query<{ observations: string; observed_companies: string; newly_observed_companies: string }>(SUMMARY_SQL, [
          scope.installationId,
          scope.websiteId,
          range.from,
          range.to,
        ]);
        const r = res.rows[0];
        const observations = Number(r?.observations ?? 0);
        const observedCompanies = Number(r?.observed_companies ?? 0);
        const newlyObservedCompanies = Number(r?.newly_observed_companies ?? 0);
        return { observations, observedCompanies, newlyObservedCompanies, previouslyObservedCompanies: observedCompanies - newlyObservedCompanies };
      });
    },

    async feed(scope, page): Promise<FeedPage> {
      const limit = page.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) throw new DbError("INVALID_LIMIT");
      if (page.after) checkFeedPosition(page.after);
      const b = feedBounds(page.after);
      return guarded(logger, async () => {
        // One extra row tells whether more finished items exist right now.
        const res = await pool.query<FeedRow>(FEED_SQL, [scope.installationId, scope.websiteId, b.obs[0], b.obs[1], b.tomb[0], b.tomb[1], limit + 1]);
        const meta = res.rows[0];
        if (!meta) throw new DbError("FEED_META");
        const horizon = BigInt(meta.horizon);
        // Retention watermark, read in the same snapshot as the rows: a
        // position strictly before it may have lost items to pruning.
        if (page.after && meta.wm_txid !== null && meta.wm_id !== null) {
          const watermark: FeedPosition = { txid: BigInt(meta.wm_txid), kind: FEED_KIND_OBSERVATION, id: BigInt(meta.wm_id) };
          if (compareFeedPositions(page.after, watermark) < 0) return { items: [], hasMore: false, expired: true, horizon };
        }
        const rows = res.rows.filter((r) => r.txid !== null);
        const items = rows.slice(0, limit).map(toFeedRecord);
        return { items, hasMore: rows.length > limit, expired: false, horizon };
      });
    },

    async feedWatermark(scope): Promise<FeedPosition | null> {
      return guarded(logger, () => queryFeedWatermark(pool, scope));
    },
  };
}
