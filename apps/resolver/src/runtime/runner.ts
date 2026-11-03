/**
 * In-process job runner (CHR-70, owner decision D1). Replaces the V0.1
 * fork-per-request child model; implements src/contracts/runtime.ts.
 *
 * Controls, each kept from the child model:
 * - Concurrency: a counting semaphore checked synchronously on admission. A
 *   full runner throws RunnerOverloadedError (HTTP 503 `overloaded`); /readyz
 *   reports not ready while every slot is taken.
 * - Deadline: an AbortController per job, aborted at the request deadline.
 *   run() answers `unavailable/deadline_exceeded` at the deadline whatever
 *   the job is doing; the pipeline stops at its next checkpoint and aborts an
 *   in-flight provider call. The slot is released only when the job itself
 *   settles, so overrunning work still counts against capacity.
 * - Crash containment: every job runs inside its own try/catch; a throwing,
 *   rejecting or malformed job yields `unavailable/internal_error` and frees
 *   its slot. Process-level faults are handled by src/runtime/process-guards.ts.
 * - Stuck jobs: a job still running JOB_STUCK_AFTER_MS past its deadline
 *   (every operation inside it is bounded far below that) is reported to
 *   `onStuck`; the entry point treats that as fatal and exits non-zero.
 * - Hygiene: outcomes are rebuilt from an allowlist before they leave the
 *   runner; logs carry only a random job id, never the IP or a secret.
 */
import { randomUUID } from "node:crypto";
import { OBSERVATION_REF_PATTERN, RESOLUTION_STATUSES, type ResolutionSource } from "../contracts/api.js";
import {
  OUTCOME_REASONS,
  RunnerOverloadedError,
  RunnerStoppedError,
  type JobRequest,
  type ObservationActivity,
  type OutcomeReason,
  type PipelineConfig,
  type ResolutionJob,
  type ResolutionOutcome,
  type Runner,
} from "../contracts/runtime.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../log/index.js";
import { runJob, type PipelineDeps } from "../resolution/pipeline.js";

/**
 * How long a job may keep running after its deadline before it counts as
 * stuck. After the abort a job finishes its current operation (a database
 * call bounded by statement_timeout and the client-side query timeout, or a
 * provider call that the abort cancels) plus at most a fenced commit and a
 * lease release; all of that is bounded well below this.
 */
export const JOB_STUCK_AFTER_MS = 30_000;

/**
 * Database pool size for the single process: per job slot one operation plus
 * one background write that outlived its budget, plus readiness and
 * reporting. Equal to the V0.1 worst case (two connections per child plus the
 * supervisor's four), so the connection footprint does not grow.
 *
 * `eventWriteSlots` (event.v1, only when EVENTS_ENABLED=true) adds one
 * connection per browser-event insert that may be in flight
 * (EVENT_WRITES_MAX_IN_FLIGHT), so event writes never take a connection the
 * resolution jobs are sized for.
 */
export function poolSizeFor(maxConcurrentJobs: number, eventWriteSlots = 0): number {
  return maxConcurrentJobs * 2 + 4 + eventWriteSlots;
}

export type JobExecutor = (deps: PipelineDeps, config: PipelineConfig, job: ResolutionJob) => Promise<ResolutionOutcome>;

export interface RunnerOptions {
  config: PipelineConfig;
  /** Repositories and provider; the runner adds the logger and the deferred-write tracker per job. */
  deps: Omit<PipelineDeps, "logger" | "onDeferred">;
  logger: Logger;
  capacity: number;
  /** Defaults to JOB_STUCK_AFTER_MS. */
  stuckAfterMs?: number;
  /** Called once per stuck job (after the `job_stuck` log line). The entry point exits the process. */
  onStuck?: () => void;
  /** Test seam: the job implementation. Defaults to the resolution pipeline. */
  execute?: JobExecutor;
}

