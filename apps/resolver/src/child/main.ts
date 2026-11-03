/**
 * Child process entry. Forked by the supervisor with an IPC channel; receives
 * exactly one "config" message then exactly one "job" message, answers with
 * one "result" message and exits. The IP and secrets arrive only over IPC.
 *
 * Exit codes: 0 done, 1 internal failure, 2 no IPC channel, 3 startup or job
 * deadline elapsed, 4 supervisor disconnected.
 */
import { z } from "zod";
import { createDb, type Db } from "../db/index.js";
import {
  IPC_PROTOCOL_VERSION,
  isSupervisorToChildMessage,
  type ChildJobMessage,
  type ChildOutcome,
  type ChildResultMessage,
  type ChildRuntimeConfig,
} from "../contracts/ipc.js";
import { createLogger, type Logger } from "../log/index.js";
import { createProvider } from "../provider/index.js";
import { runJob } from "./pipeline.js";

const STARTUP_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 1_000;
const EXIT_FLUSH_MS = 250;
const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug"]);

const ttl = z.number().int().nonnegative();
const RuntimeConfigSchema = z.object({
  installation_id: z.string().min(1).max(63),
  website_id: z.string().min(1).max(63),
  key_version: z.number().int().positive(),
  ip_hmac_secret: z.string().min(32).max(512),
  database_url: z.string().min(1).max(2048),
  database_ssl: z.enum(["require", "disable", "no-verify"]).optional(),
  provider: z.object({
    mode: z.enum(["live", "mock", "disabled"]),
    base_url: z.string().max(512),
    api_key: z.string().max(512),
    auth_header: z.string().max(64),
    timeout_ms: z.number().int().positive(),
  }),
  policy: z.object({
    ttl_qualified_ms: ttl,
    ttl_no_match_ms: ttl,
    ttl_excluded_ms: ttl,
    ttl_unknown_ms: ttl,
    ttl_provider_error_ms: ttl,
    ttl_uncertain_ms: ttl,
    lease_ms: z.number().int().positive(),
    pending_wait_ms: ttl,
    pending_poll_ms: z.number().int().positive(),
    period_call_cap: ttl,
    usage_period: z.enum(["day", "month"]),
    qualified_usage_types: z.array(z.string().max(32)).max(64),
    excluded_usage_types: z.array(z.string().max(32)).max(64),
    denied_domains: z.array(z.string().max(253)).max(10_000),
    allow_documentation_ranges: z.boolean().optional(),
  }),
  log_level: z.string().max(16),
});

const failure = (reason: "internal_error" | "deadline_exceeded"): ChildOutcome => ({
  status: "unavailable",
  company: null,
  source: "none",
  reason,
});

function sslModeFor(config: Pick<ChildRuntimeConfig, "database_url" | "database_ssl">): "require" | "disable" | "no-verify" {
  try {
    const host = new URL(config.database_url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "disable";
  } catch {
    // fall through to the configured mode
  }
  return config.database_ssl ?? "require";
}

function main(): void {
  if (typeof process.send !== "function") process.exit(2);
  process.title = "id-resolver-child";

  let config: ChildRuntimeConfig | null = null;
  let job: ChildJobMessage | null = null;
  let resultSent = false;
  let exiting = false;
  let deadlineTimer: NodeJS.Timeout | undefined;

  const sendResult = (outcome: ChildOutcome): Promise<void> => {
    if (resultSent || !job) return Promise.resolve();
    resultSent = true;
    const msg: ChildResultMessage = { v: IPC_PROTOCOL_VERSION, type: "result", job_id: job.job_id, outcome };
    return new Promise((resolve) => {
      try {
        process.send!(msg, undefined, {}, () => resolve());
      } catch {
        resolve(); // channel already closed (EPIPE / ERR_IPC_CHANNEL_CLOSED)
      }
    });
  };

  const die = (code: number, outcome?: ChildOutcome): void => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(code), EXIT_FLUSH_MS).unref();
    void (outcome ? sendResult(outcome) : Promise.resolve()).finally(() => process.exit(code));
  };

  const startupTimer = setTimeout(() => die(3), STARTUP_TIMEOUT_MS);

  process.on("uncaughtException", () => die(1, failure("internal_error")));
  process.on("unhandledRejection", () => die(1, failure("internal_error")));
  process.on("disconnect", () => die(4));

  const run = async (cfg: ChildRuntimeConfig, j: ChildJobMessage): Promise<void> => {
    let db: Db | null = null;
    let logger: Logger | null = null;
    let code = 0;
    // Accounting operations that ran past their budget: awaited (bounded) after
    // the result is sent, before the pool closes, so nothing runs untracked.
    const deferred: Promise<void>[] = [];
    try {
      logger = createLogger({ level: LOG_LEVELS.has(cfg.log_level) ? cfg.log_level : "info", component: "child" });
      db = createDb({ databaseUrl: cfg.database_url, ssl: sslModeFor(cfg), max: 2, logger });
      const provider = createProvider(cfg.provider);
      const outcome = await runJob(
        {
          cache: db.cache,
          usage: db.usage,
          controls: db.controls,
          companies: db.companies,
          activity: db.activity,
          provider,
          logger,
          onDeferred: (op) => deferred.push(op),
        },
        cfg,
        j,
      );
      await sendResult(outcome);
      if (deferred.length > 0) {
        await Promise.race([Promise.allSettled(deferred), new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS).unref())]);
      }
    } catch {
      code = 1;
      logger?.error("child_error", { category: "child_main" });
      await sendResult(failure("internal_error"));
    } finally {
      if (db) {
        const closing = db.close();
        await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS).unref())]);
      }
      await logger?.flush().catch(() => undefined);
    }
    clearTimeout(deadlineTimer);
    die(code);
  };

  process.on("message", (msg: unknown) => {
    if (exiting || !isSupervisorToChildMessage(msg)) return;
    if (msg.type === "config") {
      if (config !== null || job !== null) return;
      const parsed = RuntimeConfigSchema.safeParse(msg.config);
      if (!parsed.success) return die(1);
      config = parsed.data as ChildRuntimeConfig;
      return;
    }
    if (job !== null) return;
    job = msg;
    clearTimeout(startupTimer);
    if (config === null) return die(1, failure("internal_error"));
    deadlineTimer = setTimeout(() => die(3, failure("deadline_exceeded")), Math.max(0, job.deadline_at_ms - Date.now()));
    const cfg = config;
    config = null; // drop the only long-lived reference to the secrets
    void run(cfg, job);
  });
}

main();
