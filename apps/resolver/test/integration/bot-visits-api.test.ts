/**
 * POST /v1/bot-visits and GET /v1/reporting/bot-visits (contract
 * bot-visit.v1) through the real server wiring and real PostgreSQL: the write
 * route exists unless BOT_VISITS_ENABLED=false, accepts the website credential
 * only, validates strictly (no IP, user agent or any other extra field), stores
 * each visit_id once, never reaches the runner or any company table, has its
 * own rate-limit bucket and write slots, and never logs the visit's values. The
 * reporting route accepts the reporting credential only and pages by
 * (observed_at, id) within one date range.
 *
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BOT_VISIT_WRITES_MAX_IN_FLIGHT, BOT_VISITS_ROUTE } from "../../src/api/bot-visits.js";
import { BOT_VISITS_REPORTING_ROUTE } from "../../src/api/reporting.js";
import { buildServer } from "../../src/api/server.js";
import type { BotVisitRecord, BotVisitRepository } from "../../src/contracts/bot-visit.js";
import type { JobRequest, Runner } from "../../src/contracts/runtime.js";
import { INSERT_BOT_VISIT_SQL, LIST_BOT_VISITS_AFTER_SQL, LIST_BOT_VISITS_SQL, PRUNE_BOT_VISITS_SQL } from "../../src/db/bot-visit-repo.js";
import type { Db } from "../../src/db/index.js";
import { DbError } from "../../src/db/pool.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const REPORTING_TOKEN = ["test", "bots", "reporting", "token", "0123456789abcdef0123456789abcdef"].join("-");
const json = { "content-type": "application/json" };
const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, ...json };
const reportingAuth = { authorization: `Bearer ${REPORTING_TOKEN}` };
const NOT_FOUND = { version: "1", error: "not_found" };
const UNAUTHORIZED = { version: "1", error: "unauthorized" };
const INVALID = { version: "1", error: "invalid_request" };

let seq = 0;
const visitId = () => `bot_api_${String(++seq).padStart(12, "0")}`;

function visit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "bot-visit.v1",
    website_id: "site-test",
    visit_id: visitId(),
    occurred_at: new Date(NOW).toISOString(),
    page_key: "/pricing",
    bot_name: "GPTBot",
    bot_category: "ai_crawler",
    user_agent_family: "GPTBot",
    ...over,
  };
}

/** A runner that must never be called by the bot visit route. */
function countingRunner(): Runner & { jobs: JobRequest[] } {
  const jobs: JobRequest[] = [];
  return {
    jobs,
    activeCount: () => 0,
    capacity: () => 4,
    async run(job) {
      jobs.push(job);
      return { status: "no_match", source: "cache" };
    },
    async shutdown() {
      return { drained: true, activeJobs: 0, pendingWrites: 0 };
    },
  };
}