export function buildPipelineConfig(config: Config): PipelineConfig {
  const upper = (xs: string[]) => xs.map((x) => x.trim().toUpperCase()).filter((x) => x.length > 0);
  return {
    installation_id: config.INSTALLATION_ID,
    website_id: config.WEBSITE_ID,
    key_version: config.IP_HMAC_KEY_VERSION,
    ip_hmac_secret: config.IP_HMAC_SECRET,
    provider: {
      // The static kill switch (ENRICHMENT_ENABLED=false) disables the provider outright.
      mode: config.ENRICHMENT_ENABLED ? config.PROVIDER_MODE : "disabled",
      base_url: config.ENRICH_API_BASE_URL,
      api_key: config.ENRICH_API_KEY,
      auth_header: config.ENRICH_AUTH_HEADER,
      timeout_ms: config.ENRICH_TIMEOUT_MS,
    },
    policy: {
      ttl_qualified_ms: config.TTL_QUALIFIED_S * 1000,
      ttl_no_match_ms: config.TTL_NO_MATCH_S * 1000,
      ttl_excluded_ms: config.TTL_EXCLUDED_S * 1000,
      ttl_unknown_ms: config.TTL_UNKNOWN_S * 1000,
      ttl_provider_error_ms: config.TTL_PROVIDER_ERROR_S * 1000,
      ttl_uncertain_ms: config.TTL_UNCERTAIN_S * 1000,
      lease_ms: config.LEASE_MS,
      pending_wait_ms: config.PENDING_WAIT_MS,
      pending_poll_ms: config.PENDING_POLL_MS,
      period_call_cap: config.PERIOD_CALL_CAP,
      usage_period: config.USAGE_PERIOD,
      qualified_usage_types: upper(config.QUALIFIED_USAGE_TYPES),
      excluded_usage_types: upper(config.EXCLUDED_USAGE_TYPES),
      denied_domains: config.DENIED_DOMAINS.map((d) => d.trim().toLowerCase()),
      allow_documentation_ranges: config.ALLOW_DOCUMENTATION_RANGES,
    },
  };
}

// ---- outcome allowlist -------------------------------------------------------

const SOURCES: readonly ResolutionSource[] = ["cache", "provider", "none"];

/** Activity is optional and only meaningful on qualified outcomes; any malformed shape invalidates the outcome. */
function sanitiseActivity(value: unknown): ObservationActivity | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const a = value as Record<string, unknown>;
  const id = a["company_id"];
  const seen = a["previously_seen"];
  const ref = a["observation_ref"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined;
  if (!(seen === null || typeof seen === "boolean")) return undefined;
  if (typeof a["recorded"] !== "boolean") return undefined;
  if (typeof ref !== "string" || !OBSERVATION_REF_PATTERN.test(ref)) return undefined;
  return { company_id: id, previously_seen: seen, recorded: a["recorded"], observation_ref: ref };
}

/**
 * Rebuilds an allowlisted outcome, or null if the shape is invalid. Defence in
 * depth: the pipeline already produces only allowlisted values, but nothing
 * outside this allowlist (free text, an IP, a payload, company identity) can
 * reach a response or a log line even if a future change gets that wrong.
 */
export function sanitiseOutcome(value: unknown): ResolutionOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const status = o["status"];
  const source = o["source"];
  const reason = o["reason"];
  if (!(RESOLUTION_STATUSES as readonly unknown[]).includes(status)) return null;
  if (!(SOURCES as readonly unknown[]).includes(source)) return null;
  if (reason !== undefined && !(OUTCOME_REASONS as readonly unknown[]).includes(reason)) return null;
  const activity = sanitiseActivity(o["activity"]);
  if (activity === undefined) return null;
  if (activity !== null && status !== "qualified") return null;
  return {
    status: status as ResolutionOutcome["status"],
    source: source as ResolutionSource,
    ...(reason !== undefined ? { reason: reason as OutcomeReason } : {}),
    ...(activity !== null ? { activity } : {}),
  };
}

const failure = (reason: "internal_error" | "deadline_exceeded"): ResolutionOutcome => ({
  status: "unavailable",
  source: "none",
  reason,
});

const noop = () => undefined;

// ---- runner ------------------------------------------------------------------

