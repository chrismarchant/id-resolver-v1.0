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

function options(over: Partial<MaintenanceOptions> = {}): MaintenanceOptions {
  return {
    pruneExpiredCache: fakeTable(0).step,
    retention: fakeRetention(fakeTable(0)),
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
    expect(run).toMatchObject({ cache_rows: 25, observation_rows: 13, backlog: false, outcome: "completed" });
    expect(Object.keys(run).sort()).toEqual(["backlog", "cache_rows", "component", "duration_ms", "event", "level", "observation_rows", "outcome", "time"]);
  });
});
