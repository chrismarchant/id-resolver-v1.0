/**
 * Read-only database checks for the events phase of the development smoke
 * test (src/ops/smoke-events.ts): what the event requests stored, and proof
 * that they stored nothing else (owner decision D4: browser events are never
 * associated with companies).
 *
 * Every query here is a parameterised SELECT run inside `BEGIN READ ONLY`,
 * so the database itself refuses any write from this module. Errors are
 * reduced to a sanitised code (guarded); nothing is printed and the callers
 * report counts and enums only, never a value read here.
 *
 * Scoping, so concurrent development traffic cannot cause a false failure:
 *   - browser_events rows are selected by this run's own page_key;
 *   - company observations are selected by this run's page_key prefix, which
 *     no other caller uses;
 *   - the same-transaction check looks only at rows written by the very
 *     transactions that inserted this run's events (their xmin);
 *   - the high-water-mark window is reported as inconclusive (skipped), never
 *     failed, when resolver traffic ran during the window or the settle
 *     period before it (usage counters), or a reservation was in flight at
 *     any snapshot. The settle period covers a job that counted its request
 *     just before the window and writes inside it: with the mock provider a
 *     job's writes follow its count within milliseconds, and a job still
 *     waiting on the provider holds a pending reservation.
 */
import { guarded, type Pool } from "../db/pool.js";

export interface EventsDbScope {
  installationId: string;
  websiteId: string;
}

/** The browser_events columns of migration 0008, exactly. */
export const BROWSER_EVENT_COLUMNS = ["consent", "event_id", "id", "installation_id", "name", "occurred_at", "origin", "page_key", "received_at", "type", "website_id"] as const;

/** Tables the event path must never write (every table of the resolution and feed side). */
export const NON_EVENT_TABLES = [
  "companies",
  "company_observations",
  "company_observation_refs",
  "company_scope_stats",
  "ip_resolution_cache",
  "usage_periods",
  "deployment_controls",
  "feed_tombstones",
  "feed_retention_watermarks",
] as const;

/** High-water marks of the resolution side, and the resolver activity that could legitimately move them. */
export interface ResolutionSnapshot {
  companiesMaxId: bigint;
  observationsMaxId: bigint;
  cacheRows: bigint;
  /** Latest checked_at in the cache as epoch ms (-1 when empty). */
  cacheLatestCheckedMs: number;
  /** Entrance jobs started for this scope, all periods (src/resolution/pipeline.ts counts one per job before anything else). */
  resolverRequests: bigint;
  /** Cache rows currently reserved by an in-flight resolution. */
  pendingCacheRows: bigint;
}

export interface StoredEventRow {
  /** The row as JSON (to_jsonb): every column, with its value. */
  row: Record<string, unknown>;
  /** The inserting transaction's id (system column xmin), as text. */
  xid: string;
}

export const SNAPSHOT_SQL = `
SELECT
  (SELECT coalesce(max(id), 0)::text FROM companies) AS companies_max_id,
  (SELECT coalesce(max(id), 0)::text FROM company_observations) AS observations_max_id,
  (SELECT count(*)::text FROM ip_resolution_cache) AS cache_rows,
  (SELECT coalesce((extract(epoch FROM max(checked_at)) * 1000)::bigint, -1)::text FROM ip_resolution_cache) AS cache_latest_checked_ms,
  (SELECT count(*)::text FROM ip_resolution_cache WHERE status = 'pending') AS pending_cache_rows,
  (SELECT coalesce(sum(resolver_requests), 0)::text FROM usage_periods WHERE installation_id = $1::text AND website_id = $2::text) AS resolver_requests`;

/** $1 installation, $2 website, $3 page_key. */
export const RUN_EVENTS_SQL = `
SELECT to_jsonb(b) AS row, b.xmin::text AS xid
FROM browser_events b
WHERE b.installation_id = $1::text AND b.website_id = $2::text AND b.page_key = $3::text
ORDER BY b.id`;

/** $1 installation, $2 website, $3 the event page_key, $4 observation id high-water mark, $5 this run's page_key (`/smoke/<run>`; it and every path below it count). */
export const RUN_OBSERVATIONS_SQL = `
SELECT
  count(*) FILTER (WHERE page_key = $3::text)::int AS with_event_page_key,
  count(*) FILTER (WHERE id > $4::bigint AND (page_key = $5::text OR starts_with(page_key, $5::text || '/')))::int AS run_since_mark
FROM company_observations
WHERE installation_id = $1::text AND website_id = $2::text`;

