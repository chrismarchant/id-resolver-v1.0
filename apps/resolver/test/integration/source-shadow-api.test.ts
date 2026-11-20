/**
 * GET /v1/reporting/source-shadow (contract source-shadow.v1) over the real
 * counter repository and PostgreSQL: the reporting credential only, the same
 * date validation as /v1/reporting/activity with at most 31 days, scope from
 * configuration, sparse days, and served whether or not
 * SHADOW_SOURCES_MODE is on.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { JobRequest, ResolutionOutcome, Runner } from "../../src/contracts/runtime.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const REPORTING_TOKEN = "test-reporting-token-fedcba9876543210fedcba9876543210";
const ROUTE = "/v1/reporting/source-shadow";

function fakeRunner(): Runner {
  return {
    activeCount: () => 0,
    capacity: () => 4,
    async run(_job: JobRequest): Promise<ResolutionOutcome> {
      return { status: "no_match", source: "provider" };
    },
    async shutdown() {
      return { drained: true, activeJobs: 0, pendingWrites: 0 };
    },
  };
}

describe("GET /v1/reporting/source-shadow", () => {
  let db: Db;
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;
  const auth = { authorization: `Bearer ${REPORTING_TOKEN}` };

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    logger = createMemoryLogger();
    // SHADOW_SOURCES_MODE is off (the default): the route still answers.
    const config = testConfig({ REPORTING_AUTH_TOKEN: REPORTING_TOKEN });
    expect(config.SHADOW_SOURCES_MODE).toBe("off");
    app = await buildServer({ config, logger, runner: fakeRunner(), ping: () => db.ping(), reporting: db.reporting, sourceShadow: db.shadow });
    await app.ready();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const get = (q: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url: `${ROUTE}?${q}`, headers });

  it("accepts only the reporting credential", async () => {
    for (const headers of [{ authorization: `Bearer ${TEST_AUTH_TOKEN}` }, {}, { authorization: "Bearer nope" }]) {
      const r = await get("from=2026-11-01&to=2026-11-02", headers);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ version: "1", error: "unauthorized" });
    }
  });

  it("answers empty days while nothing was measured", async () => {
    const r = await get("from=2026-11-01&to=2026-11-30");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: "1", scope: { installation_id: "inst-test", website_id: "site-test" }, from: "2026-11-01", to: "2026-11-30", days: [] });
  });

  it("returns the scope's days in the range, in date order, sparse, counts only", async () => {
    const scope = { installationId: "inst-test", websiteId: "site-test" };
    await db.shadow.increment({ ...scope, day: "2026-11-19" }, ["observed", "observed", "ipapi_business", "waterfall_medium", "enrich_call_avoidable"]);
    await db.shadow.reserveSourceRequest({ ...scope, day: "2026-11-19" }, "ipapi", 900);
    await db.shadow.increment({ ...scope, day: "2026-11-17" }, ["dropped_overload"]);
    await db.shadow.increment({ ...scope, day: "2026-10-31" }, ["observed"]);
    await db.shadow.increment({ ...scope, websiteId: "other-site", day: "2026-11-19" }, ["observed"]);
    const r = await get("from=2026-11-01&to=2026-11-30");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      version: "1",
      scope: { installation_id: "inst-test", website_id: "site-test" },
      from: "2026-11-01",
      to: "2026-11-30",
      days: [
        { date: "2026-11-17", metrics: { dropped_overload: 1 } },
        { date: "2026-11-19", metrics: { enrich_call_avoidable: 1, ipapi_business: 1, ipapi_requests: 1, observed: 2, waterfall_medium: 1 } },
      ],
    });
    expect(logger.entries.some((e) => e["event"] === "request_completed" && e["route"] === ROUTE && e["count"] === 2)).toBe(true);
  });

  it("validates the range like /v1/reporting/activity, at most 31 days", async () => {
    expect((await get("from=2026-11-01&to=2026-12-01")).statusCode).toBe(200);
    for (const q of [
      "from=2026-11-01&to=2026-12-02",
      "from=2026-11-02&to=2026-11-01",
      "from=2026-02-30&to=2026-03-01",
      "from=2026-11-01",
      "to=2026-11-01",
      "from=2026-11-01&to=2026-11-02&metric=observed",
      "from=20261101&to=20261102",
    ]) {
      const r = await get(q);
      expect(r.statusCode, q).toBe(400);
      expect(r.json()).toEqual({ version: "1", error: "invalid_request" });
    }
  });

  it("does not exist without a counter store (an unknown route, like any other)", async () => {
    const bare = await buildServer({ config: testConfig({ REPORTING_AUTH_TOKEN: REPORTING_TOKEN }), logger: createMemoryLogger(), runner: fakeRunner(), ping: () => db.ping(), reporting: db.reporting });
    await bare.ready();
    try {
      // Unknown routes authenticate with the website credential and answer 404 (src/api/server.ts).
      const r = await bare.inject({ method: "GET", url: `${ROUTE}?from=2026-11-01&to=2026-11-02`, headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` } });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ version: "1", error: "not_found" });
    } finally {
      await bare.close();
    }
  });

  it("answers 500 without detail when the database fails", async () => {
    const failing = await buildServer({
      config: testConfig({ REPORTING_AUTH_TOKEN: REPORTING_TOKEN }),
      logger: createMemoryLogger(),
      runner: fakeRunner(),
      ping: () => db.ping(),
      reporting: db.reporting,
      sourceShadow: { report: () => Promise.reject(new Error("relation source_shadow_counts does not exist")) },
    });
    await failing.ready();
    try {
      const r = await failing.inject({ method: "GET", url: `${ROUTE}?from=2026-11-01&to=2026-11-02`, headers: auth });
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ version: "1", error: "internal" });
    } finally {
      await failing.close();
    }
  });
});