export function createRunner(opts: RunnerOptions): Runner {
  const { config, logger, capacity } = opts;
  const execute: JobExecutor = opts.execute ?? ((deps, cfg, job) => runJob(deps, cfg, job));
  const stuckAfterMs = opts.stuckAfterMs ?? JOB_STUCK_AFTER_MS;
  /** Settlement of every admitted job that has not settled yet. */
  const executing = new Set<Promise<void>>();
  /** Database writes that outlived their budget (tracked so shutdown can drain them). */
  const writes = new Set<Promise<void>>();
  let active = 0;
  let stopped = false;

  const trackWrite = (op: Promise<void>) => {
    const p: Promise<void> = op.then(noop, noop).finally(() => writes.delete(p));
    writes.add(p);
  };

  function run(req: JobRequest): Promise<ResolutionOutcome> {
    // Admission is synchronous: the check and the increment cannot interleave.
    if (stopped) throw new RunnerStoppedError();
    if (active >= capacity) throw new RunnerOverloadedError();
    active += 1;

    const jobId = randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    const job: ResolutionJob = {
      job_id: jobId,
      ip: req.ip,
      deadline_at_ms: req.deadlineAtMs,
      observation_ref: req.observationRef,
      context: req.context,
      signal: controller.signal,
    };
    logger.debug("job_started", { job_id: jobId, active_jobs: active });

    // Per-job crash containment: a synchronous throw, a rejection or a
    // malformed outcome all become a generic failure; the error itself (which
    // could embed an IP or a query parameter) is discarded, never logged.
    let execution: Promise<unknown>;
    try {
      execution = Promise.resolve(execute({ ...opts.deps, logger, onDeferred: trackWrite }, config, job));
    } catch {
      execution = Promise.reject(new Error("job threw synchronously"));
    }
    const result: Promise<ResolutionOutcome> = execution.then(
      (value) => {
        let o: ResolutionOutcome | null = null;
        try {
          o = sanitiseOutcome(value);
        } catch {
          // a hostile shape (e.g. a throwing getter) is just another invalid outcome
        }
        if (o !== null) return o;
        logger.error("job_error", { job_id: jobId, category: "invalid_outcome" });
        return failure("internal_error");
      },
      () => {
        logger.error("job_error", { job_id: jobId, category: "job" });
        return failure("internal_error");
      },
    );

    let deadlineTimer: NodeJS.Timeout | undefined;
    let stuckTimer: NodeJS.Timeout | undefined;
    const settled: Promise<void> = result.then(() => {
      active -= 1;
      clearTimeout(deadlineTimer);
      clearTimeout(stuckTimer);
      executing.delete(settled);
      if (controller.signal.aborted) logger.info("job_settled", { job_id: jobId, duration_ms: Date.now() - started, active_jobs: active });
    });
    executing.add(settled);

    return new Promise<ResolutionOutcome>((resolve) => {
      let answered = false;
      const answer = (o: ResolutionOutcome) => {
        if (answered) return;
        answered = true;
        resolve(o);
      };
      deadlineTimer = setTimeout(() => {
        controller.abort();
        if (!answered) logger.warn("job_timeout", { job_id: jobId, active_jobs: active });
        answer(failure("deadline_exceeded"));
        stuckTimer = setTimeout(() => {
          logger.error("job_stuck", { job_id: jobId, duration_ms: Date.now() - started, active_jobs: active });
          opts.onStuck?.();
        }, stuckAfterMs);
        stuckTimer.unref();
      }, Math.max(0, req.deadlineAtMs - Date.now()));
      deadlineTimer.unref();
      void result.then(answer);
    });
  }

  async function shutdown(graceMs: number): Promise<{ drained: boolean; activeJobs: number; pendingWrites: number }> {
    stopped = true;
    const until = Date.now() + graceMs;
    // A job that settles during the drain may hand over a late write, so loop
    // until both sets are empty or the grace period is spent.
    while ((executing.size > 0 || writes.size > 0) && Date.now() < until) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...executing, ...writes]),
        new Promise<void>((r) => {
          timer = setTimeout(r, Math.max(1, until - Date.now()));
        }),
      ]);
      clearTimeout(timer);
    }
    return { drained: executing.size === 0 && writes.size === 0, activeJobs: active, pendingWrites: writes.size };
  }

  return {
    activeCount: () => active,
    capacity: () => capacity,
    run,
    shutdown,
  };
}
