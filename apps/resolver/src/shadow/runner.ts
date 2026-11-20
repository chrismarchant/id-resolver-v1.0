/**
 * Runner for the watch-only source comparison (SHADOW_SOURCES_MODE=on).
 *
 * The pipeline calls observe() once per cache miss. observe() is synchronous,
 * O(1) and never throws, and it only records the address in memory: no file
 * read, database query or request starts on the caller's stack (the queue is
 * worked from a setImmediate callback). It drops a repeat of an address
 * already measured this UTC day (`dropped_duplicate`) or an address arriving
 * while SHADOW_QUEUE_MAX addresses are already being measured (queued, looked
 * up, or waiting for Enrich's result or their counter write:
 * `dropped_overload`), and otherwise queues the address and hands back a
 * handle through which the pipeline later reports what Enrich did. So the work
 * held in memory is bounded whatever the sources or the database do.
 *
 * Up to SHADOW_CONCURRENCY workers take queued addresses. For each one: the
 * daily quota of each configured API source is reserved atomically in the
 * database (not reserved: verdict `quota`, no request is sent); the sources
 * are asked in parallel, each bounded by SHADOW_TIMEOUT_MS; IPNetDB is looked
 * up from its file (asynchronous reads). The worker slot is then free; the
 * comparison waits for the pipeline's Enrich result (at most 30 s, then
 * `not_called`/`unknown`), computes the counters (src/shadow/compare.ts) and
 * writes them in one statement. Database work goes through
 * SHADOW_DB_MAX_IN_FLIGHT connections at most (the pool is sized for them in
 * src/main.ts), so the comparison never takes a connection a resolution job
 * needs. The repository it is given should not log (src/db/index.ts
 * `shadowCounters`): its failures are this runner's `shadow_write_failed`,
 * never the resolution path's `db_error`.
 *
 * Deduplication: a Set of fingerprint hex strings per UTC day, cleared at the
 * day change, at most `dedupMax` (50,000) entries; when full it stops adding
 * (later new addresses are measured, never deduplicated) instead of growing.
 * Drop counters are summed in memory and written every few seconds.
 *
 * Logs: `shadow_observed` (debug, verdict categories only) and
 * `shadow_write_failed{category}`. Never the address, the fingerprint, a
 * domain or a name. The address is dropped from the task once looked up.
 */
import type { ShadowRepository } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { compare } from "./compare.js";
import { apiVerdict } from "./verdict.js";
import type {
  ApiSource,
  ApiSourceAdapter,
  ApiSourceOutcome,
  ApiVerdict,
  EnrichSummary,
  IpnetdbResult,
  ShadowHandle,
  ShadowMetric,
  ShadowObserveContext,
  ShadowObserver,
  ShadowScope,
} from "./types.js";

/** How long a measured address waits for the pipeline to report Enrich's result. */
export const SHADOW_COMPLETE_TIMEOUT_MS = 30_000;
export const SHADOW_DEDUP_MAX = 50_000;
/** Database connections the comparison may use at once (src/main.ts adds them to the pool). */
export const SHADOW_DB_MAX_IN_FLIGHT = 2;
const DROP_FLUSH_MS = 5_000;

export interface ShadowRunnerOptions {
  scope: { installationId: string; websiteId: string };
  /** Counter store; build it without a logger (its failures are logged here as shadow_write_failed). */
  repo: ShadowRepository;
  logger: Logger;
  /** Undefined: the source has no key (verdict `disabled`, nothing sent). */
  ipapi?: ApiSourceAdapter;
  iplocate?: ApiSourceAdapter;
  /** Undefined: IPNETDB_ENABLED=false (verdict `disabled`). Never rejects (src/shadow/ipnetdb.ts). */
  ipnetdb?: { lookup(canonicalIp: string): Promise<IpnetdbResult> };
  limits: Record<ApiSource, number>;
  timeoutMs: number;
  concurrency: number;
  /** Addresses being measured at once (queued, looked up, waiting for Enrich or for the write); more are dropped. */
  queueMax: number;
  now?: () => Date;
  completeTimeoutMs?: number;
  dedupMax?: number;
  dropFlushMs?: number;
}

export interface ShadowRunner extends ShadowObserver {
  /** Stops accepting, then waits for queued and running comparisons and writes, at most `timeoutMs`; aborts the rest. */
  drain(timeoutMs: number): Promise<{ drained: boolean; pending: number }>;
  /** queued: not started; running: asking the sources; inFlight: accepted and not yet written (bounded by queueMax). */
  stats(): { queued: number; running: number; inFlight: number; pending: number; dedup: number };
}

/** UTC calendar date (YYYY-MM-DD). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Task {
  /** Cleared once the sources have been asked. */
  ip: string;
  day: string;
  hostingRangeMatched: boolean;
  enrich: Promise<EnrichSummary>;
  settle: (s: EnrichSummary) => void;
  settled: boolean;
  timer: NodeJS.Timeout | null;
}

