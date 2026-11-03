/**
 * Service entry point (single-process runtime, CHR-70 / owner decision D1).
 *
 * Loads bounded configuration, installs process-level crash containment and
 * the event-loop watchdog, refuses to start while the database has pending
 * migrations, builds the in-process job runner over one shared database
 * pool, serves the API, runs bounded cache and observation pruning,
 * and shuts down gracefully: stop accepting, answer in-flight requests, drain
 * executing jobs within SHUTDOWN_GRACE_MS, close the pool, exit.
 *
 * Exit codes: 0 graceful stop; 1 startup failure or shutdown overrun;
 * 70 fatal fault (process_fatal); 137 (SIGKILL) event loop blocked.
 */
import { loadConfig, describeConfig, ConfigError, scrubSecretEnv } from "./config/index.js";
import { createLogger } from "./log/index.js";
import { createDb } from "./db/index.js";
import { assertSchemaCurrent, PendingMigrationsError } from "./db/migrate.js";
import { createProvider } from "./provider/index.js";
import { buildServer } from "./api/server.js";
import { buildPipelineConfig, createRunner, poolSizeFor } from "./runtime/runner.js";
import { installProcessGuards } from "./runtime/process-guards.js";
import { startEventLoopWatchdog } from "./runtime/watchdog.js";

async function main(): Promise<void> {
  const config = loadConfig();
  scrubSecretEnv();
  const logger = createLogger({ level: config.LOG_LEVEL, component: "resolver" });
  const guards = installProcessGuards({ logger });
  const safe = describeConfig(config);
  logger.info("config_loaded", {
    installation_id: String(safe["INSTALLATION_ID"]),
    website_id: String(safe["WEBSITE_ID"]),
    cap: Number(safe["PERIOD_CALL_CAP"]),
    status: String(safe["PROVIDER_MODE"]),
    ready: safe["REPORTING_ENABLED"] === true,
  });

  const db = createDb({ databaseUrl: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: poolSizeFor(config.MAX_CONCURRENT_JOBS), logger });
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
    },
    logger,
    capacity: config.MAX_CONCURRENT_JOBS,
    // Every operation inside a job is bounded far below the stuck threshold:
    // a job still running there means the process state can no longer be trusted.
    onStuck: () => guards.fatal("job_stuck"),
  });
  const app = await buildServer({ config, logger, runner, ping: () => db.ping(), reporting: db.reporting });

  const prune = setInterval(() => {
    db.cache
      .pruneExpired(config.CACHE_PRUNE_BATCH)
      .then((rows) => {
        if (rows > 0) logger.info("cache_prune", { rows });
      })
      .catch(() => logger.warn("db_error", { category: "prune" }));
    // Observation retention: the bounded sync buffer (D3). Companies and scope stats are never pruned.
    const cutoff = new Date(Date.now() - config.OBSERVATION_RETENTION_DAYS * 86_400_000);
    db.activity
      .pruneObservationsBefore(cutoff, config.CACHE_PRUNE_BATCH)
      .then((rows) => {
        if (rows > 0) logger.info("observation_prune", { rows });
      })
      .catch(() => logger.warn("db_error", { category: "observation_prune" }));
  }, config.CACHE_PRUNE_INTERVAL_S * 1000);
  prune.unref();

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
    clearInterval(prune);
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
}

main().catch((err: unknown) => {
  // ConfigError messages name variables, never values; PendingMigrationsError
  // names migration files only; anything else is generic.
  const detail = err instanceof ConfigError || err instanceof PendingMigrationsError ? err.message : "startup failed (check configuration and database connectivity)";
  process.stderr.write(`id-resolver: ${detail}\n`);
  process.exit(1);
});
