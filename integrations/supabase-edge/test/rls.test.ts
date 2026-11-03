import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INSTALLATION, asRole, newPool, resetDatabase, truncateAll } from "./helpers/db.ts";

let pool: pg.Pool;
const TABLES = ["idr_companies", "idr_observations", "idr_tombstones", "idr_sync_state", "idr_sync_gaps"];
const FUNCS = [
  "idr_schema_version()",
  "idr_get_sync_state(text)",
  "idr_apply_feed_page(text,text,text,jsonb,text)",
  "idr_record_sync_status(text,text,boolean)",
  "idr_begin_resync(text)",
  "idr_reset_cursor(text,text)",
  "idr_reconcile_counts(text,date,date)",
  "idr_record_sync_gap(text,text,text)",
  "idr_resolve_sync_gaps(text,text)",
];
/** Trigger functions cannot be called directly; only their ACL is checked. */
const TRIGGER_FUNCS = ["idr_sync_gaps_guard()"];

beforeAll(async () => {
  pool = newPool();
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query("insert into public.idr_companies (installation_id, company_id, domain) values ($1, 1, 'example.com')", [INSTALLATION]);
  await pool.query(
    "insert into public.idr_observations (installation_id, observation_id, company_id, observed_at, method) values ($1, 1, 1, '2026-11-02T10:00:00Z', 'cache')",
    [INSTALLATION],
  );
  await pool.query("insert into public.idr_tombstones (installation_id, tombstone_id, company_id, erased_at) values ($1, 1, 9, '2026-11-02T11:00:00Z')", [INSTALLATION]);
  await pool.query("insert into public.idr_sync_state (installation_id) values ($1)", [INSTALLATION]);
  await pool.query("insert into public.idr_sync_gaps (installation_id, kind) values ($1, 'cursor_expired')", [INSTALLATION]);
});

describe("row level security", () => {
  it("is enabled on every table", async () => {
    const r = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'",
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
    for (const row of r.rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("anon cannot select anything", async () => {
    for (const t of [...TABLES, "idr_daily_company_activity"]) {
      await expect(asRole(pool, "anon", (c) => c.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
  });

  const READER = { role: "authenticated", app_metadata: { idr_reader: true } };
  const signedUp = { role: "authenticated", sub: "u1", user_metadata: { idr_reader: true }, app_metadata: { provider: "email" } };

  it("an authenticated session WITHOUT the idr_reader claim sees 0 rows (open sign-up model)", async () => {
    for (const claims of [undefined, {}, signedUp, { app_metadata: { idr_reader: "yes" } }, { app_metadata: { idr_reader: false } }]) {
      for (const t of TABLES) {
        const r = await asRole(pool, "authenticated", (c) => c.query(`select count(*)::int as n from public.${t}`), claims);
        expect(r.rows[0].n, `${t} ${JSON.stringify(claims)}`).toBe(0);
      }
      const v = await asRole(pool, "authenticated", (c) => c.query("select * from public.idr_daily_company_activity"), claims);
      expect(v.rows, JSON.stringify(claims)).toEqual([]);
    }
  });

  it("authenticated WITH app_metadata.idr_reader can read (tables and the view) but cannot write", async () => {
    for (const t of TABLES) {
      const r = await asRole(pool, "authenticated", (c) => c.query(`select count(*)::int as n from public.${t}`), READER);
      expect(r.rows[0].n, t).toBe(1);
    }
    const v = await asRole(pool, "authenticated", (c) => c.query("select entrances from public.idr_daily_company_activity"), READER);
    expect(v.rows).toEqual([{ entrances: "1" }]);

    const writes = [
      "insert into public.idr_companies (installation_id, company_id, domain) values ('x', 2, 'example.org')",
      "update public.idr_companies set domain = 'example.net'",
      "delete from public.idr_observations",
      "delete from public.idr_tombstones",
      "update public.idr_sync_state set cursor = 'c99'",
      "truncate public.idr_observations",
      "insert into public.idr_sync_gaps (installation_id, kind) values ('x', 'cursor_expired')",
      "update public.idr_sync_gaps set resolved_at = now(), resolution = 'full_resync'",
      "delete from public.idr_sync_gaps",
    ];
    for (const w of writes) await expect(asRole(pool, "authenticated", (c) => c.query(w), READER), w).rejects.toThrow(/permission denied/);
  });

  it("RLS alone blocks writes even if a table privilege were granted", async () => {
    await pool.query("grant insert, update, delete on public.idr_companies to authenticated");
    try {
      await expect(
        asRole(pool, "authenticated", (c) => c.query("insert into public.idr_companies (installation_id, company_id, domain) values ('x', 2, 'example.org')"), READER),
      ).rejects.toThrow(/row-level security/);
      const upd = await asRole(pool, "authenticated", (c) => c.query("update public.idr_companies set domain = 'example.net'"), READER);
      expect(upd.rowCount).toBe(0);
      const del = await asRole(pool, "authenticated", (c) => c.query("delete from public.idr_companies"), READER);
      expect(del.rowCount).toBe(0);
    } finally {
      await pool.query("revoke insert, update, delete on public.idr_companies from authenticated");
    }
  });

  it("only service_role can execute the functions", async () => {
    const calls: Record<string, [string, unknown[]]> = {
      "idr_schema_version()": ["select public.idr_schema_version()", []],
      "idr_get_sync_state(text)": ["select public.idr_get_sync_state($1)", [INSTALLATION]],
      "idr_apply_feed_page(text,text,text,jsonb,text)": ["select public.idr_apply_feed_page($1, null, 'c1', '[]'::jsonb, null)", [INSTALLATION]],
      "idr_record_sync_status(text,text,boolean)": ["select public.idr_record_sync_status($1, 'ok', null)", [INSTALLATION]],
      "idr_begin_resync(text)": ["select public.idr_begin_resync($1)", [INSTALLATION]],
      "idr_reset_cursor(text,text)": ["select public.idr_reset_cursor($1, 'c9')", [INSTALLATION]],
      "idr_reconcile_counts(text,date,date)": ["select public.idr_reconcile_counts($1, '2026-11-01', '2026-11-02')", [INSTALLATION]],
      "idr_record_sync_gap(text,text,text)": ["select public.idr_record_sync_gap($1, 'cursor_expired', null)", [INSTALLATION]],
      "idr_resolve_sync_gaps(text,text)": ["select public.idr_resolve_sync_gaps($1, 'c1')", [INSTALLATION]],
    };
    for (const f of FUNCS) {
      const [sql, args] = calls[f]!;
      for (const role of ["anon", "authenticated"]) {
        await expect(asRole(pool, role, (c) => c.query(sql, args)), `${role} ${f}`).rejects.toThrow(/permission denied/);
      }
      await expect(asRole(pool, "service_role", (c) => c.query(sql, args)), `service_role ${f}`).resolves.toBeDefined();
    }
    // No other role (PUBLIC) holds EXECUTE.
    const acl = await pool.query<{ proname: string; proacl: string[] }>(
      "select proname, proacl::text[] as proacl from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%'",
    );
    expect(acl.rows.length).toBe(FUNCS.length + TRIGGER_FUNCS.length);
    for (const row of acl.rows) {
      const grantees = row.proacl.map((a) => a.split("=")[0]);
      expect(grantees.sort(), row.proname).toEqual(["resolver", "service_role"].sort());
    }
  });

  it("functions are SECURITY INVOKER with an empty search_path", async () => {
    const r = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%'",
    );
    for (const row of r.rows) {
      expect(row.prosecdef, row.proname).toBe(false);
      expect(row.proconfig, row.proname).toContain('search_path=""');
    }
  });
});
