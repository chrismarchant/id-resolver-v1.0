/**
 * CHR-66 F1: maintenance scheduling with fakes. The run starts at startup
 * (without waiting one interval), never overlaps, stops between batches on
 * shutdown, and splits its budget so neither kind of row starves the other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainBatches } from "../../src/db/drain.js";
import type { FeedRetention } from "../../src/db/retention.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createMaintenance, type MaintenanceOptions } from "../../src/runtime/maintenance.js";

/** A table of `rows` due rows that one batch deletes at most `limit` of. */
function fakeTable(rows: number) {
  const t = {
    rows,
    calls: 0,
    step: async (limit: number) => {
      await Promise.resolve();
      t.calls += 1;
      const n = Math.min(limit, t.rows);
      t.rows -= n;
      return n;
    },
  };
  return t;
}

function fakeRetention(table: ReturnType<typeof fakeTable>): Pick<FeedRetention, "pruneAllBefore"> {
  return { pruneAllBefore: (_cutoff, opts) => drainBatches(table.step, opts) };
}

/** Browser-event retention over a fake table: the cutoff is recorded, one batch deletes at most `limit`. */
function fakeEvents(table: ReturnType<typeof fakeTable>, cutoffs: Date[] = []): MaintenanceOptions["pruneEventsBefore"] {
  return (cutoff, limit) => {
    cutoffs.push(cutoff);
    return table.step(limit);
  };
}

