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
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

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
  };
}
