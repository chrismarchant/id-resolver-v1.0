/**
 * Source comparison counters (src/db/shadow-repo.ts) against PostgreSQL:
 * the daily quota reservation is atomic and never exceeds its limit under
 * concurrency, increments add up (repeats included) in one statement, the
 * report is per scope and date range, and nothing but listed metric names is
 * accepted or returned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { createShadowRepository } from "../../src/db/shadow-repo.js";
import type { ShadowScope } from "../../src/shadow/types.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { RESET_TABLE_NAMES } from "../helpers/db-lock-diagnostic.js";

const SCOPE: ShadowScope = { installationId: "inst-test", websiteId: "site-test", day: "2026-11-19" };

describe("shadow counters repository", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb({ max: 12 });
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const count = async (metric: string, day = SCOPE.day): Promise<number> => {
    const r = await db.pool.query<{ count: string }>("SELECT count::text FROM source_shadow_counts WHERE day = $1::date AND metric = $2", [day, metric]);
    return r.rows[0] ? Number(r.rows[0].count) : 0;
  };

  it("reserves up to the limit and no further; per source and per day", async () => {
    for (let i = 0; i < 3; i += 1) expect(await db.shadow.reserveSourceRequest(SCOPE, "ipapi", 3)).toBe(true);
    expect(await db.shadow.reserveSourceRequest(SCOPE, "ipapi", 3)).toBe(false);
    expect(await count("ipapi_requests")).toBe(3);
    expect(await db.shadow.reserveSourceRequest(SCOPE, "iplocate", 3)).toBe(true);
    expect(await db.shadow.reserveSourceRequest({ ...SCOPE, day: "2026-11-20" }, "ipapi", 3)).toBe(true);
    // A raised limit allows more the same day; a limit of 0 allows none and writes nothing.
    expect(await db.shadow.reserveSourceRequest(SCOPE, "ipapi", 4)).toBe(true);
    expect(await db.shadow.reserveSourceRequest({ ...SCOPE, day: "2026-11-21" }, "ipapi", 0)).toBe(false);
    expect(await count("ipapi_requests", "2026-11-21")).toBe(0);
  });

  it("concurrent reservations never exceed the limit", async () => {
    // The pool has 12 connections: the reservations race on separate sessions.
    const results = await Promise.all(Array.from({ length: 40 }, () => db.shadow.reserveSourceRequest(SCOPE, "ipapi", 17)));
    expect(results.filter(Boolean)).toHaveLength(17);
    expect(await count("ipapi_requests")).toBe(17);
    // Also from a first reservation of the day, when the row does not exist yet.
    const fresh = { ...SCOPE, day: "2026-11-22" };
    const first = await Promise.all(Array.from({ length: 20 }, () => db.shadow.reserveSourceRequest(fresh, "iplocate", 5)));
    expect(first.filter(Boolean)).toHaveLength(5);
    expect(await count("iplocate_requests", "2026-11-22")).toBe(5);
  });

  it("increments add up, repeats included, and concurrent increments lose nothing", async () => {
    await db.shadow.increment(SCOPE, ["observed", "ipapi_business", "observed", "waterfall_high"]);
    await db.shadow.increment(SCOPE, ["observed"]);
    await db.shadow.increment(SCOPE, []);
    expect(await count("observed")).toBe(3);
    expect(await count("ipapi_business")).toBe(1);
    await Promise.all(Array.from({ length: 25 }, () => db.shadow.increment(SCOPE, ["observed", "enrich_call_needed", "ipapi_none", "iplocate_none"])));
    expect(await count("observed")).toBe(28);
    expect(await count("enrich_call_needed")).toBe(25);
    // Counts in one statement (the runner's drop counters).
    await db.shadow.increment(SCOPE, { dropped_duplicate: 40, dropped_overload: 2 });
    await db.shadow.increment(SCOPE, { dropped_duplicate: 1 });
    expect(await count("dropped_duplicate")).toBe(41);
    expect(await count("dropped_overload")).toBe(2);
    await expect(db.shadow.increment(SCOPE, { dropped_duplicate: 0 })).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.shadow.increment(SCOPE, { dropped_duplicate: 1.5 })).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.shadow.increment(SCOPE, { ["example.com" as never]: 1 })).rejects.toMatchObject({ code: "INVALID_METRIC" });
  });

  it("refuses a metric outside the allowlist, a bad day or source before any statement", async () => {
    const statements: string[] = [];
    const spy = createShadowRepository({
      query: ((text: string) => {
        statements.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }) as never,
    });
    await expect(spy.increment(SCOPE, ["observed", "example.com" as never])).rejects.toMatchObject({ code: "INVALID_METRIC" });
    await expect(spy.increment({ ...SCOPE, day: "2026-13-01" }, ["observed"])).rejects.toMatchObject({ code: "INVALID_DAY" });
    await expect(spy.reserveSourceRequest(SCOPE, "enrich" as never, 5)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(spy.reserveSourceRequest(SCOPE, "ipapi", -1)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    await expect(spy.report("inst-test", "site-test", "2026-11-01", "not a day")).rejects.toMatchObject({ code: "INVALID_DAY" });
    expect(statements).toEqual([]);
    // Every statement touches source_shadow_counts and nothing else.
    await spy.increment(SCOPE, ["observed"]);
    await spy.reserveSourceRequest(SCOPE, "ipapi", 1);
    await spy.report("inst-test", "site-test", "2026-11-01", "2026-11-30");
    expect(statements).toHaveLength(3);
    for (const s of statements) {
      expect(s).toContain("source_shadow_counts");
      for (const other of RESET_TABLE_NAMES.filter((t) => t !== "source_shadow_counts")) expect(s).not.toMatch(new RegExp(`\\b${other}\\b`));
    }
  });

  it("reports days in range for the scope only, in date order, with listed metrics only", async () => {
    await db.shadow.increment(SCOPE, ["observed", "waterfall_medium"]);
    await db.shadow.increment({ ...SCOPE, day: "2026-11-17" }, ["observed", "observed", "dropped_duplicate"]);
    await db.shadow.reserveSourceRequest({ ...SCOPE, day: "2026-11-17" }, "ipapi", 10);
    await db.shadow.increment({ ...SCOPE, day: "2026-11-25" }, ["observed"]);
    await db.shadow.increment({ ...SCOPE, websiteId: "other-site" }, ["observed"]);
    // A row the code does not know (the table accepts any token): never returned.
    await db.pool.query("INSERT INTO source_shadow_counts (installation_id, website_id, day, metric, count) VALUES ('inst-test', 'site-test', '2026-11-19', 'legacy_metric', 9)");
    expect(await db.shadow.report("inst-test", "site-test", "2026-11-17", "2026-11-24")).toEqual([
      { date: "2026-11-17", metrics: { dropped_duplicate: 1, ipapi_requests: 1, observed: 2 } },
      { date: "2026-11-19", metrics: { observed: 1, waterfall_medium: 1 } },
    ]);
    expect(await db.shadow.report("inst-test", "site-test", "2026-12-01", "2026-12-31")).toEqual([]);
    expect(await db.shadow.report("inst-test", "other-site", "2026-11-19", "2026-11-19")).toEqual([{ date: "2026-11-19", metrics: { observed: 1 } }]);
  });
});
