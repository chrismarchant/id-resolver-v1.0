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

  /** `old` browser events received before the retention window and `fresh` ones inside it (event.v1). */
  async function seedEvents(old: number, fresh: number): Promise<void> {
    await db.pool.query(
      `INSERT INTO browser_events (installation_id, website_id, event_id, type, name, page_key, consent, occurred_at, received_at)
       SELECT $1::text, $2::text, 'maint_evt_' || lpad(g::text, 16, '0'), 'page_view', 'page_view', '/maintenance', 'granted', t, t
       FROM (SELECT g, CASE WHEN g <= $3::int THEN now() - interval '40 days' - make_interval(secs => g) ELSE now() - make_interval(secs => g) END AS t
             FROM generate_series(1, $3::int + $4::int) g) s`,
      [FEED_SCOPE.installationId, FEED_SCOPE.websiteId, old, fresh],
    );
  }

  const count = async (table: "ip_resolution_cache" | "company_observations" | "browser_events") =>
    (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  function maintenance(over: Partial<MaintenanceOptions> = {}) {
    return createMaintenance({
      pruneExpiredCache: (limit) => db.cache.pruneExpired(limit),
      retention,
      pruneEventsBefore: (cutoff, limit) => db.events.pruneBefore(cutoff, limit),
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

  describe("browser events (event.v1, CHR-64)", () => {
    const feedState = async () => ({
      watermark: await retention.watermark(FEED_SCOPE),
      watermarkRows: (await db.pool.query("SELECT installation_id, website_id, pruned_through_txid::text, pruned_through_id, updated_at FROM feed_retention_watermarks ORDER BY 1, 2")).rows,
      tombstones: (await db.pool.query("SELECT id, company_id, erased_at FROM feed_tombstones ORDER BY id")).rows,
      observations: (await db.pool.query("SELECT id::text, txid::text FROM company_observations ORDER BY id")).rows,
    });

    it("one run deletes every event past retention in bounded batches, keeps the rest, and logs event_rows and event_prune", async () => {
      await seedEvents(47, 6);
      const run = await maintenance().runOnce();
      expect(run).toMatchObject({ eventRows: 47, cacheRows: 0, observationRows: 0, backlog: false, reason: null });
      expect(await count("browser_events")).toBe(6);
      expect(events("maintenance_run")).toEqual([expect.objectContaining({ level: "info", event_rows: 47, backlog: false, outcome: "completed" })]);
      // 47 rows in batches of 10: five statements, each bounded.
      expect(events("event_prune")).toEqual([expect.objectContaining({ rows: 47, count: 5 })]);
      expect(events("maintenance_backlog")).toEqual([]);
    });

    it("pruning events leaves the feed exactly as it was: same retention watermark, tombstones and observations", async () => {
      // A feed with a watermark already in place (observations pruned earlier) and live observations.
      await seedObservations(4, 3);
      expect((await maintenance().runOnce())!.observationRows).toBe(4);
      const before = await feedState();
      expect(before.watermark).not.toBeNull();
      expect(before.observations.length).toBe(3);
      await seedEvents(35, 2);
      const run = await maintenance().runOnce();
      expect(run).toMatchObject({ eventRows: 35, observationRows: 0, backlog: false });
      expect(await feedState()).toEqual(before);
      expect(await count("browser_events")).toBe(2);
    });

    it("pruning events never creates a watermark where none existed", async () => {
      await seedEvents(12, 1);
      expect((await maintenance().runOnce())!.eventRows).toBe(12);
      expect(await retention.watermark(FEED_SCOPE)).toBeNull();
      expect((await db.pool.query("SELECT 1 FROM feed_retention_watermarks")).rowCount).toBe(0);
      expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);
    });

    it("retention follows the resolver's received_at, never the caller's occurred_at", async () => {
      const day = 86_400_000;
      const nowMs = Date.now();
      await db.pool.query(
        `INSERT INTO browser_events (installation_id, website_id, event_id, type, name, page_key, consent, occurred_at, received_at)
         VALUES ($1, $2, 'evt_received_old_000', 'page_view', 'page_view', '/a', 'granted', $3, $4),
                ($1, $2, 'evt_occurred_old_000', 'page_view', 'page_view', '/a', 'granted', $4, $3)`,
        [FEED_SCOPE.installationId, FEED_SCOPE.websiteId, new Date(nowMs - 60_000), new Date(nowMs - (RETENTION_DAYS + 1) * day)],
      );
      expect((await maintenance({ now: () => nowMs }).runOnce())!.eventRows).toBe(1);
      expect((await db.pool.query<{ event_id: string }>("SELECT event_id FROM browser_events")).rows).toEqual([{ event_id: "evt_occurred_old_000" }]);
    });

    it("an exhausted budget stops the event drain between batches and reports the backlog; later runs finish it", async () => {
      await seedEvents(300, 4);
      let t = Date.now();
      const m = maintenance({ budgetMs: 2_000, now: () => (t += 100) });
      const first = await m.runOnce();
      expect(first).toMatchObject({ backlog: true, reason: "budget_exhausted" });
      // Up to a quarter of the budget: several batches, not all of them.
      expect(first!.eventRows).toBeGreaterThan(BATCH);
      expect(first!.eventRows).toBeLessThan(300);
      expect(events("maintenance_backlog")).toEqual([expect.objectContaining({ level: "warn", reason: "budget_exhausted", category: "events" })]);
      let runs = 1;
      let last = first;
      while (last!.backlog && runs < 40) {
        last = await m.runOnce();
        runs += 1;
      }
      expect(last).toMatchObject({ backlog: false });
      expect(await count("browser_events")).toBe(4);
    });
  });
});
