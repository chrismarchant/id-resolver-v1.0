/**
 * Owner decision D4 (event.v1, Gate 4, CHR-64): browser events are never
 * associated with companies. The event path must never read or write the
 * fingerprint cache, the company, observation or activity tables, or call
 * the provider. Three independent proofs:
 *
 *  1. Statement spy. The server runs with ONE shared pool, as in production
 *     (src/main.ts): the real runner, pipeline and repositories and the
 *     event repository all issue their statements through it, and a proxy
 *     records every statement, including those on checked-out clients. Every
 *     statement issued while event requests run names `browser_events` and no
 *     other table; the runner and the provider are never called; no
 *     company, observation, cache or usage row appears. A control entrance
 *     through the same harness does touch those tables and the provider, so
 *     the spy would see it if the event path did.
 *  2. Least privilege. The event route and event retention run over a
 *     database role that can reach `browser_events` only. Any read or write
 *     of another table, directly or through a function or trigger, would
 *     fail with "permission denied" and the request would not answer 200.
 *  3. Imports. The event modules do not import, even transitively, the
 *     runner, the pipeline, the provider, the IP code or any other
 *     repository, and their code (comments aside) names no company, cache,
 *     fingerprint, provider or observation concept: there is no inactive or
 *     feature-flagged matching code.
 *
 * Synthetic data only: RFC 5737 documentation addresses, example.* domains.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { EVENTS_ROUTE } from "../../src/api/events.js";
import { buildServer } from "../../src/api/server.js";
import type { Runner } from "../../src/contracts/runtime.js";
import type { Db } from "../../src/db/index.js";
import { createActivityRepository } from "../../src/db/activity-repo.js";
import { createCacheRepository } from "../../src/db/cache-repo.js";
import { createCompanyRepository } from "../../src/db/company-repo.js";
import { createControlsRepository } from "../../src/db/controls-repo.js";
import { createEventRepository, INSERT_BROWSER_EVENT_SQL, PRUNE_BROWSER_EVENTS_SQL } from "../../src/db/event-repo.js";
import type { Pool } from "../../src/db/pool.js";
import { createUsageRepository } from "../../src/db/usage-repo.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createMockProvider } from "../../src/provider/mock.js";
import { buildPipelineConfig, createRunner } from "../../src/runtime/runner.js";
import { createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const ROOT = join(import.meta.dirname, "..", "..");
const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };
const QUALIFIED_IP = "203.0.113.10";

let seq = 0;
const eventBody = (over: Record<string, unknown> = {}) => ({
  contract: "event.v1",
  website_id: "site-test",
  event_id: `evt_iso_${randomBytes(6).toString("hex")}_${++seq}`,
  occurred_at: new Date().toISOString(),
  type: "conversion_intent",
  name: "form_submit",
  page_key: "/contact",
  consent: "granted",
  ...over,
});

interface Recorded {
  text: string;
}

/** The real pool behind a proxy that records every statement, on the pool and on every client it hands out. */
function spiedPool(real: pg.Pool): { pool: Pool; statements: Recorded[] } {
  const statements: Recorded[] = [];
  const textOf = (q: unknown) => (typeof q === "string" ? q : String((q as { text?: unknown }).text ?? ""));
  const wrap = <T extends object>(target: T, onQuery: (q: unknown) => void): T =>
    new Proxy(target, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r) as unknown;
        if (p === "query") {
          return (...args: unknown[]) => {
            onQuery(args[0]);
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (p === "connect") {
          return async (...args: unknown[]) => {
            const c = await (v as (...a: unknown[]) => Promise<pg.PoolClient>).apply(t, args);
            return wrap(c, onQuery);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  return { pool: wrap(real, (q) => statements.push({ text: textOf(q) })), statements };
}

/** Public tables named (as whole words) in a statement. */
function tablesIn(text: string, tables: readonly string[]): string[] {
  return tables.filter((t) => new RegExp(`(^|[^a-z0-9_])${t}([^a-z0-9_]|$)`, "i").test(text)).sort();
}

describe("event path isolation (owner decision D4)", () => {
  let db: Db;
  let tables: string[];

  beforeAll(async () => {
    db = await createTestDb({ max: 10 });
    tables = (await db.pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
    expect(tables).toContain("browser_events");
    expect(tables).toEqual(expect.arrayContaining(["companies", "company_observations", "ip_resolution_cache", "company_scope_stats", "company_observation_refs", "usage_periods"]));
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });
  afterAll(async () => {
    await resetTestDb(db);
    await db.close();
  });

  const count = async (table: string) => (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
  const COMPANY_SIDE = ["companies", "company_observations", "company_observation_refs", "company_scope_stats", "ip_resolution_cache", "usage_periods", "feed_tombstones", "feed_retention_watermarks"];

  it("statement spy: every statement issued while event requests run names browser_events only; no runner, provider or company-side row; a control entrance through the same harness does reach them", async () => {
    const spy = spiedPool(db.pool);
    const logger = createMemoryLogger();
    const config = testConfig({ EVENTS_ENABLED: "true", PROVIDER_MODE: "mock" });
    const pipeline = buildPipelineConfig(config);
    const provider = createMockProvider();
    let runnerCalls = 0;
    const real = createRunner({
      config: pipeline,
      deps: {
        cache: createCacheRepository(spy.pool, logger),
        usage: createUsageRepository(spy.pool, logger),
        controls: createControlsRepository(spy.pool, logger),
        companies: createCompanyRepository(spy.pool, logger),
        activity: createActivityRepository(spy.pool, logger),
        provider,
      },
      logger,
      capacity: config.MAX_CONCURRENT_JOBS,
    });
    const runner: Runner = { ...real, run: (job) => ((runnerCalls += 1), real.run(job)) };
    const app: FastifyInstance = await buildServer({ config, logger, runner, ping: async () => true, events: createEventRepository(spy.pool, logger) });
    await app.ready();
    try {
      const post = (body: unknown, headers: Record<string, string> = { ...auth, "x-forwarded-for": QUALIFIED_IP }) =>
        app.inject({ method: "POST", url: EVENTS_ROUTE, headers, payload: JSON.stringify(body), remoteAddress: QUALIFIED_IP });
      const accepted = eventBody();
      expect((await post(accepted)).json()).toEqual({ version: "1", recorded: true });
      expect((await post(accepted)).json()).toEqual({ version: "1", recorded: false });
      for (const [type, name] of [["page_view", "page_view"], ["engagement", "outbound_link"], ["conversion_intent", "cta_click"]]) {
        expect((await post(eventBody({ type, name }))).statusCode).toBe(200);
      }
      // Rejections issue no statement at all.
      const before = spy.statements.length;
      expect((await post(eventBody({ ip: QUALIFIED_IP }))).statusCode).toBe(400);
      expect((await post(eventBody({ company_id: 1 }))).statusCode).toBe(400);
      expect((await post(eventBody({ consent: "not_required" }))).statusCode).toBe(403);
      expect((await post(eventBody({ website_id: "another-site" }))).statusCode).toBe(403);
      expect((await post(eventBody(), { "content-type": "application/json" })).statusCode).toBe(401);
      expect(spy.statements.length).toBe(before);

      // Every statement: the event insert, on browser_events and nothing else.
      expect(spy.statements.length).toBe(5);
      for (const s of spy.statements) {
        expect(s.text).toBe(INSERT_BROWSER_EVENT_SQL);
        expect(tablesIn(s.text, tables)).toEqual(["browser_events"]);
      }
      expect(runnerCalls).toBe(0);
      expect(provider.calls).toBe(0);
      for (const t of COMPANY_SIDE) expect(await count(t), t).toBe(0);
      expect(await count("browser_events")).toBe(4);

      // Control: an entrance through the same server, pool and spy reaches the runner, the provider and the company side.
      spy.statements.length = 0;
      const entrance = await app.inject({
        method: "POST",
        url: "/v1/entrances",
        headers: auth,
        payload: JSON.stringify({
          contract: "entrance.v1",
          website_id: "site-test",
          ip: QUALIFIED_IP,
          entrance_id: `ent_iso_${randomBytes(8).toString("hex")}`,
          occurred_at: new Date().toISOString(),
          page_key: "/contact",
          acquisition: "direct",
          eligibility: "tsa-1",
        }),
      });
      expect(entrance.json()).toMatchObject({ status: "qualified", recorded: true });
      expect(runnerCalls).toBe(1);
      expect(provider.calls).toBe(1);
      expect(await count("company_observations")).toBe(1);
      const touched = new Set(spy.statements.flatMap((s) => tablesIn(s.text, tables)));
      expect([...touched]).toEqual(expect.arrayContaining(["ip_resolution_cache", "companies", "company_observations"]));
      expect(touched.has("browser_events")).toBe(false);
      // And the entrance wrote no browser event.
      expect(await count("browser_events")).toBe(4);
    } finally {
      await app.close();
      await real.shutdown(1_000);
    }
  });

  it("least privilege: the event route and event retention work under a role that can reach browser_events only, and that role cannot read the company side", async () => {
    const role = `idr_events_probe_${randomBytes(4).toString("hex")}`;
    await db.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // UPDATE only because the retention batch locks its rows with FOR UPDATE SKIP LOCKED, which PostgreSQL ties to that privilege.
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON browser_events TO ${role}`);
    await db.pool.query(`GRANT USAGE ON SEQUENCE browser_events_id_seq TO ${role}`);
    const restricted = new pg.Pool({ connectionString: getTestDatabaseUrl(), max: 4, application_name: "events-least-privilege" });
    restricted.on("connect", (c) => {
      void c.query(`SET ROLE ${role}`);
    });
    restricted.on("error", () => undefined);
    const logger = createMemoryLogger();
    const events = createEventRepository(restricted, logger);
    const app = await buildServer({
      config: testConfig({ EVENTS_ENABLED: "true" }),
      logger,
      runner: {
        activeCount: () => 0,
        capacity: () => 1,
        run: async () => {
          throw new Error("the event route must never call the runner");
        },
        shutdown: async () => ({ drained: true, activeJobs: 0, pendingWrites: 0 }),
      },
      ping: async () => true,
      events,
    });
    await app.ready();
    try {
      expect((await restricted.query<{ r: string }>("SELECT current_user::text AS r")).rows[0]!.r).toBe(role);
      for (const t of COMPANY_SIDE) {
        await expect(restricted.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toMatchObject({ code: "42501" });
      }
      const post = (body: unknown) => app.inject({ method: "POST", url: EVENTS_ROUTE, headers: auth, payload: JSON.stringify(body) });
      const b = eventBody();
      expect((await post(b)).json()).toEqual({ version: "1", recorded: true });
      expect((await post(b)).json()).toEqual({ version: "1", recorded: false });
      expect((await post(eventBody({ type: "engagement", name: "video_complete" }))).json()).toEqual({ version: "1", recorded: true });
      expect(logger.entries.filter((e) => e["event"] === "db_error")).toEqual([]);
      // Retention under the same role: old rows go, the feed side is never read or written.
      await db.pool.query("UPDATE browser_events SET received_at = now() - interval '40 days'");
      expect(await events.pruneBefore(new Date(Date.now() - 30 * 86_400_000), 10)).toBe(2);
      expect(await count("browser_events")).toBe(0);
      for (const t of COMPANY_SIDE) expect(await count(t), t).toBe(0);
      // The prune statement, too, names browser_events only.
      expect(tablesIn(PRUNE_BROWSER_EVENTS_SQL, tables)).toEqual(["browser_events"]);
    } finally {
      await app.close();
      await restricted.end();
      await db.pool.query(`DROP OWNED BY ${role}`);
      await db.pool.query(`DROP ROLE ${role}`);
    }
  });
});

describe("event modules: no matching code, no import of the resolution side (D4)", () => {
  const EVENT_MODULES = ["src/api/events.ts", "src/db/event-repo.ts", "src/contracts/event.ts"];
  const FORBIDDEN = [
    "src/runtime/runner.ts",
    "src/resolution/pipeline.ts",
    "src/resolution/qualify.ts",
    "src/provider/index.ts",
    "src/provider/enrich.ts",
    "src/provider/mock.ts",
    "src/ip/canonical.ts",
    "src/ip/fingerprint.ts",
    "src/db/index.ts",
    "src/db/cache-repo.ts",
    "src/db/company-repo.ts",
    "src/db/activity-repo.ts",
    "src/db/reporting-repo.ts",
    "src/db/usage-repo.ts",
    "src/db/controls-repo.ts",
    "src/db/retention.ts",
    "src/db/erasure.ts",
  ];

  /** Transitive relative imports (in src) of a module, as repository-relative paths. */
  function closure(start: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g)) {
        const target = relative(ROOT, resolve(dirname(join(ROOT, file)), m[1]!.replace(/\.js$/, ".ts")));
        visit(target);
      }
    };
    visit(start);
    return seen;
  }

  it.each(EVENT_MODULES)("%s imports nothing from the resolution side, even transitively", (file) => {
    const deps = closure(file);
    for (const f of FORBIDDEN) expect(deps.has(f), `${file} -> ${f}`).toBe(false);
  });

  it("the server reaches the event store only through the route module", () => {
    expect(closure("src/api/events.ts")).toEqual(new Set(["src/api/events.ts", "src/api/schema.ts", "src/contracts/api.ts", "src/contracts/event.ts", "src/log/index.ts"]));
  });

  it.each(EVENT_MODULES)("%s has no company, cache, fingerprint, provider or observation code (comments aside)", (file) => {
    const code = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/compan|fingerprint|hmac|provider|enrich|runner|pipeline|observation|ip_resolution|cache|canonicalise|lookup/i);
  });
});
