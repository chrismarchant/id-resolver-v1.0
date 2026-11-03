/**
 * One resolution job: canonicalise -> fingerprint -> reserve -> controls ->
 * usage reservation -> provider (bounded timeout) -> qualify -> fenced commit
 * -> durable company activity (qualified outcomes only, within the deadline).
 *
 * Dependencies are injected so the orchestration is testable with fakes.
 * The outcome never carries free text: only allowlisted statuses/reasons.
 * The raw IP and error messages never leave this function and are never logged.
 */
import type { CompanyContext } from "../contracts/api.js";
import type {
  ActivityRepository,
  CacheCompany,
  CacheKey,
  CacheRepository,
  CacheRow,
  CommitOutcome,
  CompanyRepository,
  ControlsRepository,
  ObservationSource,
  RecordObservationResult,
  UsageCounter,
  UsageRepository,
  UsageScope,
} from "../contracts/db.js";
import { usagePeriodKey } from "../contracts/db.js";
import type { ChildActivity, ChildJobMessage, ChildOutcome, ChildOutcomeReason, ChildRuntimeConfig } from "../contracts/ipc.js";
import type { ProviderAdapter, ProviderOutcome } from "../contracts/provider.js";
import { canonicaliseIp } from "../ip/canonical.js";
import { computeFingerprint, decodeSecret } from "../ip/fingerprint.js";
import type { Logger } from "../log/index.js";
import { qualify } from "./qualify.js";

export interface PipelineDeps {
  cache: CacheRepository;
  usage: UsageRepository;
  controls: ControlsRepository;
  companies: CompanyRepository;
  activity: ActivityRepository;
  provider: ProviderAdapter;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Receives accounting operations that exceeded their budget and are still
   * running, so the caller (the child entry point) can wait for them, bounded,
   * before it closes the pool: nothing runs untracked in the background.
   */
  onDeferred?: (op: Promise<void>) => void;
}

/**
 * Reserved before lease expiry so the fenced commit lands while the lease is
 * still held. The lease remaining is a DURATION reported by the database at
 * reservation time and counted down with the worker's own clock, so worker
 * clock offset does not affect it; only clock rate does, which this margin
 * absorbs together with the commit round trip.
 */
export const LEASE_COMMIT_BUDGET_MS = 300;
/**
 * Reserved before the request deadline so the fenced commit (one round trip)
 * and the durable activity write (one short transaction on the same
 * connection pool, a few milliseconds on a co-located database) complete
 * before the child is killed. 450 ms was the pre-activity reserve.
 */
export const DEADLINE_COMMIT_BUDGET_MS = 550;
/** The activity write is skipped (reported as not recorded) when less than this remains before the deadline. */
export const ACTIVITY_MIN_REMAINING_MS = 150;
/** Kept between the activity write's own timeout and the request deadline so the result still reaches the supervisor. */
export const ACTIVITY_DEADLINE_MARGIN_MS = 50;
/**
 * Best-effort accounting (usage counters, credit estimates) gets at most this
 * long per operation and never the last ACCOUNTING_RESERVE_MS before the
 * deadline, which stay reserved for the activity write and the response. The
 * atomic provider-attempt reservation is not accounting and is never bounded
 * this way.
 */
export const ACCOUNTING_TIMEOUT_MS = 250;
export const ACCOUNTING_RESERVE_MS = DEADLINE_COMMIT_BUDGET_MS;
/** Below this, a provider call is not worth dispatching. */
export const MIN_PROVIDER_TIMEOUT_MS = 200;
/** Margin kept before the request deadline when waiting for another worker. */
export const PENDING_MARGIN_MS = 100;
const MAX_ERROR_TTL_MS = 60 * 60 * 1000;
/** Enrich charges 100 credits per call that returns a domain. */
const ESTIMATED_CREDITS_PER_DOMAIN = 100;

/** Marks a failure that came from a repository (database). */
class RepositoryError extends Error {}
/** The activity write did not finish within the request deadline. */
class ActivityTimeoutError extends Error {}

async function repo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new RepositoryError();
  }
}

const outcome = (status: ChildOutcome["status"], reason: ChildOutcomeReason, source: ChildOutcome["source"] = "none"): ChildOutcome => ({
  status,
  company: null,
  source,
  reason,
});

function companyContext(c: CacheCompany, checkedAt: Date): CompanyContext {
  return {
    domain: c.domain,
    organisation_name: c.organisationName,
    qualification: { category: c.qualificationCategory, source: "provider_usage_type" },
    resolved_at: checkedAt.toISOString(),
  };
}

