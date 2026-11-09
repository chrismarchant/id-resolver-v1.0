/**
 * Service entry point (single-process runtime, CHR-70 / owner decision D1).
 *
 * Loads bounded configuration, installs process-level crash containment and
 * the event-loop watchdog, connects with the database TLS policy and (with
 * role separation) as the least-privilege runtime role, refusing to start when
 * that login is not least-privilege, refuses to start while the database has
 * pending migrations, builds the in-process job runner over one shared database
 * pool, serves the API, runs the maintenance loop (expired cache rows and
 * observation retention, drained in bounded batches within a time budget,
 * once at startup and then every CACHE_PRUNE_INTERVAL_S; never overlapping),
 * and shuts down gracefully: stop accepting, answer in-flight requests, drain
 * executing jobs within SHUTDOWN_GRACE_MS, close the pool, exit.
 *
 * Exit codes: 0 graceful stop; 1 startup failure or shutdown overrun;
 * 70 fatal fault (process_fatal); 137 (SIGKILL) event loop blocked.
 */
import { loadConfig, describeConfig, ConfigError, scrubSecretEnv, resolveDatabaseTls, resolveRuntimeCredentials, configOverrides } from "./config/index.js";
import { createLogger } from "./log/index.js";
import { createDb } from "./db/index.js";
import { DbError, guarded } from "./db/pool.js";
import { checkConnectedRolePrivileges, RuntimeRoleError } from "./db/runtime-role.js";
import { assertSchemaCurrent, PendingMigrationsError } from "./db/migrate.js";
import { createFeedRetention } from "./db/retention.js";
import { createProvider } from "./provider/index.js";
import { HostingRangesError, loadHostingRanges } from "./ip/hosting-ranges.js";
import { buildServer } from "./api/server.js";
import { EVENT_WRITES_MAX_IN_FLIGHT } from "./api/events.js";
import { buildPipelineConfig, createRunner, poolSizeFor } from "./runtime/runner.js";
import { createMaintenance } from "./runtime/maintenance.js";
import { installProcessGuards } from "./runtime/process-guards.js";
import { startEventLoopWatchdog } from "./runtime/watchdog.js";