function options(over: Partial<MaintenanceOptions> = {}): MaintenanceOptions {
  return {
    pruneExpiredCache: fakeTable(0).step,
    retention: fakeRetention(fakeTable(0)),
    pruneEventsBefore: fakeEvents(fakeTable(0)),
    logger: createMemoryLogger(),
    batch: 10,
    retentionDays: 30,
    budgetMs: 20_000,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("drainBatches", () => {
  it("stops at the first short batch, counts only non-empty batches, and reports a backlog when stopped early", async () => {
    expect(await drainBatches(fakeTable(35).step, { batch: 10 })).toEqual({ deleted: 35, batches: 4, backlog: false });
    expect(await drainBatches(fakeTable(20).step, { batch: 10 })).toEqual({ deleted: 20, batches: 2, backlog: false });
    expect(await drainBatches(fakeTable(0).step, { batch: 10 })).toEqual({ deleted: 0, batches: 0, backlog: false });
    expect(await drainBatches(fakeTable(35).step, { batch: 10, maxBatches: 2 })).toEqual({ deleted: 20, batches: 2, backlog: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(await drainBatches(fakeTable(35).step, { batch: 10, signal: aborted.signal })).toEqual({ deleted: 0, batches: 0, backlog: true });
    let t = 0;
    expect(await drainBatches(fakeTable(1_000).step, { batch: 10, deadlineAtMs: 3, now: () => t++ })).toEqual({ deleted: 30, batches: 3, backlog: true });
  });
});

describe("createMaintenance", () => {
  it("splits the budget: expired cache rows may use half, observation retention always gets the rest", async () => {
    const cache = fakeTable(10_000);
    const observations = fakeTable(10_000);
    let t = 0;
    const m = createMaintenance(options({ pruneExpiredCache: cache.step, retention: fakeRetention(observations), budgetMs: 100, now: () => (t += 1) }));
    const run = await m.runOnce();
    expect(run).toMatchObject({ backlog: true, reason: "budget_exhausted" });
    expect(run!.cacheRows).toBeGreaterThan(0);
    expect(run!.observationRows).toBeGreaterThan(0);
    // Each kind got a share of roughly half the budget (one clock read per batch).
    expect(Math.abs(cache.calls - observations.calls)).toBeLessThanOrEqual(2);
  });

  it("runs once at startup without waiting one interval, then every interval; runs never overlap", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const logger = createMemoryLogger();
    const m = createMaintenance(
      options({
        logger,
        pruneExpiredCache: async () => {
          runs += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise<void>((r) => (release = r));
          concurrent -= 1;
          return 0;
        },
      }),
    );
    m.start(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1); // the startup run, before any interval elapsed
    expect(m.running()).toBe(true);
    // Ticks and manual calls while it runs are skipped, not queued or overlapped.
    expect(await m.runOnce()).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runs).toBe(1);
    expect(logger.entries.filter((e) => e["outcome"] === "skipped_in_progress").length).toBeGreaterThanOrEqual(3);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxConcurrent).toBe(1);
    // A second start() does not add a second schedule.
    m.start(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(2);
    await m.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runs).toBe(2);
  });

  it("stop() ends a running drain after its current batch, waits for it, and the run reports the backlog as stopped", async () => {
    let batches = 0;
    let stopRequested: () => void = () => undefined;
    const requested = new Promise<void>((r) => (stopRequested = r));
    const logger = createMemoryLogger();
    const m = createMaintenance(
      options({
        logger,
        // An endless backlog: every batch is full.
        pruneExpiredCache: async (limit) => {
          batches += 1;
          if (batches === 3) stopRequested();
          await new Promise((r) => setImmediate(r));
          return limit;
        },
      }),
    );
    const run = m.runOnce();
    await requested;
    await m.stop();
    expect(m.running()).toBe(false);
    expect(await run).toMatchObject({ backlog: true, reason: "stopped" });
    expect(batches).toBeLessThanOrEqual(4);
    expect(logger.entries.find((e) => e["event"] === "maintenance_backlog")).toMatchObject({ level: "warn", reason: "stopped" });
    // After stop, start() is a no-op.
    m.start(1_000);
    expect(m.running()).toBe(false);
  });

  it("never rejects: a throwing retention is reported as a database_error backlog", async () => {
    const m = createMaintenance(
      options({
        retention: {
          pruneAllBefore: async () => {
            throw new Error("injected failure");
          },
        },
      }),
    );
    await expect(m.runOnce()).resolves.toMatchObject({ backlog: true, reason: "database_error" });
  });

  it("logs counts and flags only: allowlisted events and scalar fields", async () => {
    const logger = createMemoryLogger();
    await createMaintenance(options({ logger, pruneExpiredCache: fakeTable(25).step, retention: fakeRetention(fakeTable(13)) })).runOnce();
    const run = logger.entries.find((e) => e["event"] === "maintenance_run")!;
    expect(run).toMatchObject({ cache_rows: 25, observation_rows: 13, event_rows: 0, backlog: false, outcome: "completed" });
    expect(Object.keys(run).sort()).toEqual(["backlog", "cache_rows", "component", "duration_ms", "event", "event_rows", "level", "observation_rows", "outcome", "time"]);
  });

  it("browser events (event.v1): pruned with the observation cutoff, counted in maintenance_run as event_rows, logged as event_prune", async () => {
    const logger = createMemoryLogger();
    const events = fakeTable(37);
    const cutoffs: Date[] = [];
    const now = Date.parse("2026-11-03T12:00:00.000Z");
    const run = await createMaintenance(options({ logger, pruneEventsBefore: fakeEvents(events, cutoffs), retentionDays: 30, now: () => now })).runOnce();
    expect(run).toMatchObject({ eventRows: 37, backlog: false, reason: null });
    expect(events.rows).toBe(0);
    expect(events.calls).toBe(4); // bounded batches of 10: 10, 10, 10, 7
    expect(new Set(cutoffs.map((c) => c.getTime()))).toEqual(new Set([now - 30 * 86_400_000]));
    expect(logger.entries.find((e) => e["event"] === "maintenance_run")).toMatchObject({ event_rows: 37, backlog: false });
    expect(logger.entries.find((e) => e["event"] === "event_prune")).toMatchObject({ level: "info", rows: 37, count: 4 });
  });

  it("splits the budget three ways when every kind has a backlog: cache up to half, events up to a quarter, observations the rest; none starves", async () => {
    const cache = fakeTable(100_000);
    const events = fakeTable(100_000);
    const observations = fakeTable(100_000);
    let t = 0;
    const m = createMaintenance(options({ pruneExpiredCache: cache.step, pruneEventsBefore: fakeEvents(events), retention: fakeRetention(observations), budgetMs: 400, now: () => (t += 1) }));
    const run = await m.runOnce();
    expect(run).toMatchObject({ backlog: true, reason: "budget_exhausted" });
    // One clock read per batch: about 200, 100 and 100 batches.
    expect(Math.abs(cache.calls - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(events.calls - 100)).toBeLessThanOrEqual(3);
    expect(Math.abs(observations.calls - 100)).toBeLessThanOrEqual(3);
    expect(run!.eventRows).toBe(events.calls * 10);
  });

  it("an empty or short event backlog leaves its unused quarter to observation retention", async () => {
    const events = fakeTable(25);
    const observations = fakeTable(100_000);
    let t = 0;
    const run = await createMaintenance(options({ pruneEventsBefore: fakeEvents(events), retention: fakeRetention(observations), budgetMs: 400, now: () => (t += 1) })).runOnce();
    expect(run).toMatchObject({ eventRows: 25, backlog: true, reason: "budget_exhausted" });
    // The cache had nothing due and events needed 3 batches: observations used nearly the whole budget.
    expect(observations.calls).toBeGreaterThan(390);
  });

  it("an event prune failure is a database_error backlog of category events; cache and observation retention still run", async () => {
    const logger = createMemoryLogger();
    const observations = fakeTable(12);
    const run = await createMaintenance(
      options({
        logger,
        pruneExpiredCache: fakeTable(5).step,
        retention: fakeRetention(observations),
        pruneEventsBefore: async () => {
          throw new Error("injected failure");
        },
      }),
    ).runOnce();
    expect(run).toMatchObject({ cacheRows: 5, observationRows: 12, eventRows: 0, backlog: true, reason: "database_error" });
    expect(logger.entries.find((e) => e["event"] === "maintenance_run")).toMatchObject({ outcome: "partial_failure" });
    expect(logger.entries.find((e) => e["event"] === "maintenance_backlog")).toMatchObject({ level: "warn", reason: "database_error", category: "events" });
  });

  it("names every combination of kinds left with a backlog", async () => {
    const throwing = async (): Promise<number> => {
      throw new Error("injected failure");
    };
    const failingRetention: MaintenanceOptions["retention"] = { pruneAllBefore: throwing };
    const cases: Array<[Partial<MaintenanceOptions>, string]> = [
      [{ pruneExpiredCache: throwing }, "cache"],
      [{ retention: failingRetention }, "observations"],
      [{ pruneEventsBefore: throwing }, "events"],
      [{ pruneExpiredCache: throwing, retention: failingRetention }, "cache_and_observations"],
      [{ pruneExpiredCache: throwing, pruneEventsBefore: throwing }, "cache_and_events"],
      [{ retention: failingRetention, pruneEventsBefore: throwing }, "observations_and_events"],
      [{ pruneExpiredCache: throwing, retention: failingRetention, pruneEventsBefore: throwing }, "cache_and_observations_and_events"],
    ];
    for (const [over, category] of cases) {
      const logger = createMemoryLogger();
      await createMaintenance(options({ logger, ...over })).runOnce();
      expect(logger.entries.find((e) => e["event"] === "maintenance_backlog"), category).toMatchObject({ category });
    }
  });
});
