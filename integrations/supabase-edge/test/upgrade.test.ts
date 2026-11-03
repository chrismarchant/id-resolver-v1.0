/**
 * Upgrade path of sql/0001_idr_projection.sql (CHR-66 round 3): the script
 * must stay re-runnable over installs of earlier releases, keeping every
 * existing row. Fixtures are verbatim copies of the script as released at
 * 6318ab2 (before the gap log), f12b1ad (gap log, round 2) and fced2ea
 * (schema version 4, the Gate 3 release, unchanged until Gate 5). Every
 * install is created under Supabase's default privileges (freshPublicSchema),
 * so the upgrade must also take away what those defaults granted (G4-L4).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleSyncRequest, PROJECTION_SCHEMA_VERSION, runSync } from "../src/core/index.ts";
import { EXPECTED_FUNCTION_GRANTS, EXPECTED_RELATION_GRANTS, columnGrants, functionGrants, relationGrants } from "./helpers/acl.ts";
import { FakePostgrest, SERVICE_KEY } from "./helpers/fake-postgrest.ts";
import { TOKEN } from "./helpers/mock-resolver.ts";
import { INSTALLATION, PgStore, SQL_PATH, TEST_DB_URL, asRole, counts, ensureProjection, freshPublicSchema, gapRows, newPool, resetDatabase, storedCursor } from "./helpers/db.ts";
import { MockResolver, obs } from "./helpers/mock-resolver.ts";
import { testConfig, testDeps } from "./helpers/setup.ts";

const fixture = (rel: string) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const LEGACY = {
  "6318ab2": fixture("0001_idr_projection.6318ab2.sql"),
  f12b1ad: fixture("0001_idr_projection.f12b1ad.sql"),
  fced2ea: fixture("0001_idr_projection.fced2ea.sql"),
} as const;
const D = "2026-11-02T12:00:00.000Z";

let pool: pg.Pool;
const mock = new MockResolver();

beforeAll(async () => {
  pool = newPool();
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
  // Leave the current schema behind for any later suite.
  await resetDatabase(pool);
  await pool.end();
});
beforeEach(() => {
  mock.reset();
});

async function installLegacy(version: keyof typeof LEGACY): Promise<void> {
  await freshPublicSchema(pool);
  await ensureProjection(pool, LEGACY[version]);
}

/** A consumer that applied obs 1-2 (cursor c2) through the legacy functions. */
async function seedLegacyState(version: keyof typeof LEGACY): Promise<void> {
  const items = JSON.stringify([obs(1, 7, D), obs(2, 7, D)]);
  if (version === "fced2ea") {
    // Schema 4: five-argument apply, three-argument gap record (an open gap with needs_resync).
    await asRole(pool, "service_role", (c) => c.query("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb, null)", [INSTALLATION, items]));
    await asRole(pool, "service_role", (c) => c.query("select public.idr_record_sync_gap($1, 'cursor_expired', 'c2')", [INSTALLATION]));
    return;
  }
  await asRole(pool, "service_role", (c) => c.query("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb)", [INSTALLATION, items]));
  if (version === "f12b1ad") {
    // Round-2 gap record (two-argument function of that release): an open gap with needs_resync.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_record_sync_gap($1, 'cursor_expired')", [INSTALLATION]));
  } else {
    await asRole(pool, "service_role", (c) => c.query("select public.idr_record_sync_status($1, 'needs_resync', true)", [INSTALLATION]));
  }
}

const idrFunctions = async () =>
  (
    await pool.query<{ sig: string; acl: string[] }>(
      "select p.oid::regprocedure::text as sig, p.proacl::text[] as acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%' order by 1",
    )
  ).rows;