async function main(): Promise<void> {
  const config = loadConfig();
  scrubSecretEnv();
  const logger = createLogger({ level: config.LOG_LEVEL, component: "resolver" });
  const guards = installProcessGuards({ logger });
  // Read once, before anything connects: a damaged ranges file fails the start (HostingRangesError).
  const hostingRanges = config.HOSTING_RANGES_MODE === "off" ? undefined : loadHostingRanges();
  const safe = describeConfig(config);
  logger.info("config_loaded", {
    installation_id: String(safe["INSTALLATION_ID"]),
    website_id: String(safe["WEBSITE_ID"]),
    cap: Number(safe["PERIOD_CALL_CAP"]),
    resolved_cap: config.PERIOD_RESOLVED_CAP ?? config.PERIOD_CALL_CAP,
    status: String(safe["PROVIDER_MODE"]),
    ready: safe["REPORTING_ENABLED"] === true,
    events_enabled: config.EVENTS_ENABLED,
    event_consent_mode: config.EVENT_CONSENT_MODE,
    tls_mode: config.DATABASE_SSL,
    db_role: config.DATABASE_RUNTIME_PASSWORD !== undefined ? "runtime" : "owner",
    hosting_ranges_mode: config.HOSTING_RANGES_MODE,
    ...(hostingRanges ? { hosting_ranges_date: hostingRanges.generatedAt } : {}),
  });
  // Dev-only overrides (names only): "active" relaxes a production control now, "inert" is set without effect.
  for (const o of configOverrides(config)) logger.warn("config_override", { variable: o.variable, outcome: o.state });

  // Browser-event writes (event.v1) get their own connections when enabled, so they never compete with resolution jobs.
  const eventWriteSlots = config.EVENTS_ENABLED ? EVENT_WRITES_MAX_IN_FLIGHT : 0;
  // Role separation: with DATABASE_RUNTIME_PASSWORD the service logs in as the
  // least-privilege runtime role (same host and database as DATABASE_URL);
  // DATABASE_URL's own user (the owner) is used only by migrate and ops.
  const runtimeCredentials = resolveRuntimeCredentials(config);
  const db = createDb({
    databaseUrl: config.DATABASE_URL,
    ssl: resolveDatabaseTls(config),
    ...(runtimeCredentials ? { credentials: runtimeCredentials } : {}),
    max: poolSizeFor(config.MAX_CONCURRENT_JOBS, eventWriteSlots),
    logger,
  });
  if (runtimeCredentials) {
    // Fail closed if the runtime login can bypass the feed guards (owner,
    // superuser, TRUNCATE/TRIGGER, DDL, session_replication_role, membership).
    const excess = await guarded(logger, () => checkConnectedRolePrivileges(db.pool));
    if (excess.length > 0) {
      logger.error("database_role_check", { outcome: "refused", reason: excess.join(",") });
      throw new RuntimeRoleError("RUNTIME_ROLE_PRIVILEGED", excess);
    }
    logger.info("database_role_check", { outcome: "least_privilege" });
  }
  // Migrations never run on start (they are the deploy pre-step). Fail closed
  // while this build's migrations are not all applied.
  const schema = await assertSchemaCurrent(db.pool, logger);
  logger.info("migration_check", { outcome: schema.unknown.length > 0 ? "database_ahead" : "current", count: schema.unknown.length });

  const pipelineConfig = buildPipelineConfig(config);
  const runner = createRunner({
    config: pipelineConfig,
    deps: {
      cache: db.cache,
      usage: db.usage,
      controls: db.controls,
      companies: db.companies,
      activity: db.activity,
      provider: createProvider(pipelineConfig.provider),
      ...(hostingRanges ? { hostingRanges } : {}),
    },
    logger,
    capacity: config.MAX_CONCURRENT_JOBS,
    // Every operation inside a job is bounded far below the stuck threshold:
    // a job still running there means the process state can no longer be trusted.
    onStuck: () => guards.fatal("job_stuck"),
  });
  const app = await buildServer({ config, logger, runner, ping: () => db.ping(), reporting: db.reporting, events: db.events });

  // Expired cache rows, browser events and observation retention (the bounded
  // sync buffer, D3), drained in bounded batches within a per-run budget.
  // Companies, scope stats, deduplication records and tombstones are never
  // pruned. Started after listen.
  const maintenance = createMaintenance({
    pruneExpiredCache: (limit) => db.cache.pruneExpired(limit),
    retention: createFeedRetention(db.pool, logger),
    // Browser events (event.v1) share the observation window; pruned even while
    // EVENTS_ENABLED=false, so rows from an earlier enabled period still age out.
    pruneEventsBefore: (cutoff, limit) => db.events.pruneBefore(cutoff, limit),
    logger,
    batch: config.CACHE_PRUNE_BATCH,
    retentionDays: config.OBSERVATION_RETENTION_DAYS,
    budgetMs: config.CACHE_PRUNE_BUDGET_MS,
  });

  const watchdog = startEventLoopWatchdog({ thresholdMs: config.EVENT_LOOP_BLOCK_EXIT_MS });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("server_stopping", { signal });
    const hardExit = setTimeout(() => {
      logger.error("shutdown_timeout", { duration_ms: config.SHUTDOWN_GRACE_MS + 2_000 });
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS + 2_000);
    hardExit.unref();
    const until = Date.now() + config.SHUTDOWN_GRACE_MS;
    // Ends the schedule; a running maintenance run stops after its current batch.
    const maintenanceStopped = maintenance.stop();
    // Keep-alive connections that become idle after close() began would
    // otherwise hold the server open until the client's keep-alive timeout.
    const idleSweep = setInterval(() => app.server.closeIdleConnections(), 100);
    idleSweep.unref();
    try {
      // Stops accepting and waits for in-flight requests, each answered by its deadline.
      await app.close();
    } catch {
      /* already closed */
    }
    clearInterval(idleSweep);
    // Jobs that overran their deadline, and writes that outlived their budget, get the rest of the grace period.
    const drain = await runner.shutdown(Math.max(0, until - Date.now()));
    await maintenanceStopped;
    await db.close();
    await watchdog.stop();
    logger.info("server_stopped", { outcome: drain.drained ? "drained" : "grace_exceeded", active_jobs: drain.activeJobs });
    await logger.flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info("server_started", { route: `${config.HOST}:${config.PORT}`, cap: runner.capacity() });
  // First run now, without waiting one interval (a service restarted more often
  // than the interval would otherwise never prune); not awaited, never overlapping.
  maintenance.start(config.CACHE_PRUNE_INTERVAL_S * 1000);
}

/** Startup failure text: names variables, files or fixed codes, never a value, a host or a URL. */
function startupFailureDetail(err: unknown): string {
  if (err instanceof ConfigError || err instanceof PendingMigrationsError) return err.message;
  if (err instanceof HostingRangesError) return `${err.message} in data/hosting-ranges.json (HOSTING_RANGES_MODE is not off): regenerate it with scripts/update-hosting-ranges.mjs, or set HOSTING_RANGES_MODE=off`;
  if (err instanceof RuntimeRoleError) {
    const settings = err.reasons.includes("role_settings") ? "; role_settings are session defaults stored on the role (ALTER ROLE ... SET): the migrate step resets them, so redeploy" : "";
    return `the runtime database role is not least-privilege (${err.reasons.join(", ")}): check DATABASE_RUNTIME_ROLE; it must be the role the migrate step provisions, never the owner${settings}`;
  }
  if (err instanceof DbError && err.code === "28P01") {
    return "database authentication failed (28P01): if DATABASE_RUNTIME_PASSWORD is set, the pre-deploy migrate must have run with the same value (it sets the runtime role's password)";
  }
  if (err instanceof DbError && err.code.startsWith("DB_TLS_")) {
    return (
      `database TLS verification failed (${err.code}): check DATABASE_SSL, DATABASE_TLS_PIN_SHA256 and DATABASE_CA_CERT ` +
      "(node dist/ops/db-tls-fingerprint.js prints the certificate the server presents)"
    );
  }
  return "startup failed (check configuration and database connectivity)";
}

main().catch((err: unknown) => {
  const detail = startupFailureDetail(err);
  process.stderr.write(`id-resolver: ${detail}\n`);
  process.exit(1);
});