export function outcomeFromCacheRow(row: CacheRow): ChildOutcome {
  switch (row.status) {
    case "qualified":
      if (!row.company || row.companyId === null) return outcome("unknown", "cache_fresh", "cache");
      return { status: "qualified", company: companyContext(row.company, row.checkedAt), source: "cache", reason: "cache_fresh" };
    case "provider_error":
      return outcome("unavailable", "cache_fresh", "cache");
    case "uncertain":
      return outcome("uncertain", "cache_fresh", "cache");
    default:
      return outcome(row.status, "cache_fresh", "cache");
  }
}

interface Plan {
  commit: Omit<CommitOutcome, "checkedAt">;
  result: ChildOutcome;
  counters: UsageCounter[];
  credits: { reported?: number; estimated?: number } | null;
}

function planFor(p: ProviderOutcome, policy: ChildRuntimeConfig["policy"], checkedAt: Date): Plan {
  switch (p.kind) {
    case "resolved": {
      const credits = {
        estimated: ESTIMATED_CREDITS_PER_DOMAIN,
        ...(p.creditsReported !== null ? { reported: p.creditsReported } : {}),
      };
      const q = qualify({ domain: p.domain, usageType: p.usageType }, policy);
      if (q.kind === "qualified") {
        const company: CacheCompany = { domain: p.domain, organisationName: p.organisationName, qualificationCategory: q.category };
        return {
          commit: { status: "qualified", company, ttlMs: policy.ttl_qualified_ms },
          result: { status: "qualified", company: companyContext(company, checkedAt), source: "provider", reason: q.reason },
          counters: ["domain_resolutions", "qualified_matches"],
          credits,
        };
      }
      if (q.kind === "excluded") {
        return {
          commit: { status: "excluded", company: null, ttlMs: policy.ttl_excluded_ms },
          result: outcome("excluded", q.reason, "provider"),
          counters: ["domain_resolutions", "excluded_results"],
          credits,
        };
      }
      return {
        commit: { status: "unknown", company: null, ttlMs: policy.ttl_unknown_ms },
        result: outcome("unknown", q.reason, "provider"),
        counters: ["domain_resolutions", "unknown_results"],
        credits,
      };
    }
    case "no_domain":
      return {
        commit: { status: "no_match", company: null, ttlMs: policy.ttl_no_match_ms },
        result: outcome("no_match", "provider_no_domain", "provider"),
        counters: ["no_matches"],
        credits: { estimated: 0, ...(p.creditsReported !== null ? { reported: p.creditsReported } : {}) },
      };
    case "timeout":
      // Dispatched but unanswered: billing is uncertain, so estimate conservatively.
      return {
        commit: { status: "uncertain", company: null, ttlMs: policy.ttl_uncertain_ms },
        result: outcome("uncertain", "provider_timeout", "provider"),
        counters: ["uncertain_outcomes"],
        credits: { estimated: ESTIMATED_CREDITS_PER_DOMAIN },
      };
    case "error": {
      let ttlMs = policy.ttl_provider_error_ms;
      if (p.category === "rate_limited" && p.retryAfterMs !== null) ttlMs = Math.max(ttlMs, Math.min(p.retryAfterMs, MAX_ERROR_TTL_MS));
      return {
        commit: { status: "provider_error", company: null, ttlMs },
        result: outcome("unavailable", `provider_error_${p.category}`, "provider"),
        counters: ["failures"],
        credits: null,
      };
    }
  }
}