interface Sources {
  ipapi: ApiVerdict;
  iplocate: ApiVerdict;
  ipnetdb: IpnetdbResult;
}

const UNKNOWN: EnrichSummary = { kind: "not_called", reason: "unknown" };
const noop = () => undefined;

export function createShadowRunner(opts: ShadowRunnerOptions): ShadowRunner {
  const { repo, logger } = opts;
  const now = opts.now ?? (() => new Date());
  const completeTimeoutMs = opts.completeTimeoutMs ?? SHADOW_COMPLETE_TIMEOUT_MS;
  const dedupMax = opts.dedupMax ?? SHADOW_DEDUP_MAX;
  const dropFlushMs = opts.dropFlushMs ?? DROP_FLUSH_MS;
  const controller = new AbortController();

  const queue: Task[] = [];
  let queueHead = 0;
  const waiting = new Set<Task>();
  /** Every comparison not yet written, and every drop flush in progress. */
  const pending = new Set<Promise<void>>();
  /** Accepted addresses not yet written (queued, running, waiting for Enrich or the write): at most queueMax. */
  let inFlight = 0;
  let running = 0;
  let stopped = false;
  let pumpScheduled = false;

  let dedupDay = "";
  const dedup = new Set<string>();

  const drops = new Map<string, Map<ShadowMetric, number>>();
  let dropTimer: NodeJS.Timeout | null = null;

  // ---- database slots --------------------------------------------------------------
  let dbActive = 0;
  const dbWaiters: Array<() => void> = [];
  const db = async <T>(fn: () => Promise<T>): Promise<T> => {
    // A freed slot is handed straight to the next waiter, so the count never exceeds the bound.
    if (dbActive >= SHADOW_DB_MAX_IN_FLIGHT) await new Promise<void>((r) => dbWaiters.push(r));
    else dbActive += 1;
    try {
      return await fn();
    } finally {
      const next = dbWaiters.shift();
      if (next) next();
      else dbActive -= 1;
    }
  };

  const track = (p: Promise<void>): void => {
    const t: Promise<void> = p.then(noop, noop).finally(() => pending.delete(t));
    pending.add(t);
  };

  const scopeFor = (day: string): ShadowScope => ({ installationId: opts.scope.installationId, websiteId: opts.scope.websiteId, day });

  // ---- drop counters ---------------------------------------------------------------
  const flushDrops = (): void => {
    if (dropTimer) clearTimeout(dropTimer);
    dropTimer = null;
    for (const [day, counts] of drops) {
      const deltas = Object.fromEntries(counts) as Partial<Record<ShadowMetric, number>>;
      track(
        db(() => repo.increment(scopeFor(day), deltas)).catch(() => {
          logger.warn("shadow_write_failed", { category: "drop_counters" });
        }),
      );
    }
    drops.clear();
  };

  const countDrop = (day: string, metric: ShadowMetric): void => {
    let counts = drops.get(day);
    if (!counts) {
      counts = new Map();
      drops.set(day, counts);
    }
    counts.set(metric, (counts.get(metric) ?? 0) + 1);
    if (!dropTimer && !stopped) {
      dropTimer = setTimeout(flushDrops, dropFlushMs);
      dropTimer.unref();
    }
  };

  // ---- one address -----------------------------------------------------------------
  const ask = async (adapter: ApiSourceAdapter | undefined, source: ApiSource, scope: ShadowScope, ip: string): Promise<ApiVerdict> => {
    if (!adapter) return apiVerdict(null);
    let reserved: boolean;
    try {
      reserved = await db(() => repo.reserveSourceRequest(scope, source, opts.limits[source]));
    } catch {
      logger.warn("shadow_write_failed", { category: "quota_reservation" });
      return { verdict: "error" };
    }
    if (!reserved) return { verdict: "quota" };
    let outcome: ApiSourceOutcome;
    try {
      outcome = await adapter.lookup(ip, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeoutMs)]) });
    } catch {
      outcome = { kind: "error" };
    }
    return apiVerdict(outcome);
  };

  const lookIpnetdb = async (ip: string): Promise<IpnetdbResult> => {
    if (!opts.ipnetdb) return { verdict: "disabled" };
    try {
      return await opts.ipnetdb.lookup(ip);
    } catch {
      return { verdict: "unavailable" };
    }
  };

  const lookups = async (task: Task): Promise<Sources> => {
    const scope = scopeFor(task.day);
    const ip = task.ip;
    task.ip = "";
    const [ipnetdb, ipapi, iplocate] = await Promise.all([lookIpnetdb(ip), ask(opts.ipapi, "ipapi", scope, ip), ask(opts.iplocate, "iplocate", scope, ip)]);
    return { ipapi, iplocate, ipnetdb };
  };

  const record = async (task: Task, sources: Sources): Promise<void> => {
    const enrich = await task.enrich;
    let metrics: ShadowMetric[];
    try {
      const c = compare({ ...sources, hostingRangeMatched: task.hostingRangeMatched, enrich });
      metrics = c.metrics;
      logger.debug("shadow_observed", {
        ipapi: sources.ipapi.verdict,
        iplocate: sources.iplocate.verdict,
        ipnetdb: sources.ipnetdb.verdict,
        enrich: c.enrich,
        waterfall: c.waterfall,
      });
    } catch {
      logger.warn("shadow_write_failed", { category: "compare" });
      return;
    }
    try {
      await db(() => repo.increment(scopeFor(task.day), metrics));
    } catch {
      logger.warn("shadow_write_failed", { category: "counters" });
    }
  };

  const pump = (): void => {
    pumpScheduled = false;
    // After an aborted drain nothing new starts.
    while (!controller.signal.aborted && running < opts.concurrency && queueHead < queue.length) {
      const task = queue[queueHead]!;
      queue[queueHead] = undefined as unknown as Task;
      queueHead += 1;
      if (queueHead > 1024 && queueHead * 2 > queue.length) {
        queue.splice(0, queueHead);
        queueHead = 0;
      }
      running += 1;
      const looked = lookups(task);
      void looked.then(noop, noop).finally(() => {
        running -= 1;
        schedulePump();
      });
      track(
        looked
          .then((sources) => record(task, sources))
          .catch(() => {
            logger.warn("shadow_write_failed", { category: "internal" });
          })
          .finally(() => {
            if (task.timer) clearTimeout(task.timer);
            task.timer = null;
            waiting.delete(task);
            inFlight -= 1;
          }),
      );
    }
  };

  /** The queue is worked from a fresh macrotask, never on the stack that queued an address. */
  const schedulePump = (): void => {
    if (pumpScheduled || controller.signal.aborted) return;
    if (queueHead >= queue.length) return;
    pumpScheduled = true;
    setImmediate(pump);
  };

  const queued = () => queue.length - queueHead;

  const observe = (canonicalIp: string, dedupKey: Buffer | string, context?: ShadowObserveContext): ShadowHandle | null => {
    try {
      if (stopped) return null;
      const day = utcDay(now());
      if (day !== dedupDay) {
        dedup.clear();
        dedupDay = day;
      }
      const key = typeof dedupKey === "string" ? dedupKey : dedupKey.toString("hex");
      if (dedup.has(key)) {
        countDrop(day, "dropped_duplicate");
        return null;
      }
      if (inFlight >= opts.queueMax) {
        countDrop(day, "dropped_overload");
        return null;
      }
      if (dedup.size < dedupMax) dedup.add(key);

      let settle!: (s: EnrichSummary) => void;
      const enrich = new Promise<EnrichSummary>((r) => (settle = r));
      const task: Task = { ip: canonicalIp, day, hostingRangeMatched: context?.hostingRangeMatched === true, enrich, settle, settled: false, timer: null };
      const complete = (s: EnrichSummary): void => {
        if (task.settled) return;
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        task.timer = null;
        waiting.delete(task);
        task.settle(s);
      };
      task.timer = setTimeout(() => complete(UNKNOWN), completeTimeoutMs);
      task.timer.unref();
      waiting.add(task);
      inFlight += 1;
      queue.push(task);
      schedulePump();
      return {
        complete(summary: EnrichSummary): void {
          try {
            complete(summary);
          } catch {
            /* never throws into the pipeline */
          }
        },
      };
    } catch {
      return null;
    }
  };

  const drain = async (timeoutMs: number): Promise<{ drained: boolean; pending: number }> => {
    stopped = true;
    flushDrops();
    // Every job has settled by now (the resolution runner drains first): a comparison still waiting will not hear from Enrich.
    for (const task of [...waiting]) {
      if (!task.settled) {
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        task.timer = null;
        task.settle(UNKNOWN);
      }
    }
    waiting.clear();
    const until = Date.now() + Math.max(0, timeoutMs);
    // Queued addresses not started yet are not in `pending`: wait for the queue too.
    while ((pending.size > 0 || queued() > 0) && Date.now() < until) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all([...pending]), new Promise<void>((r) => (t = setTimeout(r, Math.max(1, Math.min(50, until - Date.now())))))]);
      clearTimeout(t);
    }
    const drained = pending.size === 0 && queued() === 0;
    if (!drained) {
      controller.abort();
      for (let i = queueHead; i < queue.length; i += 1) {
        const task = queue[i];
        if (task?.timer) clearTimeout(task.timer);
      }
      inFlight -= queued();
      queue.length = 0;
      queueHead = 0;
    }
    return { drained, pending: pending.size };
  };

  return {
    observe,
    drain,
    stats: () => ({ queued: queued(), running, inFlight, pending: pending.size, dedup: dedup.size }),
  };
}
