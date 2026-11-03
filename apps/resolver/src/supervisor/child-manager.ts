/**
 * Fork-per-request child lifecycle (implements src/contracts/child-manager.ts).
 *
 * - Capacity is enforced synchronously before forking.
 * - The child gets an explicit minimal environment, no argv and no inspector
 *   flags; the IP and secrets travel only over the IPC channel.
 * - Every run resolves exactly once, and only after the child has exited and
 *   been reaped (or after a final safety interval following SIGKILL).
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESOLUTION_STATUSES, type CompanyContext, type ResolutionSource } from "../contracts/api.js";
import {
  ChildManagerOverloadedError,
  ChildManagerStoppedError,
  type ChildJobRequest,
  type ChildManager,
} from "../contracts/child-manager.js";
import { OBSERVATION_REF_PATTERN } from "../contracts/api.js";
import {
  CHILD_OUTCOME_REASONS,
  IPC_PROTOCOL_VERSION,
  isChildToSupervisorMessage,
  type ChildActivity,
  type ChildOutcome,
  type ChildOutcomeReason,
  type ChildRuntimeConfig,
  type SupervisorToChildMessage,
} from "../contracts/ipc.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../log/index.js";

/** After a result, a child that has not exited by itself is sent SIGTERM after this. */
const POST_RESULT_EXIT_MS = 500;

export interface ChildManagerOptions {
  config: Config;
  logger: Logger;
  childModulePath?: string;
  /** Defaults to buildChildRuntimeConfig(config). */
  childRuntimeConfig?: ChildRuntimeConfig;
}

export function buildChildRuntimeConfig(config: Config): ChildRuntimeConfig {
  const upper = (xs: string[]) => xs.map((x) => x.trim().toUpperCase()).filter((x) => x.length > 0);
  return {
    installation_id: config.INSTALLATION_ID,
    website_id: config.WEBSITE_ID,
    key_version: config.IP_HMAC_KEY_VERSION,
    ip_hmac_secret: config.IP_HMAC_SECRET,
    database_url: config.DATABASE_URL,
    database_ssl: config.DATABASE_SSL,
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
    log_level: config.LOG_LEVEL,
  };
}

/** dist/child/main.js in production; src/child/main.ts under tsx/vitest. */
export function defaultChildModulePath(): string {
  const ts = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(ts ? "../child/main.ts" : "../child/main.js", import.meta.url));
}

/** Per-child heap cap; children do not inherit NODE_OPTIONS (their env is minimal). */
const CHILD_HEAP_FLAG = "--max-old-space-size=128";

/** TypeScript children need the tsx loader; compiled children get only the heap cap. */
function execArgvFor(modulePath: string): string[] {
  if (!modulePath.endsWith(".ts")) return [CHILD_HEAP_FLAG];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return [CHILD_HEAP_FLAG, "--import", tsx];
}

const SOURCES: readonly ResolutionSource[] = ["cache", "provider", "none"];
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function sanitiseCompany(value: unknown): CompanyContext | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  const q = c["qualification"] as Record<string, unknown> | null | undefined;
  const org = c["organisation_name"];
  if (
    !isStr(c["domain"], 253) ||
    !(org === null || isStr(org, 200)) ||
    typeof q !== "object" ||
    q === null ||
    !isStr(q["category"], 32) ||
    q["source"] !== "provider_usage_type" ||
    !isStr(c["resolved_at"], 40) ||
    Number.isNaN(Date.parse(c["resolved_at"]))
  ) {
    return undefined;
  }
  return {
    domain: c["domain"],
    organisation_name: org,
    qualification: { category: q["category"], source: "provider_usage_type" },
    resolved_at: c["resolved_at"],
  };
}

/** Activity is optional and only meaningful on qualified outcomes; any malformed shape invalidates the message. */
function sanitiseActivity(value: unknown): ChildActivity | null | undefined {
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

/** Rebuilds an allowlisted outcome from an untrusted message, or null if invalid. */
export function sanitiseOutcome(value: unknown): ChildOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const status = o["status"];
  const source = o["source"];
  const reason = o["reason"];
  if (!(RESOLUTION_STATUSES as readonly unknown[]).includes(status)) return null;
  if (!(SOURCES as readonly unknown[]).includes(source)) return null;
  if (reason !== undefined && !(CHILD_OUTCOME_REASONS as readonly unknown[]).includes(reason)) return null;
  const company = sanitiseCompany(o["company"]);
  if (company === undefined) return null;
  if ((status === "qualified") !== (company !== null)) return null;
  const activity = sanitiseActivity(o["activity"]);
  if (activity === undefined) return null;
  if (activity !== null && status !== "qualified") return null;
  return {
    status: status as ChildOutcome["status"],
    company,
    source: source as ResolutionSource,
    ...(reason !== undefined ? { reason: reason as ChildOutcomeReason } : {}),
    ...(activity !== null ? { activity } : {}),
  };
}

const failure = (reason: "internal_error" | "deadline_exceeded"): ChildOutcome => ({
  status: "unavailable",
  company: null,
  source: "none",
  reason,
});

