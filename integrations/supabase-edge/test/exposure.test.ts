/**
 * Projection exposure controls (docs/GUARDRAILS.md G4) and its column
 * catalogue (G5), on top of the exact grant lists of rls.test.ts and
 * upgrade.test.ts:
 *   (i)   Supabase's RLS auto-enable event trigger (ensure_rls) is emulated in
 *         a scratch database; the script installs, re-runs and upgrades from
 *         every earlier release cleanly under it, also as a non-superuser owner;
 *   (ii)  exposure invariants hold after every install (helpers/exposure.ts);
 *   (iii) each invariant's detector reports a planted violation (inside a
 *         rolled-back transaction);
 *   G5    the exact (relation, column, type) set of the projection, and no
 *         type or column name that could carry visitor-level data.
 * The projection stays in public in this release (a move to its own schema is
 * a separate, reviewed change).
 */
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECTION_SCHEMA_VERSION } from "../src/core/index.ts";
import { EXPECTED_FUNCTION_GRANTS, EXPECTED_RELATION_GRANTS, columnGrants, functionGrants, relationGrants } from "./helpers/acl.ts";
import { INSTALLATION, TEST_DB_URL, asRole, counts, dropOwner, ensureProjection, freshPublicSchema, installAsOwner, newPool, resetDatabase } from "./helpers/db.ts";
import { exposureViolations, installEnsureRls, projectionColumns, rawIpCapableColumns, type CatalogColumn } from "./helpers/exposure.ts";
import { obs, tomb } from "./helpers/mock-resolver.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
/** Every earlier release kept as a verbatim fixture (see upgrade.test.ts), oldest file name first. */
const LEGACY = readdirSync(FIXTURES)
  .filter((f) => /^0001_idr_projection\.[0-9a-f]{7}\.sql$/.test(f))
  .map((f) => ({ name: f.split(".")[1]!, path: fileURLToPath(new URL(f, FIXTURES)) }));
const D = "2026-11-02T12:00:00.000Z";

/** One page through whatever apply signature the installed release has (four arguments before schema 4). */
async function applyLegacy(pool: pg.Pool, items: unknown[]): Promise<void> {
  const five = (await pool.query<{ p: string | null }>("select to_regprocedure('public.idr_apply_feed_page(text,text,text,jsonb,text)')::text as p")).rows[0]!.p;
  const six = (await pool.query<{ p: string | null }>("select to_regprocedure('public.idr_apply_feed_page(text,text,text,jsonb,text,boolean)')::text as p")).rows[0]!.p;
  const sql = five || six ? "select public.idr_apply_feed_page($1, null, 'c1', $2::jsonb, null)" : "select public.idr_apply_feed_page($1, null, 'c1', $2::jsonb)";
  await asRole(pool, "service_role", (c) => c.query(sql, [INSTALLATION, JSON.stringify(items)]));
}