export async function runJob(
  deps: PipelineDeps,
  config: ChildRuntimeConfig,
  job: ChildJobMessage,
  now: () => Date = () => new Date(),
): Promise<ChildOutcome> {
  const { cache, usage, controls, companies, activity, provider, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const policy = config.policy;
  const started = now().getTime();
  const scope: UsageScope = {
    installationId: config.installation_id,
    websiteId: config.website_id,
    periodKey: usagePeriodKey(policy.usage_period, now()),
  };

  let secret: Buffer | null = null;
  let fingerprint: Buffer | null = null;
  let key: CacheKey | null = null;
  let token: string | null = null;
  let dispatched = false;

  // Counters and credit estimates are best-effort: a failure, or a delay past
  // the accounting budget, must change neither a correct outcome nor the
  // activity write and response that the budget protects. A delayed operation
  // keeps running (tracked through onDeferred) and is logged as a timeout so
  // the usage snapshot can be reconciled; provider_attempts, reserved
  // atomically before dispatch, is the authoritative spend figure.
  const accounting = async (category: "usage_counter" | "usage_credits", op: () => Promise<void>): Promise<void> => {
    const budget = Math.min(ACCOUNTING_TIMEOUT_MS, job.deadline_at_ms - now().getTime() - ACCOUNTING_RESERVE_MS);
    if (budget <= 0) {
      logger.warn("db_error", { category: `${category}_skipped` });
      return;
    }
    let settled = false;
    const run = op().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
        logger.warn("db_error", { category });
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budget);
    });
    const r = await Promise.race([run.then(() => "done" as const), timeout]);
    clearTimeout(timer);
    if (r === "timeout" && !settled) {
      logger.warn("db_error", { category: `${category}_timeout` });
      deps.onDeferred?.(run);
    }
  };
  const count = (counter: UsageCounter) => accounting("usage_counter", () => usage.increment(scope, counter));
  const release = async () => {
    if (key && token) {
      const t = token;
      token = null;
      await repo(() => cache.release(key!, t));
    }
  };
  const finish = (o: ChildOutcome): ChildOutcome => {
    logger.info("child_job_finished", {
      status: o.status,
      ...(o.reason ? { reason: o.reason } : {}),
      source: o.source,
      duration_ms: now().getTime() - started,
    });
    return o;
  };

  /**
   * Durable company activity for a qualified outcome. Runs only for an
   * association this worker legitimately holds (a fresh cache row, or a
   * commit whose fence held), stays within the deadline, and reports failure
   * explicitly instead of claiming a record that was not written.
   */
  const recordActivity = async (o: ChildOutcome, companyId: number, source: ObservationSource, observedAt: Date): Promise<ChildOutcome> => {
    const base: ChildActivity = { company_id: companyId, previously_seen: null, recorded: false, observation_ref: job.observation_ref };
    const remaining = job.deadline_at_ms - now().getTime();
    if (remaining < ACTIVITY_MIN_REMAINING_MS) {
      logger.warn("activity_write_failed", { company_id: companyId, reason: "deadline_exceeded", source });
      return { ...o, activity: base };
    }
    try {
      // The write is bounded by the request deadline: a slow database yields a
      // qualified answer with recorded=false (not confirmed) instead of a lost answer.
      const write = activity.recordObservation({
        scope: { installationId: config.installation_id, websiteId: config.website_id },
        companyId,
        observationRef: job.observation_ref,
        source,
        observedAt,
      });
      const r = await new Promise<RecordObservationResult>((resolve, reject) => {
        const t = setTimeout(() => reject(new ActivityTimeoutError()), Math.max(1, remaining - ACTIVITY_DEADLINE_MARGIN_MS));
        write.then(
          (v) => {
            clearTimeout(t);
            resolve(v);
          },
          (e: unknown) => {
            clearTimeout(t);
            reject(e);
          },
        );
      });
      if (r.kind === "duplicate" && !r.sameCompany) {
        // The reference was spent on another company earlier: this request's activity is not recorded.
        logger.warn("activity_write_failed", { company_id: companyId, reason: "internal_error", source });
        return { ...o, activity: base };
      }
      logger.info("activity_recorded", { company_id: companyId, recorded: r.kind === "recorded", previously_seen: r.previouslySeen, source });
      return { ...o, activity: { ...base, previously_seen: r.previouslySeen, recorded: true } };
    } catch (err) {
      logger.warn("activity_write_failed", { company_id: companyId, reason: err instanceof ActivityTimeoutError ? "deadline_exceeded" : "database_error", source });
      return { ...o, activity: base };
    }
  };

  /** A fresh qualified cache row reuses the durable company identity and records activity; other rows record nothing. */
  const activityForRow = async (row: CacheRow): Promise<ChildOutcome> => {
    const o = outcomeFromCacheRow(row);
    if (o.status !== "qualified" || row.companyId === null) return o;
    return recordActivity(o, row.companyId, "cache", now());
  };

  logger.debug("child_job_started", { job_id: job.job_id });
  await count("resolver_requests");

  try {
    // 1. Canonicalise and classify. Ineligible addresses never touch the cache.
    const ip = canonicaliseIp(job.ip, { allowDocumentationRanges: config.policy.allow_documentation_ranges === true });
    if (!ip.ok) return finish(outcome("ineligible", "ip_invalid"));
    if (!ip.eligible) return finish(outcome("ineligible", "ip_ineligible"));

    // 2. Fingerprint.
    secret = decodeSecret(config.ip_hmac_secret);
    fingerprint = computeFingerprint(secret, config.installation_id, config.website_id, ip.canonical);
    secret.fill(0);
    key = { installationId: config.installation_id, websiteId: config.website_id, keyVersion: config.key_version, ipFingerprint: fingerprint };
    const k = key;

    // 3. Reserve. Liveness, expiry and takeover are decided by the database clock.
    const reservation = await repo(() => cache.reserve(k, { leaseMs: policy.lease_ms }));
    const reservedAt = now().getTime();
    logger.debug("reservation", { outcome: reservation.kind });
    if (reservation.kind === "fresh") {
      logger.debug("cache_lookup", { outcome: "hit" });
      // Durable activity first (bounded by the deadline), accounting after.
      const hit = await activityForRow(reservation.row);
      await count("cache_hits");
      return finish(hit);
    }
    if (reservation.kind === "pending") {
      const waitUntil = Math.min(job.deadline_at_ms - PENDING_MARGIN_MS, started + policy.pending_wait_ms);
      for (let t = now().getTime(); t < waitUntil; t = now().getTime()) {
        await sleep(Math.max(1, Math.min(policy.pending_poll_ms, waitUntil - t)));
        const row = await repo(() => cache.readFresh(k));
        if (row) {
          logger.debug("cache_lookup", { outcome: "hit_after_wait" });
          const hit = await activityForRow(row);
          await count("cache_hits");
          return finish(hit);
        }
      }
      logger.debug("cache_lookup", { outcome: "pending" });
      return finish(outcome("pending", "pending_other_worker"));
    }
    token = reservation.token;
    logger.debug("cache_lookup", { outcome: "miss" });

    // 4. Provider mode and runtime kill switch.
    if (config.provider.mode === "disabled") {
      await release();
      return finish(outcome("disabled", "provider_disabled"));
    }
    if (!(await repo(() => controls.isEnrichmentEnabled(config.installation_id)))) {
      await release();
      return finish(outcome("disabled", "kill_switch"));
    }

    // 5. Usage allowance (never undone once reserved).
    const allowance = await repo(() => usage.reserveProviderAttempt(scope, policy.period_call_cap));
    logger.info("usage_reservation", { outcome: allowance, period_key: scope.periodKey, cap: policy.period_call_cap });
    if (allowance !== "reserved") {
      await release();
      return finish(outcome("disabled", allowance === "cap_exhausted" ? "cap_exhausted" : "kill_switch"));
    }

    // 6. Bound the provider call by the lease (database-reported remaining
    //    duration, counted down locally) and the request deadline.
    const t0 = now().getTime();
    const timeoutMs = Math.floor(
      Math.min(
        config.provider.timeout_ms,
        reservation.leaseRemainingMs - (t0 - reservedAt) - LEASE_COMMIT_BUDGET_MS,
        job.deadline_at_ms - t0 - DEADLINE_COMMIT_BUDGET_MS,
      ),
    );
    if (!(timeoutMs >= MIN_PROVIDER_TIMEOUT_MS)) {
      await release();
      return finish(outcome("unavailable", "deadline_exceeded"));
    }

    // 7. Provider call.
    dispatched = true;
    const p = await provider.lookup(ip.canonical, { signal: AbortSignal.timeout(timeoutMs) });
    logger.info("provider_call", { duration_ms: now().getTime() - t0 });
    logger.info("provider_outcome", { outcome: p.kind, ...(p.kind === "error" ? { category: p.category } : {}) });

    // 8. Qualify, persist (fenced), count.
    const checkedAt = now();
    const plan = planFor(p, policy, checkedAt);
    // The fenced commit upserts the company itself, so a worker that lost its
    // lease never touches the shared companies row.
    const committed = await repo(() => cache.commitResolved(k, token!, { ...plan.commit, checkedAt }));
    token = null;
    if (committed.kind === "lost_lease") logger.warn("lease_lost", { job_id: job.job_id });

    // Activity is recorded only by the worker whose fence held: a stale or
    // lost-lease worker returns its answer to its caller but writes nothing.
    // It is persisted before the best-effort accounting so a slow counter can
    // never consume the budget reserved for the observation and the response.
    let result = plan.result;
    if (plan.result.status === "qualified" && committed.kind === "committed" && committed.companyId !== null) {
      result = await recordActivity(plan.result, committed.companyId, "provider", checkedAt);
    }
    for (const c of plan.counters) await count(c);
    if (plan.credits) {
      const credits = plan.credits;
      await accounting("usage_credits", () => usage.addProviderCredits(scope, credits));
    }
    return finish(result);
  } catch (err) {
    const isDb = err instanceof RepositoryError;
    logger.error(isDb ? "db_error" : "child_error", { category: isDb ? "repository" : "pipeline" });
    // Free the key for another worker only if nothing was dispatched.
    if (!dispatched) await release().catch(() => undefined);
    return finish(outcome("unavailable", isDb ? "database_error" : "internal_error"));
  } finally {
    secret?.fill(0);
    fingerprint?.fill(0);
    secret = null;
    fingerprint = null;
    key = null;
  }
}
