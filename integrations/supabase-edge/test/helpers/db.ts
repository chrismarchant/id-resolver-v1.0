import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ApplyPageArgs, ApplyPageResult, LocalCounts, RecordGapArgs, RecordGapResult, RecordStatusArgs, Store, SyncState } from "../../src/core/index.ts";

export const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test_edge";
export const INSTALLATION = "inst_test";

export const SQL_PATH = fileURLToPath(new URL("../../sql/0001_idr_projection.sql", import.meta.url));

export function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DB_URL, max: 8 });
}

/** Recreates the public schema, the Supabase roles (if missing) and applies the SQL template. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await ensureProjection(pool);
}

/**
 * Non-destructive: the Supabase roles and auth.jwt() (if missing), and the
 * SQL template applied (it is idempotent) to whatever public schema exists.
 * Used directly by suites that share the database with other tables.
 */
export async function ensureProjection(pool: pg.Pool, sqlPath: string = SQL_PATH): Promise<void> {
  const c = await pool.connect();
  try {
    for (const [role, extra] of [["anon", ""], ["authenticated", ""], ["service_role", "BYPASSRLS"]] as const) {
      await c.query(
        `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} NOLOGIN ${extra}; end if; end $$`,
      );
    }
    // Emulate Supabase's auth.jwt() (only if missing, so a real Supabase schema is never touched).
    await c.query("create schema if not exists auth");
    await c.query(
      `do $$ begin
         if to_regprocedure('auth.jwt()') is null then
           create function auth.jwt() returns jsonb language sql stable as
             $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
         end if;
       end $$`,
    );
    await c.query("grant usage on schema auth to anon, authenticated, service_role");
    await c.query("grant execute on function auth.jwt() to anon, authenticated, service_role");
    await c.query("grant usage on schema public to anon, authenticated, service_role");
    await c.query(readFileSync(sqlPath, "utf8"));
  } finally {
    c.release();
  }
}

/**
 * Empties every projection table. idr_sync_gaps is append-only (its guard
 * trigger rejects TRUNCATE), so the reset runs with
 * session_replication_role = replica for this transaction only: a test-only
 * bypass that needs superuser (the test role and CI's POSTGRES_USER are).
 */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("truncate public.idr_observations, public.idr_tombstones, public.idr_companies, public.idr_sync_state, public.idr_sync_gaps restart identity");
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export interface GapRow {
  id: number;
  installation_id: string;
  kind: string;
  detected_at: Date;
  expired_cursor: string | null;
  last_applied_at: Date | null;
  last_observed_at: Date | null;
  resolved_at: Date | null;
  resolution: string | null;
  /** null for rows of earlier releases, and before the upgrade that adds the column. */
  detected_generation: number | null;
}

export async function gapRows(pool: pg.Pool): Promise<GapRow[]> {
  const r = await pool.query<GapRow>(
    "select g.id::int as id, g.installation_id, g.kind, g.detected_at, g.expired_cursor, g.last_applied_at, g.last_observed_at, g.resolved_at, g.resolution, (to_jsonb(g) ->> 'detected_generation')::int as detected_generation from public.idr_sync_gaps g order by g.id",
  );
  return r.rows;
}

/** Runs fn in a transaction as the given role. */
export async function asRole<T>(
  pool: pg.Pool,
  role: string,
  fn: (c: pg.PoolClient) => Promise<T>,
  claims?: Record<string, unknown>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    if (claims) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Test Store that calls the same SQL functions as service_role over pg. */
export class PgStore implements Store {
  constructor(
    private readonly pool: pg.Pool,
    private readonly installationId = INSTALLATION,
  ) {}

  async getState(): Promise<SyncState> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ s: { cursor: string | null; needs_resync: boolean; gap_open?: boolean; reset_from_cursor?: string | null } }>(
        "select public.idr_get_sync_state($1) as s",
        [this.installationId],
      ),
    );
    const s = r.rows[0]!.s;
    return { cursor: s.cursor, needsResync: s.needs_resync, gapOpen: s.gap_open === true, resetFromCursor: s.reset_from_cursor ?? null };
  }

  async recordGap(a: RecordGapArgs): Promise<RecordGapResult> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { recorded: boolean; new: boolean; superseded: boolean } }>("select public.idr_record_sync_gap($1,$2,$3) as r", [
        this.installationId,
        a.kind,
        a.expectedCursor,
      ]),
    );
    const v = r.rows[0]!.r;
    return { recorded: v.recorded, newGap: v.new, superseded: v.superseded };
  }

  async resolveGaps(drainedCursor: string): Promise<number> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { resolved: number } }>("select public.idr_resolve_sync_gaps($1,$2) as r", [this.installationId, drainedCursor]),
    );
    return r.rows[0]!.r.resolved;
  }

  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { applied: boolean; observations?: number; tombstones?: number } }>(
        "select public.idr_apply_feed_page($1,$2,$3,$4::jsonb,$5) as r",
        [this.installationId, a.expectedCursor, a.nextCursor, JSON.stringify(a.items), a.expectedResetFrom],
      ),
    );
    const v = r.rows[0]!.r;
    return { applied: v.applied, observations: v.observations ?? 0, tombstones: v.tombstones ?? 0 };
  }

  async resetCursor(expectedCursor: string): Promise<boolean> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { applied: boolean } }>("select public.idr_reset_cursor($1,$2) as r", [this.installationId, expectedCursor]),
    );
    return r.rows[0]!.r.applied;
  }

  async recordStatus(a: RecordStatusArgs): Promise<void> {
    await asRole(this.pool, "service_role", (c) =>
      c.query("select public.idr_record_sync_status($1,$2,$3)", [this.installationId, a.status, a.needsResync]),
    );
  }

  async localCounts(fromDay: string, toDay: string): Promise<LocalCounts> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { observations: number; observed_companies: number } }>("select public.idr_reconcile_counts($1,$2,$3) as r", [
        this.installationId,
        fromDay,
        toDay,
      ]),
    );
    return { observations: r.rows[0]!.r.observations, observedCompanies: r.rows[0]!.r.observed_companies };
  }
}

export async function counts(pool: pg.Pool): Promise<{ companies: number; observations: number; tombstones: number }> {
  const r = await pool.query<{ c: string; o: string; t: string }>(
    "select (select count(*) from public.idr_companies) c, (select count(*) from public.idr_observations) o, (select count(*) from public.idr_tombstones) t",
  );
  const row = r.rows[0]!;
  return { companies: Number(row.c), observations: Number(row.o), tombstones: Number(row.t) };
}

export async function storedCursor(pool: pg.Pool): Promise<string | null> {
  const r = await pool.query<{ cursor: string | null }>("select cursor from public.idr_sync_state where installation_id = $1", [INSTALLATION]);
  return r.rows[0]?.cursor ?? null;
}
