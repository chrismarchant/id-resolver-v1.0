/**
 * Periodic data maintenance (CHR-66 F1; owner decision D3): deletes expired
 * cache rows (pseudonymous IP fingerprints past their TTL), and observations
 * and browser events (event.v1, CHR-64) and bot visits (bot-visit.v1) older
 * than OBSERVATION_RETENTION_DAYS (the bounded synchronisation buffer).
 *
 * A run DRAINS: it repeats bounded batches (CACHE_PRUNE_BATCH rows, one
 * statement each) until a batch comes back short, within a per-run time
 * budget (CACHE_PRUNE_BUDGET_MS). In order: expired cache rows may use up to
 * half of the budget; browser events, then bot visits, may then use up to a
 * quarter of it together, and never past three quarters of the budget; observation retention gets the
 * rest (the last quarter at least, and all of what the others leave unused),
 * so none of the three can starve another.
 *
 * A deadline only stops a phase from STARTING another batch. A single batch
 * already running can overrun it (CHR-66 G4-L1): if the last cache batch
 * returns after the half, the event phase still ends at three quarters, so
 * the observations' last quarter is kept whole as long as that batch returns
 * by then. A single batch that itself runs past three quarters of the budget
 * leaves observation retention only what remains of it; the run then reports
 * the backlog, and the next run continues.
 * Observations are deleted through createFeedRetention().pruneAllBefore,
 * whose statement-level trigger advances the feed's retention watermark
 * atomically with each batch (migration 0006). Browser events are deleted by
 * received_at through the event repository; browser_events has no trigger,
 * so pruning it never moves the watermark or writes a tombstone.
 *
 * Schedule: once at startup (after the server listens, without blocking it),
 * then every CACHE_PRUNE_INTERVAL_S. Runs never overlap: a tick that finds a
 * run in progress is skipped. stop() ends the schedule and asks a running run
 * to stop after its current batch; nothing is left half-done because every
 * batch is its own statement.
 *
 * Every run logs `maintenance_run{cache_rows, observation_rows, event_rows,
 * bot_visit_rows, backlog, duration_ms, outcome}`. When due rows may remain (budget exhausted,
 * stopped or a database error) it also logs the warning
 * `maintenance_backlog{reason, category}`;
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
  /** One bounded batch of browser events received before `cutoff` (EventRepository.pruneBefore, event.v1). */
  pruneEventsBefore: (cutoff: Date, limit: number) => Promise<number>;
  /** One bounded batch of bot visits received before `cutoff` (BotVisitRepository.pruneBefore, bot-visit.v1). Optional. */
  pruneBotVisitsBefore?: (cutoff: Date, limit: number) => Promise<number>;
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
  eventRows: number;
  botVisitRows: number;
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

    // One cutoff for both retention kinds: OBSERVATION_RETENTION_DAYS before
    // the retention phase starts (one clock read, as before events existed).
    const retentionStartedAt = now();
    let cutoff: Date | null = null;
    try {
      cutoff = retentionCutoff(new Date(retentionStartedAt), opts.retentionDays);
    } catch {
      failed = true;
    }

    // Up to a quarter of the budget for browser events and bot visits together,
    // but never into the last quarter, which belongs to observation retention (CHR-66 G4-L1).
    const eventDeadlineAtMs = Math.min(retentionStartedAt + Math.floor(opts.budgetMs / 4), startedAt + opts.budgetMs - Math.floor(opts.budgetMs / 4));

    let eventRows = 0;
    let eventBacklog = false;
    try {
      if (cutoff === null) throw new Error("no cutoff");
      const before = cutoff;
      const r = await drainBatches(
        async (limit) => {
          const n = await opts.pruneEventsBefore(before, limit);
          eventRows += n;
          return n;
        },
        { batch: opts.batch, deadlineAtMs: eventDeadlineAtMs, now, signal },
      );
      eventBacklog = r.backlog;
      if (r.deleted > 0) logger.info("event_prune", { rows: r.deleted, count: r.batches });
    } catch {
      // The repository already logged db_error{category}; rows not deleted now are retried next run.
      failed = true;
      eventBacklog = true;
    }

    let botVisitRows = 0;
    let botVisitBacklog = false;
    const pruneBotVisits = opts.pruneBotVisitsBefore;
    if (pruneBotVisits) {
      try {
        if (cutoff === null) throw new Error("no cutoff");
        const before = cutoff;
        const r = await drainBatches(
          async (limit) => {
            const n = await pruneBotVisits(before, limit);
            botVisitRows += n;
            return n;
          },
          { batch: opts.batch, deadlineAtMs: eventDeadlineAtMs, now, signal },
        );
        botVisitBacklog = r.backlog;
        if (r.deleted > 0) logger.info("bot_visit_prune", { rows: r.deleted, count: r.batches });
      } catch {
        failed = true;
        botVisitBacklog = true;
      }
    }

    let observationRows = 0;
    let observationBacklog = false;
    try {
      if (cutoff === null) throw new Error("no cutoff");
      const r = await opts.retention.pruneAllBefore(cutoff, { batch: opts.batch, deadlineAtMs: startedAt + opts.budgetMs, now, signal });
      observationRows = r.deleted;
      observationBacklog = r.backlog;
    } catch {
      failed = true;
      observationBacklog = true;
    }

    const backlog = cacheBacklog || observationBacklog || eventBacklog || botVisitBacklog;
    const reason: MaintenanceBacklogReason | null = !backlog ? null : failed ? "database_error" : signal.aborted ? "stopped" : "budget_exhausted";
    const durationMs = Math.max(0, now() - startedAt);
    const fields = {
      cache_rows: cacheRows,
      observation_rows: observationRows,
      event_rows: eventRows,
      ...(pruneBotVisits ? { bot_visit_rows: botVisitRows } : {}),
      backlog,
      duration_ms: durationMs,
    };
    logger.info("maintenance_run", { ...fields, outcome: failed ? "partial_failure" : "completed" });
    if (reason !== null) {
      const kinds = [cacheBacklog ? "cache" : null, observationBacklog ? "observations" : null, eventBacklog ? "events" : null, botVisitBacklog ? "bot_visits" : null].filter((k) => k !== null);
      logger.warn("maintenance_backlog", { ...fields, reason, category: kinds.join("_and_") });
    }
    return { cacheRows, observationRows, eventRows, botVisitRows, backlog, reason, durationMs };
  };

  const runOnce = (): Promise<MaintenanceRun | null> => {
    if (current !== null) {
      logger.debug("maintenance_run", { outcome: "skipped_in_progress" });
      return Promise.resolve(null);
    }
    const run = execute()
      // execute() catches every database failure; this only guards against a
      // defect, because a rejected scheduled run would be an unhandled rejection.
      .catch((): MaintenanceRun => ({ cacheRows: 0, observationRows: 0, eventRows: 0, botVisitRows: 0, backlog: true, reason: "database_error", durationMs: 0 }))
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
