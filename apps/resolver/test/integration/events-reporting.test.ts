/**
 * GET /v1/reporting/events (browser events, event.v1) through the real server
 * wiring and real PostgreSQL: reporting credential only, one inclusive UTC date
 * range of at most 31 days, keyset pages on (occurred_at, id), exactly the five
 * reporting columns, and statements on browser_events only (owner decision D4).
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EVENTS_REPORTING_ROUTE } from "../../src/api/reporting.js";
import { buildServer } from "../../src/api/server.js";
import type { JobRequest, Runner } from "../../src/contracts/runtime.js";
import { LIST_BROWSER_EVENTS_AFTER_SQL, LIST_BROWSER_EVENTS_SQL } from "../../src/db/event-repo.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const REPORTING_TOKEN = ["test", "events", "report", "token", "0123456789abcdef0123456789abcdef"].join("-");
const reportingAuth = { authorization: `Bearer ${REPORTING_TOKEN}` };

function idleRunner(): Runner & { jobs: JobRequest[] } {
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

describe("GET /v1/reporting/events", () => {
  let db: Db;
  let app: FastifyInstance;
  const get = (query: string, headers: Record<string, string> = reportingAuth) => app.inject({ method: "GET", url: `${EVENTS_REPORTING_ROUTE}?${query}`, headers });
  const seed = async (occurredAt: string[], name = "page_view", type = "page_view") => {
    for (const [i, t] of occurredAt.entries()) {
      await db.events.record({
        installationId: "inst-test",
        websiteId: "site-test",
        eventId: `seed_event_${name}_${String(i).padStart(8, "0")}`,
        type,
        name,
        pageKey: `/p${i}`,
        consent: "granted",
        occurredAt: new Date(t),
      });
    }
  };

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    app = await buildServer({
      config: testConfig({ AUTH_FAILURE_LIMIT_PER_MINUTE: "100000", REPORTING_AUTH_TOKEN: REPORTING_TOKEN }),
      logger: createMemoryLogger(),
      runner: idleRunner(),
      ping: async () => true,
      now: () => NOW,
      reporting: db.reporting,
      events: db.events,
    });
    await app.ready();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });
  afterAll(async () => {
    await resetTestDb(db);
    await app.close();
    await db.close();
  });

  it("is served whatever EVENTS_ENABLED says (it only reads), and returns the day's events with exactly the five reporting columns", async () => {
    expect(testConfig().EVENTS_ENABLED).toBe(false);
    await seed(["2026-11-08T23:59:59.999Z", "2026-11-09T00:00:00.000Z", "2026-11-09T12:00:00.000Z", "2026-11-10T00:00:00.000Z"]);
    const r = await get("from=2026-11-09&to=2026-11-09");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.scope).toEqual({ installation_id: "inst-test", website_id: "site-test" });
    expect(body.next_cursor).toBeNull();
    expect(body.items).toEqual([
      { occurred_at: "2026-11-09T00:00:00.000Z", page_key: "/p1", type: "page_view", name: "page_view", consent: "granted" },
      { occurred_at: "2026-11-09T12:00:00.000Z", page_key: "/p2", type: "page_view", name: "page_view", consent: "granted" },
    ]);
  });

  it("pages with a cursor until next_cursor is null, without gaps or repeats, also across equal timestamps", async () => {
    const same = "2026-11-09T10:00:00.000Z";
    await seed([same, same, same, "2026-11-09T11:00:00.000Z", "2026-11-09T12:00:00.000Z"], "cta_click", "conversion_intent");
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

  it("accepts the reporting credential only, and refuses a range over 31 days, a reversed range, a foreign cursor and a page over 1000", async () => {
    expect((await get("from=2026-11-09&to=2026-11-09", { authorization: `Bearer ${TEST_AUTH_TOKEN}` })).statusCode).toBe(401);
    expect((await get("from=2026-10-01&to=2026-11-01")).statusCode).toBe(400);
    expect((await get("from=2026-10-10&to=2026-11-09")).statusCode).toBe(200);
    expect((await get("from=2026-11-09&to=2026-11-08")).statusCode).toBe(400);
    // A bot-visits cursor ({t, v}) is not an events cursor ({t, e}).
    const botCursor = Buffer.from(JSON.stringify({ t: Date.parse("2026-11-09T10:00:00Z"), v: 3 })).toString("base64url");
    expect((await get(`from=2026-11-09&to=2026-11-09&cursor=${botCursor}`)).statusCode).toBe(400);
    expect((await get("from=2026-11-09&to=2026-11-09&limit=1001")).statusCode).toBe(400);
  });

  it("reads browser_events only (D4: no join to any company-side table)", () => {
    for (const sql of [LIST_BROWSER_EVENTS_SQL, LIST_BROWSER_EVENTS_AFTER_SQL]) {
      const tables = [...sql.matchAll(/\b(?:FROM|INTO|(?<!FOR\s)UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]);
      expect(tables).toEqual(["browser_events"]);
    }
  });
});
