/**
 * Test-only lock diagnostic for the test-database reset (Gate 5 CI reliability).
 *
 * In CI run 41726689310 (attempt 1), `resetTestDb` timed out three times in
 * `feed-commit-order.test.ts`. The PostgreSQL log showed the reset TRUNCATE
 * waiting on a lock until statement_timeout cancelled it, but not WHO held the
 * lock. When a reset times out again, this reports every other backend in the
 * test database that holds or awaits a lock on a reset table or has an open
 * transaction:
 *
 *   pid, application_name, backend_type, state, wait_event_type, wait_event,
 *   transaction age, state age, how many backends block it, whether it is one
 *   of this test process's own pool connections, and its relation locks on the
 *   reset tables (relation, mode, granted).
 *
 * Redaction: the query text never leaves the server. Only its leading SQL
 * keyword (`statement_kind`, for example SELECT or TRUNCATE) is selected; no
 * literal, parameter, identifier list or connection detail is read or printed.
 *
 * It never throws and never changes the reset's outcome: it uses its own
 * short-lived connection with tight timeouts, and the caller rethrows the
 * original error unchanged. Nothing here is imported by production code.
 */
import pg from "pg";

/** Tables truncated by RESET_TABLES_SQL. Kept in step with it by a test. */
export const RESET_TABLE_NAMES = [
  "feed_tombstones",
  "feed_retention_watermarks",
  "company_observation_refs",
  "company_observations",
  "company_scope_stats",
  "ip_resolution_cache",
  "companies",
  "usage_periods",
  "deployment_controls",
  "browser_events",
] as const;

export interface LockHolder {
  pid: number;
  application_name: string;
  backend_type: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_age_ms: number | null;
  state_age_ms: number | null;
  statement_kind: string | null;
  blocked_by_count: number;
  own_pool: boolean;
  locks: { relation: string; mode: string; granted: boolean }[];
}

export type ResetLockDiagnostic =
  | { event: "reset_lock_diagnostic"; reset_pid: number | null; error_kind: string; holders: LockHolder[] }
  | { event: "reset_lock_diagnostic"; reset_pid: number | null; error_kind: string; diagnostic_failed: string };

const DIAGNOSTIC_TIMEOUT_MS = 1_500;

const HOLDERS_SQL = `
WITH reset_tables AS (
  SELECT c.oid, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
), rel_locks AS (
  SELECT l.pid, rt.relname, l.mode, l.granted
  FROM pg_locks l JOIN reset_tables rt ON rt.oid = l.relation
  WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
)
SELECT a.pid,
       coalesce(a.application_name, '') AS application_name,
       a.backend_type,
       a.state,
       a.wait_event_type,
       a.wait_event,
       round(extract(epoch FROM (clock_timestamp() - a.xact_start)) * 1000)::bigint AS xact_age_ms,
       round(extract(epoch FROM (clock_timestamp() - a.state_change)) * 1000)::bigint AS state_age_ms,
       upper(substring(ltrim(coalesce(a.query, '')) FROM '^[A-Za-z]+')) AS statement_kind,
       cardinality(pg_blocking_pids(a.pid)) AS blocked_by_count,
       coalesce(
         (SELECT json_agg(json_build_object('relation', rl.relname, 'mode', rl.mode, 'granted', rl.granted) ORDER BY rl.relname, rl.mode)
          FROM rel_locks rl WHERE rl.pid = a.pid),
         '[]'::json) AS locks
FROM pg_stat_activity a
WHERE a.datname = current_database()
  AND a.pid <> pg_backend_pid()
  AND (a.xact_start IS NOT NULL OR EXISTS (SELECT 1 FROM rel_locks rl WHERE rl.pid = a.pid))
ORDER BY xact_age_ms DESC NULLS LAST, a.pid`;

/** True for the failures a lock wait produces: statement_timeout or cancel (57014), lock_not_available (55P03), or node-postgres's client-side query_timeout. */
export function isResetTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === "57014" || e?.code === "55P03" || e?.message === "Query read timeout";
}

function errorKind(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string") return e.code;
  return e?.message === "Query read timeout" ? "client_query_timeout" : "other";
}

/** PIDs of the pool's current connections (node-postgres keeps them in a private list; best effort, test-only). */
export function poolBackendPids(pool: pg.Pool): number[] {
  const clients = (pool as unknown as { _clients?: { processID?: number | null }[] })._clients ?? [];
  return clients.map((c) => c.processID).filter((p): p is number => typeof p === "number");
}

/** Collects the diagnostic. Never throws: a failure is reported as `diagnostic_failed` with an error code only. */
export async function collectResetLockDiagnostic(opts: { connectionString: string; resetPid: number | null; ownPoolPids: number[]; error: unknown }): Promise<ResetLockDiagnostic> {
  const base = { event: "reset_lock_diagnostic" as const, reset_pid: opts.resetPid, error_kind: errorKind(opts.error) };
  const client = new pg.Client({
    connectionString: opts.connectionString,
    application_name: "idr-test-lock-diagnostic",
    connectionTimeoutMillis: DIAGNOSTIC_TIMEOUT_MS,
    statement_timeout: DIAGNOSTIC_TIMEOUT_MS,
    query_timeout: DIAGNOSTIC_TIMEOUT_MS + 500,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const r = await client.query<Omit<LockHolder, "own_pool" | "xact_age_ms" | "state_age_ms"> & { xact_age_ms: string | null; state_age_ms: string | null }>(HOLDERS_SQL, [RESET_TABLE_NAMES]);
    const own = new Set(opts.ownPoolPids);
    const holders: LockHolder[] = r.rows.map((row) => ({
      ...row,
      xact_age_ms: row.xact_age_ms === null ? null : Number(row.xact_age_ms),
      state_age_ms: row.state_age_ms === null ? null : Number(row.state_age_ms),
      blocked_by_count: Number(row.blocked_by_count),
      own_pool: own.has(row.pid),
    }));
    return { ...base, holders };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return { ...base, diagnostic_failed: typeof code === "string" ? code : "unavailable" };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Default sink: one line on stderr, which vitest prints with the failing test. */
export function printResetLockDiagnostic(d: ResetLockDiagnostic): void {
  console.error(`[resetTestDb] ${JSON.stringify(d)}`);
}