async function schemaVersion(pool: pg.Pool): Promise<number> {
  return (await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v;
}

async function rlsOff(pool: pg.Pool): Promise<string[]> {
  return (
    await pool.query<{ rel: string }>("select relname as rel from pg_class where relnamespace = 'public'::regnamespace and relname like 'idr\\_%' and relkind = 'r' and not relrowsecurity order by 1")
  ).rows.map((r) => r.rel);
}

async function expectExactAndClean(pool: pg.Pool): Promise<void> {
  expect(await schemaVersion(pool)).toBe(PROJECTION_SCHEMA_VERSION);
  expect(await relationGrants(pool)).toEqual(EXPECTED_RELATION_GRANTS);
  expect(await functionGrants(pool)).toEqual(EXPECTED_FUNCTION_GRANTS);
  expect(await columnGrants(pool)).toEqual([]);
  expect(await rlsOff(pool)).toEqual([]);
  expect(await exposureViolations(pool)).toEqual([]);
  expect(await rawIpCapableColumns(pool)).toEqual([]);
}

describe("G4 (i): installs and upgrades cleanly under Supabase's ensure_rls event trigger (scratch database)", () => {
  const dbName = `idr_edge_ensure_rls_${randomBytes(5).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await installEnsureRls(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it("the emulation is active (control): a table created in public gets row level security at once, in any schema state", async () => {
    await freshPublicSchema(pool);
    await pool.query("create table public.ensure_rls_probe (x int)");
    expect((await pool.query("select relrowsecurity as on from pg_class where oid = 'public.ensure_rls_probe'::regclass")).rows[0]).toEqual({ on: true });
    await pool.query("drop table public.ensure_rls_probe");
    expect((await pool.query("select evtname, evtevent, evtenabled from pg_event_trigger where evtname = 'ensure_rls'")).rows).toEqual([{ evtname: "ensure_rls", evtevent: "ddl_command_end", evtenabled: "O" }]);
  });

  it("a fresh install, then a re-run: schema 8, exact grants, every invariant", async () => {
    await freshPublicSchema(pool);
    await ensureProjection(pool);
    await ensureProjection(pool);
    await expectExactAndClean(pool);
  });

  it.each(LEGACY.map((l) => [l.name, l.path] as const))("an upgrade from the %s release under ensure_rls keeps every row and converges", async (_name, path) => {
    await freshPublicSchema(pool);
    await ensureProjection(pool, path);
    await applyLegacy(pool, [obs(1, 7, D), obs(2, 8, D), tomb(1, 8)]);
    const before = await counts(pool);
    expect(before).toEqual({ companies: 1, observations: 1, tombstones: 1 });
    await ensureProjection(pool);
    await ensureProjection(pool);
    expect(await counts(pool)).toEqual(before);
    await expectExactAndClean(pool);
  });

  it("an install by a non-superuser, non-BYPASSRLS owner (as on hosted Supabase) under ensure_rls", async () => {
    const owner = `idr_g4_owner_${randomBytes(3).toString("hex")}`;
    try {
      await ensureProjection(pool); // auth.jwt() and the API roles exist
      await installAsOwner(pool, owner);
      await expectExactAndClean(pool);
      expect((await pool.query("select distinct relowner::regrole::text as o from pg_class where relnamespace = 'public'::regnamespace and relname like 'idr\\_%'")).rows).toEqual([{ o: owner }]);
    } finally {
      await dropOwner(pool, owner);
    }
  });
});

describe("G4 (ii)/(iii): exposure invariants and their detectors (shared test database)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = newPool();
    await resetDatabase(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("hold after a fresh install under the emulated platform default privileges", async () => {
    await expectExactAndClean(pool);
    // Control: the platform defaults really are in force here (a new table starts with ALL for anon).
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("create table public.idr_default_privilege_probe (x int)");
      const probe = await c.query<{ anon: boolean; auth: boolean }>(
        "select has_table_privilege('anon', 'public.idr_default_privilege_probe', 'INSERT') as anon, has_table_privilege('authenticated', 'public.idr_default_privilege_probe', 'DELETE') as auth",
      );
      expect(probe.rows[0]).toEqual({ anon: true, auth: true });
      // ...and the detector reports exactly that kind of leak on a new idr_* object.
      const v = await exposureViolations(c);
      expect(v).toContain("idr_default_privilege_probe: INSERT for anon (anon/PUBLIC must hold nothing)");
      expect(v).toContain("idr_default_privilege_probe: DELETE for authenticated (authenticated: SELECT on tables and views only)");
      expect(v).toContain("idr_default_privilege_probe: UPDATE for service_role (platform default privilege leaked: service_role reads only)");
      expect(v).toContain("idr_default_privilege_probe: row level security is disabled");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  const PLANTED: Array<[string, string, string]> = [
    ["a SELECT grant to anon", "grant select on public.idr_companies to anon", "idr_companies: SELECT for anon (anon/PUBLIC must hold nothing)"],
    ["a grant to PUBLIC", "grant select on public.idr_sync_state to public", "idr_sync_state: SELECT for PUBLIC (anon/PUBLIC must hold nothing)"],
    ["an INSERT grant to authenticated", "grant insert on public.idr_observations to authenticated", "idr_observations: INSERT for authenticated (authenticated: SELECT on tables and views only)"],
    ["a write grant to service_role (a leaked platform default)", "grant update on public.idr_sync_gaps to service_role", "idr_sync_gaps: UPDATE for service_role (platform default privilege leaked: service_role reads only)"],
    ["a sequence grant", "grant usage on sequence public.idr_sync_gaps_id_seq to service_role", "idr_sync_gaps_id_seq: USAGE for service_role (platform default privilege leaked: service_role reads only)"],
    ["a column-level grant to anon", "grant select (domain) on public.idr_companies to anon", "idr_companies.domain: column-level grant"],
    ["an API role made a member of service_role", "grant service_role to anon", "idr_companies: effective SELECT for anon"],
    ["RLS disabled on a table", "alter table public.idr_tombstones disable row level security", "idr_tombstones: row level security is disabled"],
    ["a policy for PUBLIC", "create policy idr_planted on public.idr_observations for select to public using (true)", "idr_observations: policy idr_planted applies to PUBLIC"],
    ["a write policy for authenticated", "create policy idr_planted on public.idr_observations for all to authenticated using (true)", "idr_observations: policy idr_planted lets authenticated do more than SELECT (*)"],
    [
      "authenticated reading without a claim policy",
      "drop policy idr_companies_authenticated_read on public.idr_companies; create policy idr_planted on public.idr_companies for select to authenticated using (true)",
      "idr_companies: authenticated can SELECT without a non-trivial RLS policy",
    ],
    ["a view that bypasses RLS", "alter view public.idr_daily_company_activity set (security_invoker = false)", "idr_daily_company_activity: view readable by authenticated is not security_invoker"],
    ["EXECUTE for authenticated", "grant execute on function public.idr_get_sync_state(text) to authenticated", "idr_get_sync_state(text): EXECUTE for authenticated"],
    ["EXECUTE for PUBLIC", "grant execute on function public.idr_schema_version() to public", "idr_schema_version(): EXECUTE for PUBLIC"],
    [
      "a new SECURITY DEFINER function without search_path (and the default PUBLIC EXECUTE)",
      "create function public.idr_planted() returns int language sql security definer as $$ select 1 $$",
      "idr_planted(): SECURITY DEFINER without a pinned search_path",
    ],
    [
      "a SECURITY DEFINER function whose search_path is reset",
      "alter function public.idr_apply_feed_page(text, text, text, jsonb, text, boolean) reset search_path",
      "idr_apply_feed_page(text,text,text,jsonb,text,boolean): SECURITY DEFINER without a pinned search_path",
    ],
    [
      "a search_path with pg_temp not last",
      "alter function public.idr_reset_cursor(text, text) set search_path = pg_temp, pg_catalog",
      "idr_reset_cursor(text,text): SECURITY DEFINER search_path does not list pg_temp last",
    ],
  ];

  it.each(PLANTED)("detects %s", async (_name, ddl, violation) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(ddl);
      expect(await exposureViolations(c)).toContain(violation);
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect(await exposureViolations(pool)).toEqual([]);
  });

  it("a new idr_* function also reports the default PUBLIC EXECUTE", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("create function public.idr_planted() returns int language sql set search_path = pg_catalog, pg_temp as $$ select 1 $$");
      const v = await exposureViolations(c);
      expect(v).toContain("idr_planted(): EXECUTE for PUBLIC");
      expect(v).toContain("idr_planted(): effective EXECUTE for anon");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("G5: the projection's column catalogue", () => {
  const T = "text";
  const TS = "timestamp with time zone";
  /** The exact (relation, column, type) set. Changing it is a schema change: review it against G5, then update. */
  const SNAPSHOT: CatalogColumn[] = [
    ["idr_companies", "company_id", "bigint"],
    ["idr_companies", "domain", T],
    ["idr_companies", "installation_id", T],
    ["idr_companies", "organisation_name", T],
    ["idr_companies", "updated_at", TS],
    ["idr_daily_company_activity", "company_id", "bigint"],
    ["idr_daily_company_activity", "day", "date"],
    ["idr_daily_company_activity", "domain", T],
    ["idr_daily_company_activity", "entrances", "bigint"],
    ["idr_daily_company_activity", "first_observed_at", TS],
    ["idr_daily_company_activity", "installation_id", T],
    ["idr_daily_company_activity", "last_observed_at", TS],
    ["idr_daily_company_activity", "organisation_name", T],
    ["idr_observations", "acquisition", T],
    ["idr_observations", "company_id", "bigint"],
    ["idr_observations", "entrance_contract", T],
    ["idr_observations", "installation_id", T],
    ["idr_observations", "method", T],
    ["idr_observations", "observation_id", "bigint"],
    ["idr_observations", "observed_at", TS],
    ["idr_observations", "page_key", T],
    ["idr_observations", "received_at", TS],
    ["idr_sync_gaps", "detected_at", TS],
    ["idr_sync_gaps", "detected_generation", "bigint"],
    ["idr_sync_gaps", "expired_cursor", T],
    ["idr_sync_gaps", "id", "bigint"],
    ["idr_sync_gaps", "installation_id", T],
    ["idr_sync_gaps", "kind", T],
    ["idr_sync_gaps", "last_applied_at", TS],
    ["idr_sync_gaps", "last_observed_at", TS],
    ["idr_sync_gaps", "resolution", T],
    ["idr_sync_gaps", "resolved_at", TS],
    ["idr_sync_state", "cursor", T],
    ["idr_sync_state", "drained_generation", "bigint"],
    ["idr_sync_state", "installation_id", T],
    ["idr_sync_state", "last_applied_at", TS],
    ["idr_sync_state", "last_run_at", TS],
    ["idr_sync_state", "needs_resync", "boolean"],
    ["idr_sync_state", "replay_generation", "bigint"],
    ["idr_sync_state", "reset_from_cursor", T],
    ["idr_sync_state", "reset_from_generation", "bigint"],
    ["idr_sync_state", "resync_generation", "bigint"],
    ["idr_sync_state", "resync_requested_at", TS],
    ["idr_sync_state", "status", T],
    ["idr_sync_state", "updated_at", TS],
    ["idr_tombstones", "company_id", "bigint"],
    ["idr_tombstones", "erased_at", TS],
    ["idr_tombstones", "installation_id", T],
    ["idr_tombstones", "received_at", TS],
    ["idr_tombstones", "tombstone_id", "bigint"],
  ].map(([rel, col, type]) => ({ rel: rel!, col: col!, type: type! }));

  let pool: pg.Pool;
  beforeAll(async () => {
    pool = newPool();
  });
  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  it("a fresh install has exactly the snapshot, and no banned type or column name", async () => {
    await resetDatabase(pool);
    expect(await projectionColumns(pool)).toEqual(SNAPSHOT);
    expect(await rawIpCapableColumns(pool)).toEqual([]);
  });

  it.each(LEGACY.map((l) => [l.name, l.path] as const))("an upgrade from the %s release converges to exactly the snapshot", async (_name, path) => {
    await freshPublicSchema(pool);
    await ensureProjection(pool, path);
    await ensureProjection(pool);
    expect(await projectionColumns(pool)).toEqual(SNAPSHOT);
    expect(await rawIpCapableColumns(pool)).toEqual([]);
  });

  it.each([
    ["an inet column", "alter table public.idr_observations add column origin inet", "idr_observations.origin: banned type inet"],
    ["a cidr array", "alter table public.idr_companies add column ranges cidr[]", "idr_companies.ranges: banned type cidr"],
    ["a bytea column", "alter table public.idr_observations add column digest bytea", "idr_observations.digest: banned type bytea"],
    ["an inet behind a domain", "create domain public.idr_planted_addr as inet; alter table public.idr_tombstones add column src public.idr_planted_addr", "idr_tombstones.src: banned type inet"],
    ["a macaddr8 in a new table", "create table public.idr_planted (m macaddr8)", "idr_planted.m: banned type macaddr8"],
    ["an IP-named text column", "alter table public.idr_observations add column client_ip text", "idr_observations.client_ip: banned column name"],
    ["a visitor id", "alter table public.idr_observations add column visitor_id text", "idr_observations.visitor_id: banned column name"],
    ["a session id", "alter table public.idr_observations add column session_id text", "idr_observations.session_id: banned column name"],
    ["a user agent", "alter table public.idr_observations add column user_agent text", "idr_observations.user_agent: banned column name"],
    ["a referrer", "alter table public.idr_observations add column referrer text", "idr_observations.referrer: banned column name"],
    ["an e-mail", "alter table public.idr_companies add column contact_email text", "idr_companies.contact_email: banned column name"],
    ["an HMAC", "alter table public.idr_observations add column hmac text", "idr_observations.hmac: banned column name"],
    ["a fingerprint", "alter table public.idr_observations add column fingerprint text", "idr_observations.fingerprint: banned column name"],
    ["an observation reference", "alter table public.idr_observations add column observation_ref text", "idr_observations.observation_ref: banned column name"],
    ["an entrance id", "alter table public.idr_observations add column entrance_id text", "idr_observations.entrance_id: banned column name"],
    ["an address", "alter table public.idr_companies add column postal_address text", "idr_companies.postal_address: banned column name"],
  ])("detects %s (and the snapshot changes)", async (_name, ddl, violation) => {
    await resetDatabase(pool);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(ddl);
      expect(await rawIpCapableColumns(c)).toContain(violation);
      expect(await projectionColumns(c)).not.toEqual(SNAPSHOT);
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect(await rawIpCapableColumns(pool)).toEqual([]);
  });
});