describe.each(["6318ab2", "f12b1ad", "fced2ea"] as const)("upgrade from the %s release", (version) => {
  it("R2-6: before the upgrade the current function refuses loudly (schema_mismatch, HTTP 500), fetches nothing and writes nothing", async () => {
    await installLegacy(version);
    await seedLegacyState(version);
    const before = (await pool.query("select * from public.idr_sync_state")).rows;
    const gapsBefore = version === "6318ab2" ? null : await gapRows(pool);
    mock.items = [1, 2, 3].map((i) => obs(i, 7, D));

    expect((await runSync(testConfig(mock), testDeps(new PgStore(pool)))).status).toBe("schema_mismatch");

    const rest = new FakePostgrest(pool);
    await rest.start();
    const SECRET = "0123456789abcdef0123456789abcdef";
    const logs: string[] = [];
    try {
      const res = await handleSyncRequest(new Request("http://function.invalid/idr-sync", { method: "POST", headers: { "x-idr-sync-secret": SECRET } }), {
        env: {
          IDR_BASE_URL: mock.baseUrl,
          IDR_REPORTING_TOKEN: TOKEN,
          IDR_INSTALLATION_ID: INSTALLATION,
          IDR_SYNC_SECRET: SECRET,
          SUPABASE_URL: rest.url,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
          IDR_ALLOW_INSECURE_HTTP: "true",
        },
        fetch,
        sleep: () => Promise.resolve(),
        log: (m) => logs.push(m),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ status: "schema_mismatch", pages: 0 });
      expect(logs.some((l) => l.startsWith("schema mismatch:"))).toBe(true);
    } finally {
      await rest.stop();
    }
    expect(mock.requests).toHaveLength(0);
    expect((await pool.query("select * from public.idr_sync_state")).rows).toEqual(before);
    if (gapsBefore) expect(await gapRows(pool)).toEqual(gapsBefore);
  });

  it("re-running the current script (twice) keeps every row, drops superseded signatures and converges grants", async () => {
    await installLegacy(version);
    await seedLegacyState(version);
    const before = { counts: await counts(pool), gaps: version === "6318ab2" ? [] : await gapRows(pool) };
    if (version !== "6318ab2") expect(before.gaps).toHaveLength(1);
    expect(before.counts.observations).toBe(2);

    await ensureProjection(pool);
    await ensureProjection(pool);

    expect(await counts(pool)).toEqual(before.counts);
    expect(await storedCursor(pool)).toBe("c2");
    const st = await pool.query("select needs_resync, reset_from_cursor from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ needs_resync: true, reset_from_cursor: null });
    expect((await gapRows(pool)).map((g) => [g.id, g.kind, g.resolved_at])).toEqual(before.gaps.map((g) => [g.id, g.kind, g.resolved_at]));

    const fns = await idrFunctions();
    const sigs = fns.map((f) => f.sig);
    expect(sigs).not.toContain("idr_apply_feed_page(text,text,text,jsonb)");
    expect(sigs).not.toContain("idr_record_sync_gap(text,text)");
    expect(sigs).not.toContain("idr_apply_feed_page(text,text,text,jsonb,text)");
    expect(sigs).toContain("idr_apply_feed_page(text,text,text,jsonb,text,boolean)");
    expect(sigs).toContain("idr_record_sync_gap(text,text,text)");
    expect(sigs).not.toContain("idr_resolve_sync_gaps(text)");
    expect(sigs).toContain("idr_resolve_sync_gaps(text,text)");
    expect((await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
    const gens = await pool.query("select resync_generation::int as resync, replay_generation::int as replay from public.idr_sync_state");
    expect(gens.rows[0]).toEqual({ resync: 0, replay: 0 });
    // A gap of a release before schema 4 has no generation (treated as 0: needs a resync after the upgrade).
    expect((await gapRows(pool)).map((g) => g.detected_generation)).toEqual(before.gaps.map(() => (version === "fced2ea" ? 0 : null)));
    // G4-L4: the grants converge to exactly the intended ones, whatever the earlier release and Supabase's defaults left.
    expect(fns.map((f) => f.sig).sort()).toEqual(Object.keys(EXPECTED_FUNCTION_GRANTS).sort());
    expect(await functionGrants(pool)).toEqual(EXPECTED_FUNCTION_GRANTS);
    expect(await relationGrants(pool)).toEqual(EXPECTED_RELATION_GRANTS);
    expect(await columnGrants(pool)).toEqual([]);
  });

  it("the current engine then records (or keeps) exactly one gap, and resync + drain resolves it without losing the row", async () => {
    await installLegacy(version);
    await seedLegacyState(version);
    await ensureProjection(pool);
    const store = new PgStore(pool);
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 7, D));

    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("needs_resync");
    expect(r.gap).toMatchObject({ recorded: true, newGap: version === "6318ab2" });
    expect(await gapRows(pool)).toHaveLength(1);

    await pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
    const ok = await runSync(testConfig(mock), testDeps(store));
    expect(ok).toMatchObject({ status: "ok", gapsResolved: 1 });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ resolution: "full_resync" });
    expect((await counts(pool)).observations).toBe(4);
  });
});