/** $1 the inserting transaction ids (text). One count per table in NON_EVENT_TABLES. */
export const SAME_TRANSACTION_SQL = `SELECT ${NON_EVENT_TABLES.map((t) => `(SELECT count(*) FROM ${t} WHERE xmin::text = ANY($1::text[]))::int AS ${t}`).join(",\n  ")}`;

async function readOnly<T>(pool: Pool, fn: (q: Pool["query"]) => Promise<T>): Promise<T> {
  return guarded(undefined, async () => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN READ ONLY");
      const out = await fn(client.query.bind(client) as Pool["query"]);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      broken = true;
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release(broken);
    }
  });
}

export interface EventsDbProbe {
  snapshot(): Promise<ResolutionSnapshot>;
  runEvents(pageKey: string): Promise<StoredEventRow[]>;
  runObservations(eventPageKey: string, observationsMark: bigint, runPrefix: string): Promise<{ withEventPageKey: number; runSinceMark: number }>;
  /** Rows of each NON_EVENT_TABLES table whose current version was written by one of `xids`. */
  writtenByTransactions(xids: string[]): Promise<Record<(typeof NON_EVENT_TABLES)[number], number>>;
}

export function createEventsDbProbe(pool: Pool, scope: EventsDbScope): EventsDbProbe {
  return {
    snapshot: () =>
      readOnly(pool, async (q) => {
        const r = (await q(SNAPSHOT_SQL, [scope.installationId, scope.websiteId])).rows[0] as Record<string, string>;
        return {
          companiesMaxId: BigInt(r["companies_max_id"]!),
          observationsMaxId: BigInt(r["observations_max_id"]!),
          cacheRows: BigInt(r["cache_rows"]!),
          cacheLatestCheckedMs: Number(r["cache_latest_checked_ms"]!),
          resolverRequests: BigInt(r["resolver_requests"]!),
          pendingCacheRows: BigInt(r["pending_cache_rows"]!),
        };
      }),
    runEvents: (pageKey) =>
      readOnly(pool, async (q) => {
        const res = await q(RUN_EVENTS_SQL, [scope.installationId, scope.websiteId, pageKey]);
        return (res.rows as { row: Record<string, unknown>; xid: string }[]).map((r) => ({ row: r.row, xid: r.xid }));
      }),
    runObservations: (eventPageKey, observationsMark, runPrefix) =>
      readOnly(pool, async (q) => {
        const r = (await q(RUN_OBSERVATIONS_SQL, [scope.installationId, scope.websiteId, eventPageKey, observationsMark.toString(), runPrefix])).rows[0] as {
          with_event_page_key: number;
          run_since_mark: number;
        };
        return { withEventPageKey: r.with_event_page_key, runSinceMark: r.run_since_mark };
      }),
    writtenByTransactions: (xids) =>
      readOnly(pool, async (q) => (await q(SAME_TRANSACTION_SQL, [xids])).rows[0] as Record<(typeof NON_EVENT_TABLES)[number], number>),
  };
}

/** What the window between two snapshots shows. */
export type WindowVerdict =
  | { kind: "quiet" }
  /** Resolution-side rows appeared although no resolver job ran: something else (the event path) wrote them. */
  | { kind: "written_without_resolver_traffic"; grew: string[] }
  /** Resolution-side rows appeared, but resolver traffic ran too: cannot be attributed. */
  | { kind: "inconclusive_concurrent_traffic"; grew: string[] };

/**
 * Compares the snapshots taken around the event requests. Growth is an
 * insert (a higher id, more cache rows, or a later checked_at); deletions by
 * the maintenance run only lower these marks, so they never count. Resolver
 * traffic is counted from `since` (the start of the settle period before the
 * window; defaults to `before`).
 */
export function windowVerdict(before: ResolutionSnapshot, after: ResolutionSnapshot, since: ResolutionSnapshot = before): WindowVerdict {
  const grew: string[] = [];
  if (after.companiesMaxId > before.companiesMaxId) grew.push("companies");
  if (after.observationsMaxId > before.observationsMaxId) grew.push("company_observations");
  if (after.cacheRows > before.cacheRows || after.cacheLatestCheckedMs > before.cacheLatestCheckedMs) grew.push("ip_resolution_cache");
  if (grew.length === 0) return { kind: "quiet" };
  const traffic =
    after.resolverRequests > since.resolverRequests || since.pendingCacheRows > 0n || before.pendingCacheRows > 0n || after.pendingCacheRows > 0n;
  return traffic ? { kind: "inconclusive_concurrent_traffic", grew } : { kind: "written_without_resolver_traffic", grew };
}
