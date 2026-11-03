/**
 * CHR-66 F1: the maintenance run DRAINS expired cache rows and observations
 * past retention in bounded batches until a short batch, within its time
 * budget, instead of deleting one batch per interval (which let the D3 buffer
 * and expired fingerprints grow without limit under sustained load).
 *
 * Real PostgreSQL; synthetic data only (sha256 fingerprints of labels,
 * example.* domains, no IPs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { createFeedRetention, type FeedRetention } from "../../src/db/retention.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createMaintenance, type MaintenanceOptions } from "../../src/runtime/maintenance.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { createCompany, FEED_SCOPE } from "../helpers/feed.js";

const DAY = 86_400_000;
const RETENTION_DAYS = 30;
const BATCH = 10;

describe("maintenance run (CHR-66 F1)", () => {
  let db: Db;
  let retention: FeedRetention;
  let logger: ReturnType<typeof createMemoryLogger>;

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    retention = createFeedRetention(db.pool);
  });
  beforeEach(async () => {
    await resetTestDb(db);
    logger = createMemoryLogger();
  });
  afterAll(async () => {
    await resetTestDb(db);
    await db.close();
  });

  /** `expired` cache rows past expires_at and `fresh` ones still live; fingerprints are sha256 of synthetic labels. */
  async function seedCache(expired: number, fresh: number): Promise<void> {
    await db.pool.query(
      `INSERT INTO ip_resolution_cache (installation_id, website_id, key_version, ip_fingerprint, status, checked_at, expires_at)
       SELECT 'inst-test', 'site-test', 1, sha256(convert_to('maintenance-' || g, 'UTF8')), 'no_match',
              now() - interval '2 days', CASE WHEN g <= $1::int THEN now() - interval '1 hour' ELSE now() + interval '1 day' END
       FROM generate_series(1, $1::int + $2::int) g`,
      [expired, fresh],
    );
  }

  /** `old` observations older than the retention window and `fresh` ones inside it. */
  async function seedObservations(old: number, fresh: number): Promise<void> {
    const company = await createCompany(db.pool, "maintenance.example");
    await db.pool.query(
      `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source)
       SELECT $1::text, $2::text, $3::bigint,
              CASE WHEN g <= $4::int THEN now() - interval '40 days' - make_interval(secs => g) ELSE now() - make_interval(secs => g) END,
              'maint-' || lpad(g::text, 16, '0'), 'cache'
       FROM generate_series(1, $4::int + $5::int) g`,
      [FEED_SCOPE.installationId, FEED_SCOPE.websiteId, company, old, fresh],
    );
  }

  const count = async (table: "ip_resolution_cache" | "company_observations") =>
    (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  function maintenance(over: Partial<MaintenanceOptions> = {}) {
    return createMaintenance({
      pruneExpiredCache: (limit) => db.cache.pruneExpired(limit),
      retention,
      logger,
      batch: BATCH,
      retentionDays: RETENTION_DAYS,
      budgetMs: 20_000,
      ...over,
    });
  }

  const events = (name: string) => logger.entries.filter((e) => e["event"] === name);

  it("one run deletes every due row across many batches (cache and observations), leaves fresh rows, advances the watermark and logs maintenance_run", async () => {
    await seedCache(57, 4);
    await seedObservations(43, 5);
    const run = await maintenance().runOnce();
    // The pre-fix loop deleted at most one batch (10) of each per interval.
    expect(run).toMatchObject({ cacheRows: 57, observationRows: 43, backlog: false, reason: null });
    expect(await count("ip_resolution_cache")).toBe(4);
    expect(await count("company_observations")).toBe(5);
    expect(await retention.watermark(FEED_SCOPE)).not.toBeNull();
    expect(events("maintenance_run")).toEqual([
      expect.objectContaining({ level: "info", cache_rows: 57, observation_rows: 43, backlog: false, outcome: "completed" }),
    ]);
    expect(events("maintenance_backlog")).toEqual([]);
    // Nothing else is touched: no tombstone, the company stays.
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM companies")).rowCount).toBe(1);
  });

  it("an exhausted budget stops between batches, reports the backlog and warns; later runs finish the drain", async () => {
    await seedCache(200, 3);
    await seedObservations(200, 3);
    // A clock that advances 100 ms on every read: a 1 s budget allows a few batches of each kind.
    let t = Date.now();
    const m = maintenance({ budgetMs: 1_000, now: () => (t += 100) });
    const first = await m.runOnce();
    expect(first).toMatchObject({ backlog: true, reason: "budget_exhausted" });
    // More than one batch of each, but not all: the budget, not the batch size, bounded the run.
    expect(first!.cacheRows).toBeGreaterThan(BATCH);
    expect(first!.cacheRows).toBeLessThan(200);
    expect(first!.observationRows).toBeGreaterThan(BATCH);
    expect(first!.observationRows).toBeLessThan(200);
    expect(events("maintenance_backlog")).toEqual([
      expect.objectContaining({ level: "warn", reason: "budget_exhausted", category: "cache_and_observations", backlog: true }),
    ]);
    expect(events("maintenance_run")[0]).toMatchObject({ backlog: true, cache_rows: first!.cacheRows, observation_rows: first!.observationRows });

    let runs = 1;
    let last = first;
    while (last!.backlog && runs < 20) {
      last = await m.runOnce();
      runs += 1;
    }
    expect(last).toMatchObject({ backlog: false, reason: null });
    expect(runs).toBeGreaterThan(1);
    expect(await count("ip_resolution_cache")).toBe(3);
    expect(await count("company_observations")).toBe(3);
  });

  it("observation retention still runs when the cache prune fails; the failure is reported as a backlog", async () => {
    await seedObservations(25, 2);
    const run = await maintenance({
      pruneExpiredCache: async () => {
        throw new Error("injected failure");
      },
    }).runOnce();
    expect(run).toMatchObject({ cacheRows: 0, observationRows: 25, backlog: true, reason: "database_error" });
    expect(await count("company_observations")).toBe(2);
    expect(events("maintenance_run")[0]).toMatchObject({ outcome: "partial_failure" });
    expect(events("maintenance_backlog")[0]).toMatchObject({ reason: "database_error", category: "cache" });
  });

  it("observations exactly inside the window are kept; the cutoff is OBSERVATION_RETENTION_DAYS before the run", async () => {
    const company = await createCompany(db.pool, "window.example");
    const now = Date.now();
    await db.pool.query(
      `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source)
       VALUES ($1, $2, $3, $4, 'window-ref-inside-00', 'cache'), ($1, $2, $3, $5, 'window-ref-outside-0', 'cache')`,
      [FEED_SCOPE.installationId, FEED_SCOPE.websiteId, company, new Date(now - RETENTION_DAYS * DAY + 60_000), new Date(now - RETENTION_DAYS * DAY - 60_000)],
    );
    const run = await maintenance({ now: () => now }).runOnce();
    expect(run).toMatchObject({ observationRows: 1, backlog: false });
    const left = await db.pool.query<{ observation_ref: string }>("SELECT observation_ref FROM company_observations");
    expect(left.rows).toEqual([{ observation_ref: "window-ref-inside-00" }]);
  });
});
