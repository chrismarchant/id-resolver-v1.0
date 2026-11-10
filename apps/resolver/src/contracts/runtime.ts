/**
 * In-process runtime contract (CHR-70, owner decision D1). Replaces the V0.1
 * supervisor <-> child IPC contract: resolution jobs now run inside the
 * service process, bounded by a concurrency semaphore and a per-request
 * deadline (src/runtime/runner.ts). The API layer depends only on `Runner`.
 *
 * Nothing in an outcome may carry a raw IP, a fingerprint, a secret, free
 * text, a raw provider payload or company identity beyond the internal
 * company id: only allowlisted statuses and reasons (owner decision D2).
 */
import type { HostingRangesMode } from "../ip/hosting-ranges.js";
import type { ResolutionSource, ResolutionStatus } from "./api.js";
import type { ObservationContext } from "./db.js";

/** Policy and secrets the pipeline needs; built once from the validated configuration. */
export interface PipelineConfig {
  installation_id: string;
  website_id: string;
  key_version: number;
  /** Server-only HMAC secret (hex or base64url); decoded per job into a Buffer that is zeroed after use. */
  ip_hmac_secret: string;
  provider: {
    mode: "live" | "mock" | "disabled";
    base_url: string;
    api_key: string;
    auth_header: string;
    timeout_ms: number;
  };
  policy: {
    ttl_qualified_ms: number;
    ttl_no_match_ms: number;
    ttl_excluded_ms: number;
    ttl_unknown_ms: number;
    ttl_provider_error_ms: number;
    ttl_uncertain_ms: number;
    lease_ms: number;
    /** Max time a job may wait for another worker's pending lookup. */
    pending_wait_ms: number;
    pending_poll_ms: number;
    period_call_cap: number;
    /** Calls per period that may be charged; a slot is given back when the answer proves no charge. */
    period_resolved_cap: number;
    usage_period: "day" | "month";
    /** Usage-type codes that qualify a domain as an employer/organisation association. */
    qualified_usage_types: string[];
    /** Usage-type codes that mark the result as a network owner (never a company association). */
    excluded_usage_types: string[];
    /** Domains never associated (case-insensitive exact match). */
    denied_domains: string[];
    /**
     * Network-owner guard (src/resolution/qualify.ts): a qualifying usage type is excluded when the organisation is
     * the network operator (by name, or by the provider's ISP field) and its name does not belong to the domain.
     * Default true.
     */
    network_owner_guard?: boolean;
    /** Treat RFC 5737/3849 documentation ranges as eligible (tests only; default false). */
    allow_documentation_ranges?: boolean;
    /** Published cloud and crawler ranges: off (default), shadow (log only) or enforce (exclude without a lookup). */
    hosting_ranges_mode?: HostingRangesMode;
  };
}

/** One resolution job as the pipeline sees it. */
export interface ResolutionJob {
  /** Random per-job correlation id for logs; never derived from the IP. */
  job_id: string;
  /** Originating IP as received (already length-bounded and syntax-checked by the API layer). Transient. */
  ip: string;
  /** Absolute wall-clock deadline (ms since epoch). */
  deadline_at_ms: number;
  /** Opaque idempotency reference for the observation this job may record (the entrance_id); never the IP. */
  observation_ref: string;
  /** Entrance evidence stored with the observation. */
  context: ObservationContext;
  /**
   * Aborted by the runner at the deadline. The pipeline stops at its next
   * checkpoint, aborts an in-flight provider call and never starts the
   * activity write once it is aborted. Optional for direct (test) callers.
   */
  signal?: AbortSignal;
}

/** Durable activity outcome for a qualified resolution. Never carries an IP, a fingerprint or a payload. */
export interface ObservationActivity {
  company_id: number;
  /** null when the write failed or was not confirmed (unknown). */
  previously_seen: boolean | null;
  /** true when the write was confirmed in time; false = not confirmed (a late write may still commit, CHR-66 F4). */
  recorded: boolean;
  observation_ref: string;
}

export interface ResolutionOutcome {
  status: ResolutionStatus;
  source: ResolutionSource;
  /** Allowlisted diagnostic reason; never free text from the provider. */
  reason?: OutcomeReason;
  /** Present only for qualified outcomes. */
  activity?: ObservationActivity;
}

export const OUTCOME_REASONS = [
  "cache_fresh",
  "provider_resolved",
  "provider_no_domain",
  "provider_excluded_usage_type",
  "provider_unknown_usage_type",
  "provider_denied_domain",
  "provider_network_owner",
  "provider_timeout",
  "provider_error_auth",
  "provider_error_credits",
  "provider_error_rate_limited",
  "provider_error_server",
  "provider_error_network",
  "provider_error_malformed",
  "pending_other_worker",
  "lease_lost",
  "cap_exhausted",
  "kill_switch",
  "provider_disabled",
  "ip_ineligible",
  "ip_invalid",
  "ip_hosting_range",
  "deadline_exceeded",
  "database_error",
  "internal_error",
  "activity_write_failed",
] as const;

export type OutcomeReason = (typeof OUTCOME_REASONS)[number];

/** What the API layer hands the runner. */
export interface JobRequest {
  /** Raw IP string as validated by the API layer (length-bounded, literal only). */
  ip: string;
  /** Absolute wall-clock deadline in ms since epoch. */
  deadlineAtMs: number;
  /** Opaque observation reference (the validated entrance_id); never the IP. */
  observationRef: string;
  /** Validated entrance evidence. */
  context: ObservationContext;
}

export class RunnerOverloadedError extends Error {
  constructor() {
    super("runner at capacity");
    this.name = "RunnerOverloadedError";
  }
}

export class RunnerStoppedError extends Error {
  constructor() {
    super("runner is shutting down");
    this.name = "RunnerStoppedError";
  }
}

export interface Runner {
  /** Jobs currently executing (admitted and not yet settled, including jobs past their deadline). */
  activeCount(): number;
  /** Configured bound (MAX_CONCURRENT_JOBS). */
  capacity(): number;
  /**
   * Admit and run exactly one job in this process. Throws RunnerOverloadedError
   * synchronously when every slot is taken, or RunnerStoppedError after
   * shutdown began. Otherwise the promise ALWAYS resolves, never later than
   * the job's deadline: a throwing, rejecting, malformed or overrunning job
   * resolves to `{ status: "unavailable", source: "none", reason }`.
   * The slot stays taken until the job itself settles, so a job that
   * overruns its deadline still counts against capacity.
   */
  run(job: JobRequest): Promise<ResolutionOutcome>;
  /**
   * Stop admitting jobs, then wait up to graceMs for executing jobs and their
   * tracked background writes to settle. Resolves with what was left.
   */
  shutdown(graceMs: number): Promise<{ drained: boolean; activeJobs: number; pendingWrites: number }>;
}