describe("bot-visit.v1", () => {
  let db: Db;
  let logger: ReturnType<typeof createMemoryLogger>;
  let runner: ReturnType<typeof countingRunner>;
  let app: FastifyInstance;

  const build = async (over: Record<string, string> = {}, botVisits: BotVisitRepository | null = db.botVisits) => {
    const s = await buildServer({
      config: testConfig({ AUTH_FAILURE_LIMIT_PER_MINUTE: "100000", REPORTING_AUTH_TOKEN: REPORTING_TOKEN, ...over }),
      logger,
      runner,
      ping: async () => true,
      now: () => NOW,
      reporting: db.reporting,
      ...(botVisits ? { botVisits } : {}),
    });
    await s.ready();
    return s;
  };
  const post = (payload: unknown, headers: Record<string, string> = auth, target: FastifyInstance = app) =>
    target.inject({ method: "POST", url: BOT_VISITS_ROUTE, headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const rows = async () =>
    (
      await db.pool.query<Record<string, unknown>>(
        "SELECT installation_id, website_id, visit_id, observed_at, page_key, bot_name, bot_category, user_agent_family FROM bot_visits ORDER BY id",
      )
    ).rows;
  const count = async (table: string) => (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
    logger = createMemoryLogger();
    runner = countingRunner();
    app = await build();
  });
  beforeEach(async () => {
    await resetTestDb(db);
    runner.jobs.length = 0;
  });
  afterAll(async () => {
    await resetTestDb(db);
    await app.close();
    await db.close();
  });

  describe("POST /v1/bot-visits", () => {
    it("is on by default; BOT_VISITS_ENABLED=false removes it (404 like any unknown route, 401 without the credential)", async () => {
      expect(testConfig().BOT_VISITS_ENABLED).toBe(true);
      const off = await build({ BOT_VISITS_ENABLED: "false" });
      try {
        const r = await post(visit(), auth, off);
        expect(r.statusCode).toBe(404);
        expect(r.json()).toEqual(NOT_FOUND);
        const noAuth = await post(visit(), json, off);
        expect(noAuth.statusCode).toBe(401);
      } finally {
        await off.close();
      }
      expect(await count("bot_visits")).toBe(0);
    });

    it("stores one row with exactly the reported values; a repeat of the visit_id is acknowledged and not stored again", async () => {
      const body = visit({ page_key: "/blog/:slug", bot_name: "Googlebot", bot_category: "search_engine", user_agent_family: "Googlebot-Image" });
      const first = await post(body);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ version: "1", recorded: true });
      const again = await post(body);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ version: "1", recorded: false });
      expect(await rows()).toEqual([
        {
          installation_id: "inst-test",
          website_id: "site-test",
          visit_id: body["visit_id"],
          observed_at: new Date(NOW),
          page_key: "/blog/:slug",
          bot_name: "Googlebot",
          bot_category: "search_engine",
          user_agent_family: "Googlebot-Image",
        },
      ]);
    });

    it.each([
      ["ai_search", "OAI-SearchBot"],
      ["ai_assistant", "ChatGPT-User"],
      ["ai_crawler", "GPTBot"],
    ])("accepts and stores the AI category %s (0014)", async (category, name) => {
      const r = await post(visit({ bot_name: name, bot_category: category, user_agent_family: name }));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ version: "1", recorded: true });
      expect((await rows()).map((x) => [x["bot_name"], x["bot_category"]])).toEqual([[name, category]]);
    });

    it("never reaches the runner, the cache, the usage counters or any company table", async () => {
      expect((await post(visit())).statusCode).toBe(200);
      expect(runner.jobs).toEqual([]);
      for (const t of ["ip_resolution_cache", "usage_periods", "companies", "company_observations", "company_observation_refs", "company_scope_stats", "browser_events"]) {
        expect(await count(t)).toBe(0);
      }
    });

    it("accepts the website credential only: none or the reporting token is 401", async () => {
      expect((await post(visit(), json)).json()).toEqual(UNAUTHORIZED);
      expect((await post(visit(), { ...reportingAuth, ...json })).statusCode).toBe(401);
      expect(await count("bot_visits")).toBe(0);
    });

    it.each([
      ["an IP field", { ip: "192.0.2.10" }],
      ["a full user agent", { user_agent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" }],
      ["a cookie", { cookie: "a=b" }],
      ["an unknown category", { bot_category: "scraper" }],
      ["a URL as bot_name", { bot_name: "https://example.com/bot" }],
      ["a versioned user_agent_family", { user_agent_family: "GPTBot/1.2" }],
      ["a family with spaces", { user_agent_family: "Generic crawler" }],
      ["a page_key with a query string", { page_key: "/pricing?utm_source=x" }],
      ["a page_key that is not a path", { page_key: "https://example.com/pricing" }],
      ["a short visit_id", { visit_id: "short" }],
      ["another contract", { contract: "event.v1" }],
      ["an occurred_at outside the 300 s window", { occurred_at: new Date(NOW - 301_000).toISOString() }],
    ])("refuses %s with 400 and stores nothing", async (_label, over) => {
      const r = await post(visit(over));
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual(INVALID);
      expect(await count("bot_visits")).toBe(0);
    });

    it("refuses another website_id with 403", async () => {
      const r = await post(visit({ website_id: "other-site" }));
      expect(r.statusCode).toBe(403);
      expect(await count("bot_visits")).toBe(0);
    });

    it("has its own rate-limit bucket: exhausting it never blocks entrances", async () => {
      const limited = await build({ RATE_LIMIT_PER_MINUTE: "3" });
      try {
        for (let i = 0; i < 3; i++) expect((await post(visit(), auth, limited)).statusCode).toBe(200);
        expect((await post(visit(), auth, limited)).statusCode).toBe(429);
        const entrance = await limited.inject({
          method: "POST",
          url: "/v1/entrances",
          headers: auth,
          payload: JSON.stringify({
            contract: "entrance.v1",
            website_id: "site-test",
            ip: "192.0.2.10",
            entrance_id: "ent_bot_bucket_000000001",
            occurred_at: new Date(NOW).toISOString(),
            page_key: "/",
            acquisition: "direct",
            eligibility: "tsa-1",
          }),
        });
        expect(entrance.statusCode).toBe(200);
      } finally {
        await limited.close();
      }
    });

    it(`allows ${BOT_VISIT_WRITES_MAX_IN_FLIGHT} writes in flight; one more is refused 503 overloaded`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow: BotVisitRepository = {
        async record() {
          await gate;
          return true;
        },
        list: async () => [],
        pruneBefore: async () => 0,
      };
      const s = await build({}, slow);
      try {
        const pending = Array.from({ length: BOT_VISIT_WRITES_MAX_IN_FLIGHT }, () => post(visit(), auth, s));
        await new Promise((r) => setTimeout(r, 50));
        const extra = await post(visit(), auth, s);
        expect(extra.statusCode).toBe(503);
        expect(extra.json()).toEqual({ version: "1", error: "overloaded" });
        release();
        for (const r of await Promise.all(pending)) expect(r.statusCode).toBe(200);
      } finally {
        await s.close();
      }
    });

    it("answers 503 not_ready on a database failure", async () => {
      const failing: BotVisitRepository = {
        async record(_v: BotVisitRecord) {
          throw new DbError("57P01");
        },
        list: async () => [],
        pruneBefore: async () => 0,
      };
      const s = await build({}, failing);
      try {
        const r = await post(visit(), auth, s);
        expect(r.statusCode).toBe(503);
        expect(r.json()).toEqual({ version: "1", error: "not_ready" });
      } finally {
        await s.close();
      }
    });

    it("never logs the visit_id, page_key, bot name or user agent family", async () => {
      const marker = visit({ page_key: "/secret-path-marker", bot_name: "MarkerBotName", user_agent_family: "MarkerFamily", bot_category: "other" });
      expect((await post(marker)).statusCode).toBe(200);
      expect((await post({ ...marker, extra: "x" })).statusCode).toBe(400);
      const text = JSON.stringify(logger.entries);
      for (const v of [marker["visit_id"], "/secret-path-marker", "MarkerBotName", "MarkerFamily"]) expect(text).not.toContain(String(v));
    });
  });

  describe("GET /v1/reporting/bot-visits", () => {
    const get = (query: string, headers: Record<string, string> = reportingAuth) => app.inject({ method: "GET", url: `${BOT_VISITS_REPORTING_ROUTE}?${query}`, headers });
    const seed = async (observedAt: string[]) => {
      for (const [i, t] of observedAt.entries()) {
        await db.botVisits.record({
          installationId: "inst-test",
          websiteId: "site-test",
          visitId: `seed_visit_${String(i).padStart(10, "0")}`,
          observedAt: new Date(t),
          pageKey: `/p${i}`,
          botName: "ClaudeBot",
          botCategory: "ai_crawler",
          userAgentFamily: "ClaudeBot",
        });
      }
    };

    it("returns the visits of the inclusive UTC date range, in (observed_at, id) order, with exactly the five reporting columns", async () => {
      await seed(["2026-11-08T23:59:59.999Z", "2026-11-09T00:00:00.000Z", "2026-11-09T12:00:00.000Z", "2026-11-09T23:59:59.999Z", "2026-11-10T00:00:00.000Z"]);
      const r = await get("from=2026-11-09&to=2026-11-09");
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.scope).toEqual({ installation_id: "inst-test", website_id: "site-test" });
      expect(body.next_cursor).toBeNull();
      expect(body.items).toEqual([
        { observed_at: "2026-11-09T00:00:00.000Z", page_key: "/p1", bot_name: "ClaudeBot", bot_category: "ai_crawler", user_agent_family: "ClaudeBot" },
        { observed_at: "2026-11-09T12:00:00.000Z", page_key: "/p2", bot_name: "ClaudeBot", bot_category: "ai_crawler", user_agent_family: "ClaudeBot" },
        { observed_at: "2026-11-09T23:59:59.999Z", page_key: "/p3", bot_name: "ClaudeBot", bot_category: "ai_crawler", user_agent_family: "ClaudeBot" },
      ]);
    });

    it("pages with a cursor until next_cursor is null, without gaps or repeats, also across equal timestamps", async () => {
      const same = "2026-11-09T10:00:00.000Z";
      await seed([same, same, same, "2026-11-09T11:00:00.000Z", "2026-11-09T12:00:00.000Z"]);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await get(`from=2026-11-09&to=2026-11-09&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(r.statusCode).toBe(200);
        const body = r.json();
        seen.push(...body.items.map((i: { page_key: string }) => i.page_key));
        cursor = body.next_cursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(seen).toEqual(["/p0", "/p1", "/p2", "/p3", "/p4"]);
      expect(pages).toBe(3);
    });

    it("accepts the reporting credential only, and refuses a range over 31 days, a reversed range and a malformed cursor", async () => {
      expect((await get("from=2026-11-09&to=2026-11-09", { authorization: `Bearer ${TEST_AUTH_TOKEN}` })).statusCode).toBe(401);
      expect((await get("from=2026-10-01&to=2026-11-01")).statusCode).toBe(400);
      expect((await get("from=2026-10-10&to=2026-11-09")).statusCode).toBe(200);
      expect((await get("from=2026-11-09&to=2026-11-08")).statusCode).toBe(400);
      expect((await get("from=2026-11-09&to=2026-11-09&cursor=bm90LWpzb24")).statusCode).toBe(400);
      expect((await get("from=2026-11-09&to=2026-11-09&limit=1001")).statusCode).toBe(400);
    });
  });

  describe("repository", () => {
    it("issues statements on bot_visits only", () => {
      for (const sql of [INSERT_BOT_VISIT_SQL, LIST_BOT_VISITS_SQL, LIST_BOT_VISITS_AFTER_SQL, PRUNE_BOT_VISITS_SQL]) {
        // "FOR UPDATE SKIP LOCKED" is a lock clause, not a table reference.
        const tables = [...sql.matchAll(/\b(?:FROM|INTO|(?<!FOR\s)UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]);
        expect(tables.length).toBeGreaterThan(0);
        for (const t of tables) expect(t).toBe("bot_visits");
      }
    });

    it("prunes by the resolver's received_at, oldest first, in bounded batches", async () => {
      for (let i = 0; i < 5; i++) {
        await db.botVisits.record({ installationId: "inst-test", websiteId: "site-test", visitId: `prune_visit_${String(i).padStart(10, "0")}`, observedAt: new Date(NOW), pageKey: "/", botName: "Bingbot", botCategory: "search_engine", userAgentFamily: "bingbot" });
      }
      await db.pool.query("UPDATE bot_visits SET received_at = now() - interval '40 days' WHERE id <= 3");
      const cutoff = new Date(Date.now() - 30 * 86_400_000);
      expect(await db.botVisits.pruneBefore(cutoff, 2)).toBe(2);
      expect(await db.botVisits.pruneBefore(cutoff, 2)).toBe(1);
      expect(await db.botVisits.pruneBefore(cutoff, 2)).toBe(0);
      expect(await count("bot_visits")).toBe(2);
    });

    it("the table refuses values outside the contract even if a route bug passed them", async () => {
      const insert = (over: Record<string, unknown>) => {
        const v = { installation_id: "inst-test", website_id: "site-test", visit_id: visitId(), observed_at: new Date(NOW), page_key: "/", bot_name: "GPTBot", bot_category: "ai_crawler", user_agent_family: "GPTBot", ...over };
        const keys = Object.keys(v);
        return db.pool.query(`INSERT INTO bot_visits (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v));
      };
      await expect(insert({})).resolves.toBeDefined();
      await expect(insert({ bot_category: "ai_search" })).resolves.toBeDefined();
      await expect(insert({ bot_category: "ai_assistant" })).resolves.toBeDefined();
      for (const over of [{ bot_category: "scraper" }, { page_key: "/a?b=c" }, { bot_name: "a/b" }, { user_agent_family: "GPTBot/1.2" }, { visit_id: "x" }]) {
        await expect(insert(over)).rejects.toThrow();
      }
    });
  });

  describe("isolation", () => {
    const ROOT = join(import.meta.dirname, "..", "..");
    const closure = (start: string): Set<string> => {
      const seen = new Set<string>();
      const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(join(ROOT, file), "utf8");
        for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g)) visit(relative(ROOT, resolve(dirname(join(ROOT, file)), m[1]!.replace(/\.js$/, ".ts"))));
      };
      visit(start);
      return seen;
    };

    it("the route module reaches only its schema, the contracts and the logger: no runner, pipeline, provider, cache or company code", () => {
      expect(closure("src/api/bot-visits.ts")).toEqual(new Set(["src/api/bot-visits.ts", "src/api/bot-visit-schema.ts", "src/contracts/api.ts", "src/contracts/bot-visit.ts", "src/log/index.ts"]));
      expect(closure("src/db/bot-visit-repo.ts")).toEqual(new Set(["src/db/bot-visit-repo.ts", "src/contracts/bot-visit.ts", "src/contracts/api.ts", "src/log/index.ts", "src/db/pool.ts", "src/db/tls.ts"]));
    });

    it.each(["src/api/bot-visits.ts", "src/api/bot-visit-schema.ts", "src/db/bot-visit-repo.ts", "src/contracts/bot-visit.ts"])("%s has no company, cache, fingerprint, provider or observation code (comments aside)", (file) => {
      const code = readFileSync(join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).not.toMatch(/compan|fingerprint|hmac|provider|enrich|runner|pipeline|observation|ip_resolution|canonicalise|lookup/i);
    });
  });
});
