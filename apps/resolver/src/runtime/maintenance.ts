/**
 * Periodic data maintenance (CHR-66 F1; owner decision D3): deletes expired
 * cache rows (pseudonymous IP fingerprints past their TTL) and observations
 * older than OBSERVATION_RETENTION_DAYS (the bounded synchronisation buffer).
 *
 * A run DRAINS: it repeats bounded batches (CACHE_PRUNE_BATCH rows, one
 * statement each) until a batch comes back short, within a per-run time
 * budget (CACHE_PRUNE_BUDGET_MS). Expired cache rows may use up to half of
 * the budget; observation retention gets the rest, so neither can starve the
 * other. Observations are deleted through createFeedRetention().pruneAllBefore,
 * whose statement-level trigger advances the feed's retention watermark
 * atomically with each batch (migration 0006).
 *
 * Schedule: once at startup (after the server listens, without blocking it),
 * then every CACHE_PRUNE_INTERVAL_S. Runs never overlap: a tick that finds a
 * run in progress is skipped. stop() ends the schedule and asks a running run
 * to stop after its current batch; nothing is left half-done because every
 * batch is its own statement.
 *
 * Every run logs `maintenance_run{cache_rows, observation_rows, backlog,
 * duration_ms, outcome}`. When due rows may remain (budget exhausted, stopped
 * or a database error) it also logs the warning `maintenance_backlog{reason}`;
 * a backlog that persists across runs means the budget or batch size is too
 * small for the ingress rate. Counts are of rows deleted by completed batches.
 */
import { drainBatches } from "../db/drain.js";
import { retentionCutoff, type FeedRetention } from "../db/retention.js";
import type { Logger } from "../log/index.js";

export interface MaintenanceOptions {
  /** One bounded batch of expired cache rows (CacheRepository.pruneExpired). */
  pruneExpiredCache: (limit: number) => Promise<number>;
  /** Observation retention (createFeedRetention). */
  retention: Pick<FeedRetention, "pruneAllBefore">;
  logger: Logger;
  /** Rows per batch (CACHE_PRUNE_BATCH). */
  batch: number;
  /** OBSERVATION_RETENTION_DAYS. */
  retentionDays: number;
  /** Time budget of one run (CACHE_PRUNE_BUDGET_MS). */
  budgetMs: number;
  /** Wall clock in ms; decides both the budget and the retention cutoff. Default Date.now. */
  now?: () => number;
}

export type MaintenanceBacklogReason = "budget_exhausted" | "stopped" | "database_error";

export interface MaintenanceRun {
  cacheRows: number;
  observationRows: number;
  /** True when due rows may remain; the next run continues. */
  backlog: boolean;
  /** Why rows may remain; null when the run drained everything that was due. */
  reason: MaintenanceBacklogReason | null;
  durationMs: number;
}

export interface Maintenance {
  /** One run. Resolves null, doing nothing, while another run is in progress. Never rejects. */
  runOnce(): Promise<MaintenanceRun | null>;
  /** Starts one run now (not awaited) and then one every `intervalMs`. No-op once started or stopped. */
  start(intervalMs: number): void;
  /** Ends the schedule, asks a running run to stop after its current batch, and waits for it. */
  stop(): Promise<void>;
  /** True while a run is in progress. */
  running(): boolean;
}

export function createMaintenance(opts: MaintenanceOptions): Maintenance {
  const now = opts.now ?? Date.now;
  const { logger } = opts;
  const halt = new AbortController();
  let current: Promise<MaintenanceRun> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let started = false;

  const execute = async (): Promise<MaintenanceRun> => {
    const startedAt = now();
    const signal = halt.signal;
    let failed = false;

    let cacheRows = 0;
    let cacheBacklog = false;
    try {
      const r = await drainBatches(
        async (limit) => {
          const n = await opts.pruneExpiredCache(limit);
          cacheRows += n;
          return n;
        },
        { batch: opts.batch, deadlineAtMs: startedAt + Math.floor(opts.budgetMs / 2), now, signal },
      );
      cacheBacklog = r.backlog;
    } catch {
      // The repository already logged db_error{category}; rows not deleted now are retried next run.
      failed = true;
      cacheBacklog = true;
    }

    let observationRows = 0;
    let observationBacklog = false;
    try {
      const cutoff = retentionCutoff(new Date(now()), opts.retentionDays);
      const r = await opts.retention.pruneAllBefore(cutoff, { batch: opts.batch, deadlineAtMs: startedAt + opts.budgetMs, now, signal });
      observationRows = r.deleted;
      observationBacklog = r.backlog;
    } catch {
      failed = true;
      observationBacklog = true;
    }

    const backlog = cacheBacklog || observationBacklog;
    const reason: MaintenanceBacklogReason | null = !backlog ? null : failed ? "database_error" : signal.aborted ? "stopped" : "budget_exhausted";
    const durationMs = Math.max(0, now() - startedAt);
    const fields = { cache_rows: cacheRows, observation_rows: observationRows, backlog, duration_ms: durationMs };
    logger.info("maintenance_run", { ...fields, outcome: failed ? "partial_failure" : "completed" });
    if (reason !== null) {
      logger.warn("maintenance_backlog", {
        ...fields,
        reason,
        category: cacheBacklog && observationBacklog ? "cache_and_observations" : cacheBacklog ? "cache" : "observations",
      });
    }
    return { cacheRows, observationRows, backlog, reason, durationMs };
  };

  const runOnce = (): Promise<MaintenanceRun | null> => {
    if (current !== null) {
      logger.debug("maintenance_run", { outcome: "skipped_in_progress" });
      return Promise.resolve(null);
    }
    const run = execute()
      // execute() catches every database failure; this only guards against a
      // defect, because a rejected scheduled run would be an unhandled rejection.
      .catch((): MaintenanceRun => ({ cacheRows: 0, observationRows: 0, backlog: true, reason: "database_error", durationMs: 0 }))
      .finally(() => {
        current = null;
      });
    current = run;
    return run;
  };

  return {
    runOnce,
    start(intervalMs) {
      if (started || halt.signal.aborted) return;
      started = true;
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref();
    },
    async stop() {
      halt.abort();
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (current !== null) await current;
    },
    running: () => current !== null,
  };
}