export function createChildManager(opts: ChildManagerOptions): ChildManager {
  const { config, logger } = opts;
  const modulePath = opts.childModulePath ?? defaultChildModulePath();
  const execArgv = execArgvFor(modulePath);
  const runtimeConfig = opts.childRuntimeConfig ?? buildChildRuntimeConfig(config);
  const graceMs = config.CHILD_HARD_KILL_GRACE_MS;
  const capacity = config.MAX_CONCURRENT_CHILDREN;
  const children = new Set<ChildProcess>();
  const exited = new WeakMap<ChildProcess, Promise<void>>();
  let stopped = false;

  const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

  const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!alive(child)) return;
    try {
      if (child.kill(signal)) logger.warn("child_killed", { signal, ...(child.pid ? { pid: child.pid } : {}) });
    } catch {
      // already gone
    }
  };

  function run(job: ChildJobRequest): Promise<ChildOutcome> {
    if (stopped) throw new ChildManagerStoppedError();
    if (children.size >= capacity) throw new ChildManagerOverloadedError();

    const jobId = randomUUID();
    const started = Date.now();
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, Math.max(0, ms)));

    let child: ChildProcess;
    try {
      child = fork(modulePath, [], {
        execArgv,
        env: { PATH: process.env["PATH"] ?? "", NODE_ENV: config.NODE_ENV, LOG_LEVEL: config.LOG_LEVEL },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        serialization: "json",
        windowsHide: true,
      });
    } catch {
      logger.error("child_error", { job_id: jobId, category: "spawn" });
      return Promise.resolve(failure("internal_error"));
    }
    children.add(child);
    logger.info("child_spawned", {
      job_id: jobId,
      ...(child.pid ? { pid: child.pid } : {}),
      ...(job.requestId ? { request_id: job.requestId } : {}),
      active_children: children.size,
    });

    return new Promise<ChildOutcome>((resolve) => {
      let outcome: ChildOutcome | null = null;
      let settled = false;
      let terminating = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        const o = outcome ?? failure("internal_error");
        logger.info("child_result", { job_id: jobId, status: o.status, ...(o.reason ? { reason: o.reason } : {}), duration_ms: Date.now() - started });
        resolve(o);
      };
      // Decide the outcome once; resolution waits for the child to be reaped.
      const decide = (o: ChildOutcome) => {
        if (outcome === null) outcome = o;
      };
      const terminate = (afterMs: number) => {
        if (terminating) return;
        terminating = true;
        later(afterMs, () => kill(child, "SIGTERM"));
        later(afterMs + graceMs, () => kill(child, "SIGKILL"));
        // Safety valve: never leave the caller hanging if 'exit' is somehow lost.
        later(afterMs + 3 * graceMs, settle);
      };

      exited.set(
        child,
        new Promise<void>((done) => {
          child.once("exit", (code, signal) => {
            children.delete(child);
            logger.info("child_exit", {
              job_id: jobId,
              ...(code !== null ? { exit_code: code } : {}),
              ...(signal !== null ? { signal } : {}),
              active_children: children.size,
            });
            decide(failure("internal_error"));
            settle();
            done();
          });
        }),
      );

      child.on("error", () => {
        logger.error("child_error", { job_id: jobId, category: "process" });
        decide(failure("internal_error"));
        if (child.pid === undefined) {
          // Spawn failed: there is no process to reap.
          children.delete(child);
          return settle();
        }
        terminate(0);
      });

      child.on("message", (msg: unknown) => {
        if (!isChildToSupervisorMessage(msg)) {
          decide(failure("internal_error"));
          return terminate(0);
        }
        if (msg.type === "ready") return;
        const sanitised = msg.job_id === jobId ? sanitiseOutcome(msg.outcome) : null;
        decide(sanitised ?? failure("internal_error"));
        terminate(sanitised ? POST_RESULT_EXIT_MS : 0);
      });

      later(job.deadlineAtMs - Date.now(), () => {
        if (outcome !== null) return;
        logger.warn("child_timeout", { job_id: jobId });
        decide(failure("deadline_exceeded"));
        terminate(0);
      });

      const send = (msg: SupervisorToChildMessage) => {
        try {
          child.send(msg, (err) => {
            if (err) {
              logger.error("child_error", { job_id: jobId, category: "ipc_send" });
              decide(failure("internal_error"));
              terminate(0);
            }
          });
        } catch {
          logger.error("child_error", { job_id: jobId, category: "ipc_send" });
          decide(failure("internal_error"));
          terminate(0);
        }
      };
      send({ v: IPC_PROTOCOL_VERSION, type: "config", config: runtimeConfig });
      send({ v: IPC_PROTOCOL_VERSION, type: "job", job_id: jobId, ip: job.ip, deadline_at_ms: job.deadlineAtMs, observation_ref: job.observationRef });
    });
  }

  async function shutdown(shutdownGraceMs: number): Promise<void> {
    stopped = true;
    const deadline = Date.now() + shutdownGraceMs;
    while (children.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    const survivors = [...children];
    for (const child of survivors) kill(child, "SIGKILL");
    const reaped = Promise.all(survivors.map((c) => exited.get(c) ?? Promise.resolve()));
    let cap: NodeJS.Timeout | undefined;
    await Promise.race([reaped, new Promise((r) => (cap = setTimeout(r, Math.max(graceMs, 1_000))))]);
    clearTimeout(cap);
  }

  return {
    activeCount: () => children.size,
    capacity: () => capacity,
    run,
    shutdown,
  };
}
