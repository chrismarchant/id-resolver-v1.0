/**
 * Daily counters of the watch-only source comparison (implements
 * ShadowRepository, migration 0015). Every statement reads or writes
 * `source_shadow_counts` and nothing else. The table holds numbers per
 * (installation, website, UTC day, metric): no address, fingerprint, name or
 * domain can reach it, and metric names are checked against the closed list
 * SHADOW_METRICS before any statement runs.
 *
 * Quota reservation: one INSERT ... ON CONFLICT DO UPDATE ... WHERE count <
 * limit RETURNING. Under READ COMMITTED the conflicting row is locked and the
 * WHERE re-evaluated against the latest committed count, so concurrent callers
 * (several workers, several instances) never reserve more than the limit.
 */
import type { ShadowDayCounts, ShadowRepository } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { API_SOURCES, isShadowMetric, SHADOW_METRICS, type ApiSource, type ShadowMetric, type ShadowScope } from "../shadow/types.js";
import { DbError, guarded, type Pool } from "./pool.js";

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A year of days with every metric: far above the reporting route's 31-day range. */
export const MAX_SHADOW_REPORT_ROWS = 366 * SHADOW_METRICS.length;

/** $1 installation, $2 website, $3 day, $4 metric (<source>_requests), $5 limit. */
export const RESERVE_SOURCE_REQUEST_SQL = `
INSERT INTO source_shadow_counts (installation_id, website_id, day, metric, count)
SELECT $1::text, $2::text, $3::date, $4::text, 1
WHERE $5::bigint > 0
ON CONFLICT (installation_id, website_id, day, metric) DO UPDATE SET
  count = source_shadow_counts.count + 1
WHERE source_shadow_counts.count < $5::bigint
RETURNING count`;

/** $1 installation, $2 website, $3 day, $4 metrics, $5 deltas (same length). Rows in metric order, so concurrent writers lock in one order. */
export const INCREMENT_SHADOW_SQL = `
INSERT INTO source_shadow_counts (installation_id, website_id, day, metric, count)
SELECT $1::text, $2::text, $3::date, m.metric, m.n
FROM unnest($4::text[], $5::bigint[]) AS m(metric, n)
ORDER BY m.metric
ON CONFLICT (installation_id, website_id, day, metric) DO UPDATE SET
  count = source_shadow_counts.count + EXCLUDED.count`;

/** $1 installation, $2 website, $3 from, $4 to (inclusive). */
export const REPORT_SHADOW_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, count::text AS count
FROM source_shadow_counts
WHERE installation_id = $1::text AND website_id = $2::text
  AND day >= $3::date AND day <= $4::date
ORDER BY day, metric
LIMIT ${MAX_SHADOW_REPORT_ROWS}`;

function checkDay(day: string): void {
  if (typeof day !== "string" || !DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new DbError("INVALID_DAY");
}

export function createShadowRepository(pool: Pick<Pool, "query">, logger?: Logger): ShadowRepository {
  return {
    async reserveSourceRequest(scope: ShadowScope, source: ApiSource, limit: number): Promise<boolean> {
      if (!(API_SOURCES as readonly string[]).includes(source)) throw new DbError("INVALID_SOURCE");
      if (!Number.isSafeInteger(limit) || limit < 0) throw new DbError("INVALID_LIMIT");
      checkDay(scope.day);
      const metric: ShadowMetric = `${source}_requests`;
      return guarded(logger, async () => {
        const res = await pool.query(RESERVE_SOURCE_REQUEST_SQL, [scope.installationId, scope.websiteId, scope.day, metric, limit]);
        return (res.rowCount ?? 0) > 0;
      });
    },

    async increment(scope: ShadowScope, metrics: readonly ShadowMetric[]): Promise<void> {
      checkDay(scope.day);
      const counts = new Map<ShadowMetric, number>();
      for (const m of metrics) {
        if (!isShadowMetric(m)) throw new DbError("INVALID_METRIC");
        counts.set(m, (counts.get(m) ?? 0) + 1);
      }
      if (counts.size === 0) return;
      const names = [...counts.keys()].sort();
      const deltas = names.map((n) => counts.get(n)!);
      await guarded(logger, async () => {
        await pool.query(INCREMENT_SHADOW_SQL, [scope.installationId, scope.websiteId, scope.day, names, deltas]);
      });
    },

    async report(installationId: string, websiteId: string, from: string, to: string): Promise<ShadowDayCounts[]> {
      checkDay(from);
      checkDay(to);
      return guarded(logger, async () => {
        const res = await pool.query<{ day: string; metric: string; count: string }>(REPORT_SHADOW_SQL, [installationId, websiteId, from, to]);
        const days: ShadowDayCounts[] = [];
        for (const r of res.rows) {
          // Only listed metrics leave the database (the table's CHECK allows any token).
          if (!isShadowMetric(r.metric)) continue;
          let d = days[days.length - 1];
          if (!d || d.date !== r.day) {
            d = { date: r.day, metrics: {} };
            days.push(d);
          }
          d.metrics[r.metric] = Number(r.count);
        }
        return days;
      });
    },
  };
}
