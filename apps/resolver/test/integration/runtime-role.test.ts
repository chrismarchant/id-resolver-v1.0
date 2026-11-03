/**
 * Separate runtime and migration roles (Gate 5).
 *
 * The owner (DATABASE_URL) migrates and owns every object; the service logs in
 * as a least-privilege runtime role provisioned by the migrate step
 * (src/db/runtime-role.ts). This suite proves, against a real PostgreSQL:
 *
 *  1. provisioning: exact attributes and grants, a SCRAM verifier instead of
 *     the plaintext, idempotency, password rotation, coverage of every
 *     object, and refusal to take over a role it did not create;
 *  2. every runtime path works as that role: entrances (cache, provider
 *     usage, observations), the reporting feed and watermark, browser events,
 *     maintenance (cache, retention through the 0006/0007 triggers, events),
 *     the kill switch read, usage, readiness and the startup checks;
 *  3. operator paths that need the owner (erasure, the kill switch write) are
 *     refused to the runtime role and work for the owner;
 *  4. the runtime role cannot bypass the feed guards: no TRUNCATE, no trigger
 *     disabling, no session_replication_role, no DDL, no SET ROLE, no write to
 *     the watermark or the tombstones;
 *  5. upgrade from 0001-0008, re-runs, and rollback to the previous build.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { usagePeriodKey } from "../../src/contracts/db.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { createDb, type Db } from "../../src/db/index.js";
import { applyMigrations, assertSchemaCurrent, migrationStatus } from "../../src/db/migrate.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import { createFeedRetention } from "../../src/db/retention.js";
import {
  checkConnectedRolePrivileges,
  provisionRuntimeRole,
  RUNTIME_GRANTS,
  RUNTIME_SEQUENCE_GRANTS,
  RuntimeRoleError,
  scramSha256Verifier,
} from "../../src/db/runtime-role.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { startMockEnrichServer, type MockServerHandle } from "../../src/provider/mock-server.js";
import { createProvider } from "../../src/provider/index.js";
import { createMaintenance } from "../../src/runtime/maintenance.js";
import { buildPipelineConfig, createRunner } from "../../src/runtime/runner.js";
import { createScratchDatabase, createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";
import { createCompany, FEED_REPORTING_TOKEN, FEED_SCOPE, getFeed, insertObservation, reportingAuth } from "../helpers/feed.js";
import { createRuntimeDb, provisionTestRuntimeRole, TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "../helpers/runtime-role.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const INSUFFICIENT_PRIVILEGE = "42501";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { code?: unknown }).code ?? (e as Error).message);
  }
  return "ok";
}

/** A single client logged in as the runtime role (for statements that need one session). */
async function runtimeClient(databaseUrl = getTestDatabaseUrl()): Promise<pg.Client> {
  const u = new URL(databaseUrl);
  u.username = TEST_RUNTIME_ROLE;
  u.password = TEST_RUNTIME_PASSWORD;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

/** Table and column privileges of `role` in `pool`'s database, as "table:PRIV" and "table.column:UPDATE". */
async function privilegesOf(pool: Pool, role: string): Promise<{ tables: string[]; columns: string[]; sequences: string[] }> {
  const tables = await pool.query<{ p: string }>(
    `SELECT table_name || ':' || privilege_type AS p FROM information_schema.role_table_grants
     WHERE grantee = $1 AND table_schema = 'public' ORDER BY 1`,
    [role],
  );
  const columns = await pool.query<{ p: string }>(
    `SELECT c.relname || '.' || a.attname || ':' || 'UPDATE' AS p
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AND NOT has_table_privilege($1, c.oid, 'UPDATE')
     ORDER BY 1`,
    [role],
  );
  const sequences = await pool.query<{ p: string }>(
    `SELECT c.relname || ':' || priv AS p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS priv
     WHERE n.nspname = 'public' AND c.relkind = 'S' AND has_sequence_privilege($1, c.oid, priv) ORDER BY 1`,
    [role],
  );
  return { tables: tables.rows.map((r) => r.p), columns: columns.rows.map((r) => r.p), sequences: sequences.rows.map((r) => r.p) };
}

function expectedPrivileges(): { tables: string[]; columns: string[]; sequences: string[] } {
  const tables: string[] = [];
  const columns: string[] = [];
  for (const [t, g] of Object.entries(RUNTIME_GRANTS)) {
    if (g.select) tables.push(`${t}:SELECT`);
    if (g.insert) tables.push(`${t}:INSERT`);
    if (g.update === true) tables.push(`${t}:UPDATE`);
    if (g.delete) tables.push(`${t}:DELETE`);
    if (Array.isArray(g.update)) for (const c of g.update) columns.push(`${t}.${c}:UPDATE`);
  }
  const sequences = Object.entries(RUNTIME_SEQUENCE_GRANTS)
    .filter(([, usage]) => usage)
    .map(([s]) => `${s}:USAGE`);
  return { tables: tables.sort(), columns: columns.sort(), sequences: sequences.sort() };
}

describe("provisioning the runtime role (migrate step, as the owner)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let owner: Pool;
  beforeAll(async () => {
    scratch = await createScratchDatabase();
    owner = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 2 });
  });
  afterAll(async () => {
    await owner.end();
    await scratch.drop();
  });

  it("creates a LOGIN role with no elevated attribute, stores a SCRAM verifier (never the plaintext) and grants exactly RUNTIME_GRANTS", async () => {
    const r = await provisionTestRuntimeRole(scratch.url);
    expect(r.applied).toContain("0009_runtime_role_support.sql");
    expect(r.runtimeRole).toMatchObject({ role: TEST_RUNTIME_ROLE });
    const attrs = await owner.query(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolpassword
       FROM pg_authid WHERE rolname = $1`,
      [TEST_RUNTIME_ROLE],
    );
    const a = attrs.rows[0];
    expect(a).toMatchObject({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false });
    expect(a.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a.rolpassword).not.toContain(TEST_RUNTIME_PASSWORD);
    expect(await privilegesOf(owner, TEST_RUNTIME_ROLE)).toEqual(expectedPrivileges());
    const memberships = await owner.query("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1", [TEST_RUNTIME_ROLE]);
    expect(memberships.rows[0].n).toBe(0);
  });

  it("every table and sequence the migrations create has an explicit entry (a new migration's object must be decided, never granted blindly)", async () => {
    const objs = await owner.query<{ name: string; kind: string }>(
      "SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY 1",
    );
    const tables = objs.rows.filter((o) => o.kind !== "S").map((o) => o.name).sort();
    const sequences = objs.rows.filter((o) => o.kind === "S").map((o) => o.name).sort();
    expect(tables).toEqual(Object.keys(RUNTIME_GRANTS).sort());
    expect(sequences).toEqual(Object.keys(RUNTIME_SEQUENCE_GRANTS).sort());
  });

  it("is idempotent: a re-run applies no migration, keeps the exact grants and removes any extra grant made by hand", async () => {
    await owner.query(`GRANT TRUNCATE, TRIGGER ON companies TO ${TEST_RUNTIME_ROLE}`);
    await owner.query(`GRANT INSERT ON feed_tombstones TO ${TEST_RUNTIME_ROLE}`);
    const again = await provisionTestRuntimeRole(scratch.url);
    expect(again.applied).toEqual([]);
    expect(again.runtimeRole).toMatchObject({ created: false });
    expect(await privilegesOf(owner, TEST_RUNTIME_ROLE)).toEqual(expectedPrivileges());
    const rt = await runtimeClient(scratch.url);
    try {
      expect((await rt.query("SELECT current_user::text AS u")).rows[0].u).toBe(TEST_RUNTIME_ROLE);
    } finally {
      await rt.end();
    }
  });

  it("rotates the password: after a run with a new value the old one is refused (28P01) and the new one works", async () => {
    const next = randomBytes(24).toString("hex");
    await applyMigrations(owner, undefined, { runtimeRole: { role: TEST_RUNTIME_ROLE, password: next } });
    const u = new URL(scratch.url);
    u.username = TEST_RUNTIME_ROLE;
    u.password = TEST_RUNTIME_PASSWORD;
    expect(await codeOf((async () => { const c = new pg.Client({ connectionString: u.toString() }); try { await c.connect(); } finally { await c.end().catch(() => undefined); } })())).toBe("28P01");
    const p = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 1, credentials: { user: TEST_RUNTIME_ROLE, password: next } });
    try {
      expect((await p.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    } finally {
      await p.end();
    }
    await provisionTestRuntimeRole(scratch.url); // back to the shared test password
  });

  it("refuses to take over an existing role with any elevated attribute or membership, changing nothing", async () => {
    const name = `idr_test_priv_${randomBytes(3).toString("hex")}`;
    await owner.query(`CREATE ROLE ${name} LOGIN CREATEDB`);
    try {
      const err = await applyMigrations(owner, undefined, { runtimeRole: { role: name, password: TEST_RUNTIME_PASSWORD } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeRoleError);
      expect((err as RuntimeRoleError).code).toBe("RUNTIME_ROLE_PRIVILEGED");
      expect((err as RuntimeRoleError).reasons).toEqual(["createdb"]);
      expect((await owner.query("SELECT rolcreatedb FROM pg_roles WHERE rolname = $1", [name])).rows[0].rolcreatedb).toBe(true);
      expect((await privilegesOf(owner, name)).tables).toEqual([]);

      await owner.query(`ALTER ROLE ${name} NOCREATEDB`);
      await owner.query(`GRANT ${TEST_RUNTIME_ROLE} TO ${name}`);
      const err2 = await applyMigrations(owner, undefined, { runtimeRole: { role: name, password: TEST_RUNTIME_PASSWORD } }).catch((e: unknown) => e);
      expect((err2 as RuntimeRoleError).reasons).toEqual(["role_membership"]);
    } finally {
      await owner.query(`DROP OWNED BY ${name}`);
      await owner.query(`DROP ROLE ${name}`);
    }
  });

  it("an object without a grant decision gets no privilege (deny by default) and is reported by name, even after a manual grant", async () => {
    await owner.query("CREATE TABLE unmapped_probe (id int)");
    await owner.query(`GRANT ALL ON unmapped_probe TO ${TEST_RUNTIME_ROLE}`);
    try {
      const r = await provisionTestRuntimeRole(scratch.url);
      expect(r.runtimeRole?.unmapped).toEqual(["unmapped_probe"]);
      expect((await privilegesOf(owner, TEST_RUNTIME_ROLE)).tables.filter((p) => p.startsWith("unmapped_probe"))).toEqual([]);
    } finally {
      await owner.query("DROP TABLE unmapped_probe");
    }
    expect((await provisionTestRuntimeRole(scratch.url)).runtimeRole?.unmapped).toEqual([]);
  });

  it("refuses the owner itself and invalid names or passwords", async () => {
    const self = (await owner.query<{ u: string }>("SELECT current_user::text AS u")).rows[0]!.u;
    const err = await applyMigrations(owner, undefined, { runtimeRole: { role: self, password: TEST_RUNTIME_PASSWORD } }).catch((e: unknown) => e);
    expect((err as RuntimeRoleError).code).toBe("RUNTIME_ROLE_INVALID");
    for (const role of ["pg_monitor", "Bad-Name", "1abc"]) {
      const e = await applyMigrations(owner, undefined, { runtimeRole: { role, password: TEST_RUNTIME_PASSWORD } }).catch((x: unknown) => x);
      expect((e as RuntimeRoleError).code, role).toBe("RUNTIME_ROLE_INVALID");
    }
    expect(() => scramSha256Verifier("short")).toThrow(RuntimeRoleError);
    expect(() => scramSha256Verifier(`${"a".repeat(40)}%`)).toThrow(RuntimeRoleError);
  });

  it("the migrate CLI provisions the role from DATABASE_RUNTIME_PASSWORD, never printing it, and says when it is not configured", () => {
    const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test", DATABASE_URL: scratch.url, DATABASE_SSL: "disable", ...env },
      });
    const ok = run({ DATABASE_RUNTIME_ROLE: TEST_RUNTIME_ROLE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ migrated: [], runtime_role: "updated" });
    const none = run({});
    expect(none.status, none.stderr).toBe(0);
    expect(JSON.parse(none.stdout)).toMatchObject({ runtime_role: "not_configured" });
    expect(none.stderr).toContain("runtime role not configured (DATABASE_RUNTIME_PASSWORD unset)");
    const bad = run({ DATABASE_RUNTIME_PASSWORD: "short-secret-value" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("DATABASE_RUNTIME_PASSWORD");
    const owner = new URL(scratch.url).username;
    const same = run({ DATABASE_RUNTIME_ROLE: owner, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD });
    expect(same.status).toBe(1);
    expect(same.stderr).toContain("DATABASE_RUNTIME_ROLE must differ from the DATABASE_URL user");
    for (const r of [ok, none, bad, same]) {
      const out = r.stdout + r.stderr;
      for (const needle of [TEST_RUNTIME_PASSWORD, "short-secret-value", scratch.url, "resolver:resolver"]) expect(out.includes(needle), "migrate output leaked a value").toBe(false);
    }
  });

  it("the SCRAM verifier has PostgreSQL's stored format and a fresh salt each time", () => {
    const v1 = scramSha256Verifier(TEST_RUNTIME_PASSWORD);
    const v2 = scramSha256Verifier(TEST_RUNTIME_PASSWORD);
    expect(v1).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(v1).not.toBe(v2);
    const salt = Buffer.alloc(16, 7);
    expect(scramSha256Verifier(TEST_RUNTIME_PASSWORD, salt)).toBe(scramSha256Verifier(TEST_RUNTIME_PASSWORD, salt));
  });

  it("G5R2-L3: session defaults the runtime role set on itself are reported by the startup check and removed by provisioning", async () => {
    const dbName = new URL(scratch.url).pathname.slice(1);
    const rt = await runtimeClient(scratch.url);
    try {
      // What a leaked runtime credential can do: persistent defaults for every later session of the role.
      await rt.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} SET default_transaction_read_only = on`);
      await rt.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} SET synchronous_commit = off`);
      await rt.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} IN DATABASE ${dbName} SET lock_timeout = '1ms'`);
    } finally {
      await rt.end();
    }
    try {
      const tampered = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
      try {
        expect((await tampered.pool.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("on");
        expect(await checkConnectedRolePrivileges(tampered.pool)).toEqual(["role_settings"]);
      } finally {
        await tampered.close();
      }
      // The next migrate run removes every setting of the role (global and for this database).
      await provisionTestRuntimeRole(scratch.url);
      const settings = await owner.query(
        "SELECT count(*)::int AS n FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = $1",
        [TEST_RUNTIME_ROLE],
      );
      expect(settings.rows[0].n).toBe(0);
      const clean = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
      try {
        expect((await clean.pool.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("off");
        expect(await checkConnectedRolePrivileges(clean.pool)).toEqual([]);
        expect(await clean.events.record({ installationId: "inst-l3", websiteId: "site-l3", eventId: randomBytes(12).toString("base64url"), type: "page", name: "view", pageKey: "/l3", consent: "granted", occurredAt: new Date() })).toBe(true);
      } finally {
        await clean.close();
      }
    } finally {
      // Never leave a cluster-wide setting behind for the other suites.
      await owner.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} RESET ALL`);
    }
  });

  it("G5R2-L3: a role setting for another database is not this database's concern (not reported)", async () => {
    await owner.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} IN DATABASE postgres SET work_mem = '64kB'`);
    try {
      const rt = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
      try {
        expect(await checkConnectedRolePrivileges(rt.pool)).toEqual([]);
      } finally {
        await rt.close();
      }
    } finally {
      await owner.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} IN DATABASE postgres RESET ALL`);
    }
  });

  it("the startup self-check reports nothing for the runtime role and every excess privilege for the owner", async () => {
    const rt = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
    try {
      expect(await checkConnectedRolePrivileges(rt.pool)).toEqual([]);
    } finally {
      await rt.close();
    }
    const excess = await checkConnectedRolePrivileges(owner);
    expect(excess).toEqual(expect.arrayContaining(["owns_objects", "truncate_or_trigger"]));
  });
});

describe("every runtime path works as the runtime role", () => {
  let owner: Db;
  let runtime: Db;
  let mock: MockServerHandle;
  let app: FastifyInstance;
  let runner: ReturnType<typeof createRunner>;
  const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };
  const usageScope = { installationId: "inst-test", websiteId: "site-test", periodKey: usagePeriodKey("month", new Date()) };
  const entrance = (ip: string) => ({
    contract: "entrance.v1",
    website_id: "site-test",
    ip,
    entrance_id: randomBytes(12).toString("base64url"),
    occurred_at: new Date().toISOString(),
    page_key: "/pricing",
    acquisition: "search",
    eligibility: "tsa-1",
  });

  beforeAll(async () => {
    owner = await createTestDb();
    await provisionTestRuntimeRole();
    runtime = createRuntimeDb({ max: 12 });
    mock = await startMockEnrichServer({ slowMs: 5_000 });
    const config = testConfig({
      PROVIDER_MODE: "live",
      ENRICH_API_BASE_URL: mock.url,
      ENRICH_API_KEY: "sk_test_placeholder_key",
      PERIOD_CALL_CAP: "50",
      REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN,
      EVENTS_ENABLED: "true",
      RATE_LIMIT_PER_MINUTE: "100000",
    });
    const pipeline = buildPipelineConfig(config);
    runner = createRunner({
      config: pipeline,
      deps: { cache: runtime.cache, usage: runtime.usage, controls: runtime.controls, companies: runtime.companies, activity: runtime.activity, provider: createProvider(pipeline.provider) },
      logger: createMemoryLogger(),
      capacity: config.MAX_CONCURRENT_JOBS,
    });
    app = await buildServer({ config, logger: createMemoryLogger(), runner, ping: () => runtime.ping(), reporting: runtime.reporting, events: runtime.events });
    await app.ready();
  });
  beforeEach(async () => {
    await resetTestDb(owner);
  });
  afterAll(async () => {
    await app.close();
    await runner.shutdown(2_000);
    await mock.close();
    await runtime.close();
    await owner.close();
  });

  it("logs in as the runtime role, passes the startup checks (least privilege, schema current) and readiness", async () => {
    expect((await runtime.pool.query<{ u: string }>("SELECT current_user::text AS u")).rows[0]!.u).toBe(TEST_RUNTIME_ROLE);
    expect(await checkConnectedRolePrivileges(runtime.pool)).toEqual([]);
    const status = await assertSchemaCurrent(runtime.pool);
    expect(status.pending).toEqual([]);
    expect(await runtime.ping()).toBe(true);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("entrances: provider resolution, cache hit, usage reservation and counters, observations (the full pipeline)", async () => {
    const first = await app.inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: entrance("203.0.113.10") });
    expect(first.json()).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
    const second = await app.inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: entrance("203.0.113.10") });
    expect(second.json()).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
    const noMatch = await app.inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: entrance("203.0.113.13") });
    expect(noMatch.statusCode).toBe(200);
    const snap = await runtime.usage.snapshot(usageScope);
    expect(snap.provider_attempts).toBe(2);
    expect(snap.cache_hits).toBe(1);
    expect(snap.qualified_matches).toBe(1);
    expect((await owner.pool.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(2);
    expect((await owner.pool.query("SELECT observation_count::int AS n FROM company_scope_stats")).rows[0].n).toBe(2);
  });

  it("the kill switch: the runtime role reads it and the reservation honours it; only the owner can set it", async () => {
    expect(await runtime.controls.isEnrichmentEnabled("inst-test")).toBe(true);
    expect(await codeOf(runtime.controls.setEnrichmentEnabled("inst-test", false, "runtime must not"))).toBe(INSUFFICIENT_PRIVILEGE);
    await owner.controls.setEnrichmentEnabled("inst-test", false, "owner engages");
    expect(await runtime.controls.isEnrichmentEnabled("inst-test")).toBe(false);
    expect(await runtime.usage.reserveProviderAttempt(usageScope, 50)).toBe("disabled");
    const r = await app.inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: entrance("203.0.113.12") });
    expect(r.json()).toMatchObject({ status: "disabled" });
    await owner.controls.setEnrichmentEnabled("inst-test", true, "owner releases");
    expect(await runtime.usage.reserveProviderAttempt(usageScope, 50)).toBe("reserved");
  });

  it("the reporting feed reads observations, tombstones and the watermark", async () => {
    const companyId = await createCompany(owner.pool, "feed-runtime.example");
    await insertObservation(owner.pool, { companyId });
    const feed = await getFeed(app);
    expect(feed.status).toBe(200);
    expect(feed.body.items).toHaveLength(1);
    const companies = await app.inject({ method: "GET", url: "/v1/reporting/companies", headers: reportingAuth });
    expect(companies.statusCode).toBe(200);
  });

  it("retention and maintenance delete through the 0006/0007 triggers and still advance the watermark (trigger runs as its owner)", async () => {
    const companyId = await createCompany(owner.pool, "retention-runtime.example");
    const old = new Date(Date.now() - 40 * 86_400_000);
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await insertObservation(owner.pool, { companyId, observedAt: old }));
    await owner.pool.query(
      `INSERT INTO ip_resolution_cache (installation_id, website_id, key_version, ip_fingerprint, status, checked_at, expires_at)
       SELECT 'inst-test', 'site-test', 1, sha256(convert_to('rt-maint-' || g, 'UTF8')), 'no_match', now() - interval '2 days', now() - interval '1 hour'
       FROM generate_series(1, 7) g`,
    );
    await runtime.events.record({ installationId: "inst-test", websiteId: "site-test", eventId: randomBytes(12).toString("base64url"), type: "page", name: "view", pageKey: "/x", consent: "granted", occurredAt: new Date() });
    await owner.pool.query("UPDATE browser_events SET received_at = now() - interval '40 days'");
    const maintenance = createMaintenance({
      pruneExpiredCache: (limit) => runtime.cache.pruneExpired(limit),
      retention: createFeedRetention(runtime.pool),
      pruneEventsBefore: (cutoff, limit) => runtime.events.pruneBefore(cutoff, limit),
      logger: createMemoryLogger(),
      batch: 2,
      retentionDays: 30,
      budgetMs: 20_000,
    });
    const run = await maintenance.runOnce();
    await maintenance.stop();
    expect(run).toMatchObject({ cacheRows: 7, observationRows: 5, eventRows: 1, backlog: false });
    const wm = await owner.pool.query("SELECT pruned_through_id::text AS id, pruned_through_txid::text AS txid FROM feed_retention_watermarks");
    const last = rows[rows.length - 1]!;
    expect(wm.rows).toEqual([{ id: last.id, txid: last.txid }]);
    // The inherited prune path works too.
    await insertObservation(owner.pool, { companyId, observedAt: old });
    expect(await runtime.activity.pruneObservationsBefore(new Date(Date.now() - 30 * 86_400_000), 10)).toBe(1);
    expect(BigInt((await owner.pool.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows[0].id)).toBeGreaterThan(BigInt(last.id));
  });

  it("browser events are recorded and repeat-safe", async () => {
    const e = { installationId: "inst-test", websiteId: "site-test", eventId: randomBytes(12).toString("base64url"), type: "page", name: "view", pageKey: "/x", consent: "granted" as const, occurredAt: new Date() };
    expect(await runtime.events.record(e)).toBe(true);
    expect(await runtime.events.record(e)).toBe(false);
  });

  it("erasure (ops:erase-company) needs the owner: refused to the runtime role and rolled back, works for the owner", async () => {
    const companyId = await createCompany(owner.pool, "erase-runtime.example");
    await insertObservation(owner.pool, { companyId });
    expect(await codeOf(eraseCompany(runtime.pool, { companyId }))).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await owner.pool.query("SELECT count(*)::int AS n FROM companies WHERE id = $1", [companyId])).rows[0].n).toBe(1);
    expect((await owner.pool.query("SELECT count(*)::int AS n FROM feed_tombstones")).rows[0].n).toBe(0);
    const r = await eraseCompany(owner.pool, { companyId });
    expect(r).toMatchObject({ erased: true, tombstones: 1, observations: 1 });
    // The feed (read by the runtime role) serves the tombstone.
    expect((await getFeed(app)).body.items).toEqual([expect.objectContaining({ type: "company_erased", company_id: companyId })]);
  });
});

describe("the runtime role cannot bypass the feed guards or change the schema", () => {
  let owner: Db;
  let rt: pg.Client;
  let companyId: number;
  beforeAll(async () => {
    owner = await createTestDb();
    await provisionTestRuntimeRole();
    await resetTestDb(owner);
    companyId = await createCompany(owner.pool, "guards-runtime.example");
    await insertObservation(owner.pool, { companyId });
    // A watermark and a tombstone to attack.
    const old = await insertObservation(owner.pool, { companyId, observedAt: new Date(Date.now() - 40 * 86_400_000) });
    await owner.pool.query("DELETE FROM company_observations WHERE id = $1", [old.id]);
    await owner.pool.query("INSERT INTO feed_tombstones (installation_id, website_id, company_id) VALUES ('inst-test', 'site-test', 999)");
    rt = await runtimeClient();
  });
  afterAll(async () => {
    await rt.end();
    await resetTestDb(owner);
    await owner.close();
  });

  const denied = async (sql: string) => {
    const code = await codeOf(rt.query(sql));
    // Leave the session usable after a failed statement inside or outside a transaction.
    await rt.query("ROLLBACK").catch(() => undefined);
    return code;
  };

  it.each(Object.keys(RUNTIME_GRANTS))("TRUNCATE %s is refused", async (table) => {
    expect(await denied(`TRUNCATE ${table}`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("cannot disable triggers or switch to replica mode (the two guard bypasses)", async () => {
    for (const sql of [
      "ALTER TABLE company_observations DISABLE TRIGGER ALL",
      "ALTER TABLE company_observations DISABLE TRIGGER company_observations_feed_watermark",
      "ALTER TABLE feed_tombstones ENABLE REPLICA TRIGGER feed_tombstones_append_only",
      "ALTER TABLE feed_retention_watermarks DISABLE TRIGGER USER",
      "SET session_replication_role = replica",
      "SET LOCAL session_replication_role = replica",
    ]) {
      expect(await denied(sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await denied("BEGIN; SET LOCAL session_replication_role = replica; COMMIT")).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await rt.query("SHOW session_replication_role")).rows[0].session_replication_role).toBe("origin");
  });

  it("cannot ALTER, DROP or CREATE anything, take the owner's role or raise its own", async () => {
    const owner_ = (await owner.pool.query<{ u: string }>("SELECT current_user::text AS u")).rows[0]!.u;
    for (const sql of [
      "ALTER TABLE company_observations ADD COLUMN x int",
      "ALTER TABLE feed_tombstones DROP CONSTRAINT feed_tombstones_pkey",
      "DROP TABLE browser_events",
      "DROP TRIGGER company_observations_no_truncate ON company_observations",
      "DROP FUNCTION feed_reject_mutation()",
      "CREATE TABLE shadow (a int)",
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE SCHEMA sneaky",
      "CREATE OR REPLACE FUNCTION feed_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
      `ALTER ROLE ${TEST_RUNTIME_ROLE} SUPERUSER`,
      `ALTER ROLE ${TEST_RUNTIME_ROLE} BYPASSRLS`,
      "COPY companies FROM PROGRAM 'true'",
    ]) {
      expect(await denied(sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // GRANT without the grant option is only a warning in PostgreSQL ("no privileges were granted"): nothing changes.
    await rt.query(`GRANT TRUNCATE, TRIGGER ON companies TO ${TEST_RUNTIME_ROLE}`);
    expect((await rt.query("SELECT has_table_privilege('companies', 'TRUNCATE') AS t, has_table_privilege('companies', 'TRIGGER') AS g")).rows[0]).toEqual({ t: false, g: false });
    // Not a member of the owner: SET ROLE is refused too.
    expect(await denied(`SET ROLE ${owner_}`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("cannot move the watermark backwards or forwards, delete it, or forge, change or delete a tombstone", async () => {
    for (const sql of [
      "UPDATE feed_retention_watermarks SET pruned_through_id = 0",
      "UPDATE feed_retention_watermarks SET pruned_through_id = pruned_through_id + 1000",
      "DELETE FROM feed_retention_watermarks",
      "INSERT INTO feed_retention_watermarks (installation_id, website_id, pruned_through_txid, pruned_through_id, updated_at) VALUES ('x', 'y', '1', 1, now())",
      "DELETE FROM feed_tombstones",
      "UPDATE feed_tombstones SET company_id = 1",
      "INSERT INTO feed_tombstones (installation_id, website_id, company_id) VALUES ('inst-test', 'site-test', 1)",
    ]) {
      expect(await denied(sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect((await owner.pool.query("SELECT count(*)::int AS n FROM feed_tombstones")).rows[0].n).toBe(1);
    expect((await owner.pool.query("SELECT count(*)::int AS n FROM feed_retention_watermarks")).rows[0].n).toBe(1);
  });

  it("cannot rewrite a served observation or delete company history outside retention", async () => {
    for (const sql of [
      `UPDATE company_observations SET company_id = ${companyId}`,
      "UPDATE company_observations SET observed_at = now()",
      "DELETE FROM companies",
      "DELETE FROM company_scope_stats",
      "DELETE FROM company_observation_refs",
      "UPDATE companies SET domain = 'x.example'",
      "UPDATE deployment_controls SET enrichment_enabled = true",
    ]) {
      expect(await denied(sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // The single UPDATE column it holds (for FOR UPDATE locks) is pinned by the 0006 trigger.
    expect(await denied("UPDATE company_observations SET id = id + 1000")).toBe("23514");
  });
});

describe("upgrade, re-run and rollback", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let owner: Pool;
  let oldDir: string;
  beforeAll(async () => {
    scratch = await createScratchDatabase();
    owner = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 2 });
    // The previous build's migrations: 0001-0008.
    oldDir = await mkdtemp(join(tmpdir(), "idr-migrations-0008-"));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql") && n < "0009")) await copyFile(join(MIGRATIONS_DIR, f), join(oldDir, f));
  });
  afterAll(async () => {
    await owner.end();
    await scratch.drop();
    await rm(oldDir, { recursive: true, force: true });
  });

  it("an existing 0001-0008 install with data upgrades: 0009 applies, the role is provisioned, the data and the guards are intact", async () => {
    const before = await applyMigrations(owner, undefined, { dir: oldDir });
    expect(before.applied).toHaveLength(8);
    const companyId = await createCompany(owner, "upgrade.example");
    const kept = await insertObservation(owner, { companyId });
    const pruned = await insertObservation(owner, { companyId, observedAt: new Date(Date.now() - 40 * 86_400_000) });
    await createFeedRetention(owner).pruneBefore(new Date(Date.now() - 30 * 86_400_000), 10);
    const proBefore = await owner.query("SELECT prosecdef FROM pg_proc WHERE proname = 'feed_record_observation_deletes'");
    expect(proBefore.rows[0].prosecdef).toBe(false);

    // Why 0009 exists: with the 0008 trigger (running as the deleting role) a
    // runtime role without write access to the watermark cannot run retention.
    await provisionTestRuntimeRole(scratch.url, { dir: oldDir });
    const rt0 = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
    try {
      await insertObservation(owner, { companyId, observedAt: new Date(Date.now() - 45 * 86_400_000) });
      expect(await codeOf(createFeedRetention(rt0.pool).pruneBefore(new Date(Date.now() - 30 * 86_400_000), 10))).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await owner.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(2);
    } finally {
      await rt0.close();
    }
    // A plain DELETE (not the SKIP LOCKED retention batch): node-postgres reports the refused statement as soon as
    // the error arrives, possibly before the server has finished aborting it, so its row lock can still be held and
    // a SKIP LOCKED batch would skip the row. This DELETE waits for the lock instead; the trigger advances the watermark.
    const deleted = await owner.query("DELETE FROM company_observations WHERE observed_at < $1", [new Date(Date.now() - 30 * 86_400_000)]);
    expect(deleted.rowCount).toBe(1);

    const wm0008 = (await owner.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows[0].id as string;
    expect(BigInt(wm0008)).toBeGreaterThan(BigInt(pruned.id));
    const up = await provisionTestRuntimeRole(scratch.url);
    expect(up.applied).toEqual(["0009_runtime_role_support.sql"]);
    const pro = await owner.query("SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'feed_record_observation_deletes'");
    expect(pro.rows[0]).toEqual({ prosecdef: true, proconfig: ["search_path=public, pg_temp"] });
    expect((await owner.query("SELECT id::text FROM company_observations")).rows).toEqual([{ id: kept.id }]);
    expect((await owner.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows).toEqual([{ id: wm0008 }]);
    // The guards still hold for the owner (0007 unchanged).
    expect(await codeOf(owner.query("TRUNCATE company_observations"))).toBe("23514");
    expect(await codeOf(owner.query("DELETE FROM feed_retention_watermarks"))).toBe("23514");

    // Runtime retention after the upgrade advances the watermark.
    const rt = createRuntimeDb({ databaseUrl: scratch.url, max: 1 });
    try {
      const later = await insertObservation(owner, { companyId, observedAt: new Date(Date.now() - 35 * 86_400_000) });
      expect(await createFeedRetention(rt.pool).pruneBefore(new Date(Date.now() - 30 * 86_400_000), 10)).toBe(1);
      expect((await owner.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows).toEqual([{ id: later.id }]);
    } finally {
      await rt.close();
    }
  });

  it("re-running migrate changes nothing (no migration, same grants)", async () => {
    const before = await privilegesOf(owner, TEST_RUNTIME_ROLE);
    const again = await provisionTestRuntimeRole(scratch.url);
    expect(again.applied).toEqual([]);
    expect(await privilegesOf(owner, TEST_RUNTIME_ROLE)).toEqual(before);
  });

  it("rollback: the previous build (0001-0008, connecting as the owner, no role separation) still works against the upgraded database", async () => {
    // Its migrate finds nothing to apply; its startup check passes (the database is ahead, which is reported, not refused).
    expect((await applyMigrations(owner, undefined, { dir: oldDir })).applied).toEqual([]);
    const status = await migrationStatus(owner, undefined, { dir: oldDir });
    expect(status).toEqual({ pending: [], unknown: ["0009_runtime_role_support.sql"] });
    await assertSchemaCurrent(owner, undefined, { dir: oldDir });
    // Its runtime paths, as the owner: writes, retention (watermark), erasure, the kill switch.
    const db = createDb({ databaseUrl: scratch.url, ssl: "disable", max: 2 });
    try {
      const companyId = await db.companies.upsert({ domain: "rollback.example", organisationName: null }, new Date());
      const rec = await db.activity.recordObservation({ scope: FEED_SCOPE, companyId, observationRef: "rollback-ref-0000000001", source: "cache", observedAt: new Date(Date.now() - 50 * 86_400_000) });
      expect(rec.kind).toBe("recorded");
      const wmBefore = (await owner.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows[0].id as string;
      expect(await createFeedRetention(db.pool).pruneBefore(new Date(Date.now() - 30 * 86_400_000), 10)).toBe(1);
      expect(BigInt((await owner.query("SELECT pruned_through_id::text AS id FROM feed_retention_watermarks")).rows[0].id)).toBeGreaterThan(BigInt(wmBefore));
      await db.controls.setEnrichmentEnabled(FEED_SCOPE.installationId, false, "rollback check");
      expect(await db.controls.isEnrichmentEnabled(FEED_SCOPE.installationId)).toBe(false);
      expect(await eraseCompany(db.pool, { companyId })).toMatchObject({ erased: true });
    } finally {
      await db.close();
    }
  });
});