describe("upgrade from schema 4 in the middle of a resync (R2-8)", () => {
  it("a gap whose resync and replay started under schema 4 resolves at the first drained run after the upgrade, with no new resync", async () => {
    await installLegacy("fced2ea");
    await seedLegacyState("fced2ea"); // obs 1-2 at c2, an open gap with needs_resync
    await pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
    // The replay's first page, applied by the schema-4 function (five arguments, no drain flag).
    await asRole(pool, "service_role", (c) => c.query("select public.idr_apply_feed_page($1, null, 'c1', $2::jsonb, null)", [INSTALLATION, JSON.stringify([obs(1, 7, D)])]));
    await ensureProjection(pool);
    const st = (await pool.query("select replay_generation::int as r, drained_generation from public.idr_sync_state")).rows[0];
    expect(st).toEqual({ r: 1, drained_generation: null }); // no drain proven yet
    expect(await new PgStore(pool).resolveGaps("c1")).toBe(0);
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 7, D));
    const r = await runSync(testConfig(mock), testDeps(new PgStore(pool)));
    expect(r).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect((await gapRows(pool)).map((g) => g.resolution)).toEqual(["full_resync"]);
  });
});

describe("R3-D: the script is atomic and reports its version last", () => {
  const sql = () => readFileSync(SQL_PATH, "utf8");
  /** The script with `stmt` injected just before its closing `end` (inside the single DO statement). */
  const injectAtEnd = (stmt: string) => sql().replace(/\nend\n\$idr_projection\$;\s*$/, `\n${stmt}\nend\n$idr_projection$;\n`);
  /** Statements without comments, for structural checks. */
  const code = () =>
    sql()
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .trim();

  it("is ONE statement (a single DO block) with no transaction control of its own, no transaction-unsafe statement, and defines idr_schema_version() last", () => {
    const c = code();
    expect(c.startsWith("do $idr_projection$\nbegin\n")).toBe(true);
    expect(c.endsWith("\nend\n$idr_projection$;")).toBe(true);
    expect(c.split("$idr_projection$").length).toBe(3); // the delimiter appears exactly twice
    // No transaction control at the top level of the block (function bodies and the nested DO blocks, all
    // dollar-quoted, are left out): a migration runner's own transaction is never committed or ended early.
    const body = c.slice("do $idr_projection$\nbegin\n".length, c.length - "\nend\n$idr_projection$;".length);
    const topLevel = body.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$...$$");
    expect(topLevel).toMatch(/create table if not exists public\.idr_sync_gaps/); // the stripping kept the top level
    expect(topLevel).not.toMatch(/^\s*(begin|commit|rollback|end|abort|start\s+transaction|savepoint|release)\b[^;]*;/im);
    expect(c).not.toMatch(/\bconcurrently\b|\bvacuum\b|alter\s+system|create\s+database/i);
    const defs = [...c.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    expect(defs[defs.length - 1]).toBe("public.idr_schema_version");
  });

  it("a failure late in the script leaves the earlier release fully intact: no version reported, old signatures and rows kept", async () => {
    await installLegacy("f12b1ad");
    await seedLegacyState("f12b1ad");
    const before = await counts(pool);
    const broken = injectAtEnd("perform 1 / 0;");
    expect(broken).not.toBe(sql());
    const c = await pool.connect();
    try {
      await expect(c.query(broken)).rejects.toThrow(/division by zero/);
      await c.query("rollback");
    } finally {
      c.release();
    }
    const probe = await pool.query(
      "select to_regprocedure('public.idr_schema_version()') as v, to_regprocedure('public.idr_record_sync_gap(text,text)') as old_gap, to_regprocedure('public.idr_record_sync_gap(text,text,text)') as new_gap",
    );
    expect(probe.rows[0]).toEqual({ v: null, old_gap: "idr_record_sync_gap(text,text)", new_gap: null });
    const cols = await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'idr_sync_state' and column_name = 'reset_from_cursor'");
    expect(cols.rowCount).toBe(0);
    expect(await counts(pool)).toEqual(before);
    // The current function refuses this install, as for any earlier release.
    expect((await runSync(testConfig(mock), testDeps(new PgStore(pool)))).status).toBe("schema_mismatch");
    // A clean re-run then upgrades it.
    await ensureProjection(pool);
    expect((await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
  });

  const hasPsql = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!hasPsql)("with psql's default (continue after an error, autocommit), a failure in the middle still applies nothing: no version reported, no new function", async () => {
    await installLegacy("f12b1ad");
    await seedLegacyState("f12b1ad");
    const marker = "create or replace function public.idr_resolve_sync_gaps(";
    expect(sql()).toContain(marker);
    const broken = sql().replace(marker, `perform 1 / 0;\n${marker}`);
    const dir = mkdtempSync(join(tmpdir(), "idr-sql-"));
    try {
      const file = join(dir, "broken.sql");
      writeFileSync(file, broken);
      const r = spawnSync("psql", ["-X", "-q", "-d", TEST_DB_URL, "-f", file], { encoding: "utf8" });
      expect(r.stderr).toMatch(/division by zero/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const probe = await pool.query(
      "select to_regprocedure('public.idr_schema_version()') as v, to_regprocedure('public.idr_record_sync_gap(text,text)') as old_gap, to_regprocedure('public.idr_record_sync_gap(text,text,text)') as new_gap",
    );
    expect(probe.rows[0]).toEqual({ v: null, old_gap: "idr_record_sync_gap(text,text)", new_gap: null });
  });
});


describe("migration runners (CHR-66 R3-D follow-up): the script never ends a runner's transaction", () => {
  const sql = () => readFileSync(SQL_PATH, "utf8");
  const exists = async () =>
    (
      await pool.query(
        "select to_regclass('public.idr_sync_gaps') is not null as gaps, to_regclass('public.runner_history') is not null as history, to_regprocedure('public.idr_schema_version()') is not null as version",
      )
    ).rows[0];

  it("inside a runner's own transaction (BEGIN, bookkeeping, the file, bookkeeping): ROLLBACK undoes all of it, COMMIT keeps all of it", async () => {
    await freshPublicSchema(pool);
    const runner = async (end: "rollback" | "commit") => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("create table if not exists public.runner_history (version text primary key)");
        await c.query(sql()); // as the runner sends a migration file
        await c.query("insert into public.runner_history values ('0001_idr_projection')");
        await c.query(end);
      } finally {
        c.release();
      }
    };
    await runner("rollback"); // e.g. the runner's own step after the file failed
    expect(await exists()).toEqual({ gaps: false, history: false, version: false });
    await runner("commit");
    expect(await exists()).toEqual({ gaps: true, history: true, version: true });
    expect((await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
    expect(await relationGrants(pool)).toMatchObject(EXPECTED_RELATION_GRANTS);
  });

  const hasPsql = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
  const psql = (args: string[], file = SQL_PATH) => spawnSync("psql", ["-X", "-q", "-d", TEST_DB_URL, ...args, "-f", file], { encoding: "utf8" });

  it.skipIf(!hasPsql)("psql --single-transaction -v ON_ERROR_STOP=1 (the documented command): applies, twice, with no WARNING and no ERROR", async () => {
    await freshPublicSchema(pool);
    for (let i = 0; i < 2; i++) {
      const r = psql(["--single-transaction", "-v", "ON_ERROR_STOP=1"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/WARNING|ERROR/);
    }
    expect((await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
  });

  it.skipIf(!hasPsql)("plain psql -f (autocommit, no flags) applies too, twice", async () => {
    await freshPublicSchema(pool);
    for (let i = 0; i < 2; i++) {
      const r = psql([]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/WARNING|ERROR/);
    }
    expect((await pool.query<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
  });

  it.skipIf(!hasPsql)("the documented command with a failure in the script: exit code 3 and nothing applied", async () => {
    await freshPublicSchema(pool);
    const marker = "create or replace function public.idr_resolve_sync_gaps(";
    const dir = mkdtempSync(join(tmpdir(), "idr-sql-"));
    try {
      const file = join(dir, "broken.sql");
      writeFileSync(file, sql().replace(marker, `perform 1 / 0;\n${marker}`));
      const r = psql(["--single-transaction", "-v", "ON_ERROR_STOP=1"], file);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/division by zero/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await exists()).toEqual({ gaps: false, history: false, version: false });
  });
});
