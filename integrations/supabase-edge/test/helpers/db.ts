import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ApplyPageArgs, ApplyPageResult, LocalCounts, RecordStatusArgs, Store, SyncState } from "../../src/core/index.ts";

export const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test_edge";
export const INSTALLATION = "inst_test";

const SQL_PATH = fileURLToPath(new URL("../../sql/0001_idr_projection.sql", import.meta.url));

export function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DB_URL, max: 8 });
}

/** Recreates the public schema, the Supabase roles (if missing) and applies the SQL template. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
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
    await c.query("drop schema public cascade");
    await c.query("create schema public");
    await c.query("grant usage on schema public to anon, authenticated, service_role");
    await c.query(readFileSync(SQL_PATH, "utf8"));
  } finally {
    c.release();
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("truncate public.idr_observations, public.idr_tombstones, public.idr_companies, public.idr_sync_state");
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
      c.query<{ s: { cursor: string | null; needs_resync: boolean } }>("select public.idr_get_sync_state($1) as s", [this.installationId]),
    );
    const s = r.rows[0]!.s;
    return { cursor: s.cursor, needsResync: s.needs_resync };
  }

  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    const r = await asRole(this.pool, "service_role", (c) =>
      c.query<{ r: { applied: boolean; observations?: number; tombstones?: number } }>(
        "select public.idr_apply_feed_page($1,$2,$3,$4::jsonb) as r",
        [this.installationId, a.expectedCursor, a.nextCursor, JSON.stringify(a.items)],
      ),
    );
    const v = r.rows[0]!.r;
    return { applied: v.applied, observations: v.observations ?? 0, tombstones: v.tombstones ?? 0 };
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
