import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../../src/db/pool.js";
import { applyMigrations, assertSchemaCurrent, migrationStatus, PendingMigrationsError } from "../../src/db/migrate.js";
import { createDb } from "../../src/db/index.js";
import { createScratchDatabase } from "../helpers/db.js";

const ROOT = join(import.meta.dirname, "..", "..");

describe("migrations", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    pool = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  it("applies once, then a second run is a no-op", async () => {
    const first = await applyMigrations(pool);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.applied).toContain("0001_initial.sql");
    const second = await applyMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
    const rows = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.rows.map((r) => r.name)).toEqual(first.applied);
  });

  it("creates the expected tables with no IP-ish columns", async () => {
    const cols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    const tables = new Set(cols.rows.map((r) => r.table_name));
    for (const t of ["companies", "ip_resolution_cache", "usage_periods", "deployment_controls", "schema_migrations", "company_observations", "company_scope_stats", "company_observation_refs", "browser_events", "bot_visits"]) {
      expect(tables.has(t)).toBe(true);
    }
    for (const r of cols.rows) {
      expect(["inet", "cidr", "macaddr"]).not.toContain(r.data_type);
      // ip_fingerprint (HMAC output) is the only IP-related column allowed.
      if (r.column_name === "ip_fingerprint") continue;
      expect(r.column_name).not.toMatch(/(^|_)(ip|ip_address|asn|isp|geo|latitude|longitude|city|country)(_|$)/);
    }
  });

  it("0008 browser_events (event.v1, D4): exactly the contract's columns, no company/address/fingerprint/observation reference, no foreign key or trigger, and constraints that refuse anything else", async () => {
    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'browser_events' ORDER BY ordinal_position",
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "id",
      "installation_id",
      "website_id",
      "event_id",
      "type",
      "name",
      "page_key",
      "consent",
      "origin",
      "occurred_at",
      "received_at",
    ]);
    for (const c of cols.rows) {
      expect(c.is_nullable, c.column_name).toBe("NO");
      expect(["inet", "cidr", "macaddr", "bytea"], c.column_name).not.toContain(c.data_type);
      expect(c.column_name).not.toMatch(/company|(^|_)ip(_|$)|address|fingerprint|observation|session|visitor|user_agent|referrer|cookie/);
    }
    expect(cols.rows.find((c) => c.column_name === "origin")!.column_default).toBe("'browser'::text");
    // No foreign key from or to browser_events: nothing can join it to company data through the schema.
    const fks = await pool.query(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND (conrelid = 'public.browser_events'::regclass OR confrelid = 'public.browser_events'::regclass)`,
    );
    expect(fks.rows).toEqual([]);
    // No trigger: inserts and retention deletes touch this table only (never the feed watermark or tombstones).
    expect((await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.browser_events'::regclass")).rows).toEqual([]);
    const idx = await pool.query<{ def: string }>("SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indrelid = 'public.browser_events'::regclass");
    const defs = idx.rows.map((r) => r.def);
    expect(defs.some((d) => d.includes("browser_events_retention_idx") && d.includes("(received_at, id)"))).toBe(true);
    expect(defs.some((d) => d.includes("UNIQUE") && d.includes("(installation_id, website_id, event_id)"))).toBe(true);

    const insert = (over: Record<string, string> = {}) => {
      const row = {
        installation_id: "inst",
        website_id: "site",
        event_id: "evt-migration-000000001",
        type: "page_view",
        name: "page_view",
        page_key: "/pricing",
        consent: "granted",
        ...over,
      };
      const keys = Object.keys(row);
      return pool.query(
        `INSERT INTO browser_events (${keys.join(", ")}, occurred_at) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, now()) RETURNING origin, received_at`,
        Object.values(row),
      );
    };
    const ok = await insert();
    expect(ok.rows[0].origin).toBe("browser");
    expect(ok.rows[0].received_at).toBeInstanceOf(Date);
    // Idempotency key per (installation, website).
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await insert({ website_id: "other-site" });
    const bad: Array<Record<string, string>> = [
      { origin: "server" },
      { consent: "yes" },
      { consent: "denied" },
      { event_id: "short" },
      { event_id: "x".repeat(65) },
      { event_id: "has space 000000000" },
      { type: "Page View" },
      { name: "https://example.com/" },
      { name: "x".repeat(33) },
      { page_key: "/a?b=1" },
      { page_key: "/a#frag" },
      { page_key: "/a b" },
      { page_key: "pricing" },
      { page_key: `/${"p".repeat(256)}` },
      { installation_id: "Bad Id" },
      { website_id: "" },
    ];
    for (const [i, over] of bad.entries()) {
      await expect(insert({ event_id: `evt-migration-bad-${String(i).padStart(4, "0")}`, ...over }), JSON.stringify(over)).rejects.toMatchObject({ code: "23514" });
    }
    expect(await insert({ event_id: "evt-migration-000000002", page_key: `/${"p".repeat(255)}`, consent: "not_required" })).toMatchObject({ rowCount: 1 });
    await pool.query("DELETE FROM browser_events");
  });

  it("two concurrent applyMigrations calls on a fresh database do not fail", async () => {
    const fresh = await createScratchDatabase();
    const p = createPool({ databaseUrl: fresh.url, ssl: "disable", max: 6 });
    try {
      const results = await Promise.all([1, 2, 3, 4].map(() => applyMigrations(p)));
      const appliedTotal = results.reduce((n, r) => n + r.applied.length, 0);
      const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
      expect(appliedTotal).toBe(files.length);
    } finally {
      await p.end();
      await fresh.drop();
    }
  });

  it("a failing migration rolls back and reports only a code", async () => {
    const fresh = await createScratchDatabase();
    const p = createPool({ databaseUrl: fresh.url, ssl: "disable", max: 2 });
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE t_ok (id int);");
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE t_half (id int); SELECT 1/0 AS secret_value_42;");
    try {
      await expect(applyMigrations(p, undefined, { dir })).rejects.toMatchObject({ name: "MigrationError", code: "22012" });
      const t = await p.query("SELECT to_regclass('t_ok') AS ok, to_regclass('t_half') AS half");
      expect(t.rows[0].ok).not.toBeNull();
      expect(t.rows[0].half).toBeNull();
      const applied = await p.query("SELECT name FROM schema_migrations");
      expect(applied.rows.map((r) => r.name)).toEqual(["0001_ok.sql"]);
    } finally {
      await p.end();
      await fresh.drop();
    }
  });
});

describe("privacy guard: no IP-bearing schema", () => {
  const tokens = ["inet", "cidr", "ip_address", "raw_ip"];
  const files: string[] = [];
  for (const f of readdirSync(join(ROOT, "migrations"))) files.push(join(ROOT, "migrations", f));
  for (const f of readdirSync(join(ROOT, "src", "db"))) if (f.endsWith(".ts")) files.push(join(ROOT, "src", "db", f));

  it("scans at least the migration and repo files", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    it(`${file.slice(ROOT.length + 1)} contains no ${tokens.join("/")} token`, () => {
      const text = readFileSync(file, "utf8").toLowerCase();
      // Word-ish match so e.g. "inetd"-style identifiers still trip, but prose
      // like "ip_resolution_cache" does not.
      for (const t of tokens) {
        const hit = new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(text);
        expect(hit, `forbidden token "${t}"`).toBe(false);
      }
    });
  }

  it("0003 upgrades a populated 0002 database: references backfilled from recorded observations, replay answers and conflicts preserved, nothing invented", async () => {
    const fresh = await createScratchDatabase();
    const p = createPool({ databaseUrl: fresh.url, ssl: "disable", max: 4 });
    try {
      // Apply only 0001 and 0002, then populate the pre-fix schema.
      const partial = mkdtempSync(join(tmpdir(), "idr-mig-"));
      for (const f of ["0001_initial.sql", "0002_company_activity.sql"]) copyFileSync(join(ROOT, "migrations", f), join(partial, f));
      const first = await applyMigrations(p, undefined, { dir: partial });
      expect(first.applied).toEqual(["0001_initial.sql", "0002_company_activity.sql"]);
      const t = (ms: number) => new Date(Date.UTC(2026, 2, 1, 12, 0, 0, ms));
      const ins = await p.query<{ id: string }>(
        "INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at) VALUES ('a.example', 'A', $1, $1), ('b.example', 'B', $1, $1) RETURNING id",
        [t(0)],
      );
      const [a, b] = ins.rows.map((r) => Number(r.id));
      // Scope 1: A first (ref-1), A again (ref-2), B first (ref-3); scope 2 reuses ref-1 for A.
      await p.query(
        `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, company_first) VALUES
         ('inst', 'site', $1, $3, 'ref-1-0000000000000', 'provider', true),
         ('inst', 'site', $1, $4, 'ref-2-0000000000000', 'cache', false),
         ('inst', 'site', $2, $5, 'ref-3-0000000000000', 'provider', true),
         ('inst', 'other', $1, $6, 'ref-1-0000000000000', 'provider', true),
         ('inst', 'site', $1, $7, 'ref-4-0000000000000', 'cache', false)`,
        [a, b, t(1_000), t(2_000), t(3_000), t(4_000), t(5_000)],
      );
      await p.query(
        `INSERT INTO company_scope_stats (installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count) VALUES
         ('inst', 'site', $1, $3, $5, 3), ('inst', 'site', $2, $4, $4, 1), ('inst', 'other', $1, $6, $6, 1)`,
        [a, b, t(1_000), t(3_000), t(5_000), t(4_000)],
      );
      // A retention prune ran before the fix shipped: ref-4's observation is already gone.
      await p.query("DELETE FROM company_observations WHERE observation_ref = 'ref-4-0000000000000'");

      // A company whose true first observation was pruned before 0003 recorded references: stats say t(100), only t(200) survives.
      const insC = await p.query<{ id: string }>("INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at) VALUES ('c.example', 'C', $1, $1) RETURNING id", [t(0)]);
      const c = Number(insC.rows[0]!.id);
      await p.query(
        "INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, company_first) VALUES ('inst', 'site', $1, $2, 'ref-c2-000000000000', 'cache', false)",
        [c, t(200)],
      );
      await p.query("INSERT INTO company_scope_stats (installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count) VALUES ('inst', 'site', $1, $2, $3, 2)", [c, t(100), t(200)]);
      // Two observations of B at the same instant in the other scope: the surviving lowest id is the deterministic backfill choice.
      await p.query(
        `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, company_first) VALUES
         ('inst', 'other', $1, $2, 'ref-b-tie-1-0000000', 'cache', true), ('inst', 'other', $1, $2, 'ref-b-tie-2-0000000', 'cache', false)`,
        [b, t(7_000)],
      );
      await p.query("INSERT INTO company_scope_stats (installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count) VALUES ('inst', 'other', $1, $2, $2, 2)", [b, t(7_000)]);

      const statsBefore = (await p.query("SELECT installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count FROM company_scope_stats ORDER BY website_id, company_id")).rows;

      // Upgrade: 0003 then 0004 apply (then the additive V1 0005, which leaves existing rows' values unchanged).
      const upgrade = await applyMigrations(p);
      expect(upgrade.applied).toEqual(["0003_observation_refs.sql", "0004_first_observation_identity.sql", "0005_observation_context_and_feed.sql", "0006_feed_tombstones_and_watermark.sql", "0007_feed_immutability_guards.sql", "0008_browser_events.sql", "0009_runtime_role_support.sql", "0010_provider_charge_slots.sql", "0011_activity_counters.sql", "0012_bot_visits.sql", "0013_browser_events_report_index.sql", "0014_bot_visit_ai_categories.sql"]);
      const identities = await p.query<{ website_id: string; company_id: string; first_observation_ref: string | null }>(
        "SELECT website_id, company_id, first_observation_ref FROM company_scope_stats ORDER BY website_id, company_id",
      );
      expect(identities.rows.map((r) => [r.website_id, Number(r.company_id), r.first_observation_ref])).toEqual([
        ["other", a, "ref-1-0000000000000"],
        ["other", b, "ref-b-tie-1-0000000"],
        ["site", a, "ref-1-0000000000000"],
        ["site", b, "ref-3-0000000000000"],
        ["site", c, null], // unreconstructable: the true first row was pruned before 0003
      ]);
      const cols = await p.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'company_observations'");
      expect(cols.rows.map((c) => c.column_name)).not.toContain("company_first");
      const refs = await p.query<{ website_id: string; observation_ref: string; company_id: string; previously_seen: boolean; observed_at: Date }>(
        "SELECT website_id, observation_ref, company_id, previously_seen, observed_at FROM company_observation_refs ORDER BY website_id, observation_ref",
      );
      expect(refs.rows.map((r) => [r.website_id, r.observation_ref, Number(r.company_id), r.previously_seen, r.observed_at.getTime()])).toEqual([
        ["other", "ref-1-0000000000000", a, false, t(4_000).getTime()],
        ["other", "ref-b-tie-1-0000000", b, false, t(7_000).getTime()],
        ["other", "ref-b-tie-2-0000000", b, true, t(7_000).getTime()],
        ["site", "ref-1-0000000000000", a, false, t(1_000).getTime()],
        ["site", "ref-2-0000000000000", a, true, t(2_000).getTime()],
        ["site", "ref-3-0000000000000", b, false, t(3_000).getTime()],
        ["site", "ref-c2-000000000000", c, true, t(200).getTime()],
      ]);
      // Exactly the recorded observations became records: no stats values or observation rows were invented or changed (0004 only adds the identity column).
      const statsAfter = (await p.query("SELECT installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count FROM company_scope_stats ORDER BY website_id, company_id")).rows;
      expect(statsAfter).toEqual(statsBefore);
      expect((await p.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(7);

      // Behaviour on the upgraded database through the repositories.
      const db = createDb({ databaseUrl: fresh.url, ssl: "disable", max: 2 });
      try {
        const scope = { installationId: "inst", websiteId: "site" };
        expect(await db.activity.recordObservation({ scope, companyId: a, observationRef: "ref-1-0000000000000", source: "cache", observedAt: t(9_000) })).toMatchObject({ kind: "duplicate", sameCompany: true, previouslySeen: false });
        expect(await db.activity.recordObservation({ scope, companyId: a, observationRef: "ref-2-0000000000000", source: "cache", observedAt: t(9_000) })).toMatchObject({ kind: "duplicate", sameCompany: true, previouslySeen: true });
        expect(await db.activity.recordObservation({ scope, companyId: b, observationRef: "ref-1-0000000000000", source: "provider", observedAt: t(9_000) })).toMatchObject({ kind: "duplicate", sameCompany: false });
        // Documented limitation: a reference whose observation was pruned BEFORE 0003 has no record and cannot be reconstructed, so it records as new.
        expect(await db.activity.recordObservation({ scope, companyId: a, observationRef: "ref-4-0000000000000", source: "cache", observedAt: t(9_000) })).toMatchObject({ kind: "recorded", previouslySeen: true });
        expect((await p.query("SELECT observation_count::int AS n FROM company_scope_stats WHERE website_id = 'site' AND company_id = $1", [a])).rows[0].n).toBe(4);
        // Classification from the scoped earliest timestamp: all three companies first observed on this day
        // (C through its lifetime stats, although its first row was pruned before the upgrade); 5 observations survive.
        expect(await db.reporting.summary(scope, { from: t(0), to: new Date(t(0).getTime() + 86_400_000) })).toEqual({ observations: 5, observedCompanies: 3, newlyObservedCompanies: 3, previouslyObservedCompanies: 0 });
        const list = await db.reporting.listObservations(scope, a, { limit: 10, cursor: null });
        expect(list.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([["ref-4-0000000000000", false], ["ref-2-0000000000000", false], ["ref-1-0000000000000", true]]);
        // Unreconstructable identity flags no survivor; the lifetime stats still classify C as first observed on this day.
        const cList = await db.reporting.listObservations(scope, c, { limit: 10, cursor: null });
        expect(cList.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([["ref-c2-000000000000", false]]);
        // The equal-instant backfill chose the lowest surviving id deterministically.
        const tie = await db.reporting.listObservations({ installationId: "inst", websiteId: "other" }, b, { limit: 10, cursor: null });
        expect(tie.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([["ref-b-tie-2-0000000", false], ["ref-b-tie-1-0000000", true]]);
      } finally {
        await db.close();
      }
    } finally {
      await p.end();
      await fresh.drop();
    }
  });
});

describe("startup schema gate (migrations never run on start)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let pool: Pool;
  const all = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    pool = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  it("an empty database has every migration pending and is refused, read-only", async () => {
    const status = await migrationStatus(pool);
    expect(status).toEqual({ pending: all, unknown: [] });
    const err = await assertSchemaCurrent(pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PendingMigrationsError);
    expect((err as PendingMigrationsError).pending).toEqual(all);
    expect((err as Error).message).toContain("node dist/db/migrate.js");
    expect((err as Error).message).not.toContain(scratch.url);
    // The check never creates or changes anything.
    expect((await pool.query("SELECT to_regclass('public.schema_migrations')::text AS t")).rows[0].t).toBeNull();
  });

  it("a partially migrated database names exactly the missing files", async () => {
    const partial = mkdtempSync(join(tmpdir(), "idr-gate-"));
    for (const f of all.slice(0, -1)) copyFileSync(join(ROOT, "migrations", f), join(partial, f));
    await applyMigrations(pool, undefined, { dir: partial });
    const err = await assertSchemaCurrent(pool).catch((e: unknown) => e);
    expect((err as PendingMigrationsError).pending).toEqual([all.at(-1)]);
  });

  it("a current database passes; one ahead of the build passes and reports the unknown migration", async () => {
    await applyMigrations(pool);
    expect(await assertSchemaCurrent(pool)).toEqual({ pending: [], unknown: [] });
    await pool.query("INSERT INTO schema_migrations (name) VALUES ('9999_from_a_newer_build.sql')");
    expect(await assertSchemaCurrent(pool)).toEqual({ pending: [], unknown: ["9999_from_a_newer_build.sql"] });
  });
});
