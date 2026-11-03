/**
 * Process entry point for the supervisor. Loads bounded configuration,
 * applies migrations, starts bounded cache maintenance, serves the API and
 * shuts down gracefully (stop accepting, drain, terminate and reap children).
 */
import { loadConfig, describeConfig, ConfigError } from "../config/index.js";
import { createLogger } from "../log/index.js";
import { createDb } from "../db/index.js";
import { applyMigrations } from "../db/migrate.js";
import { buildChildRuntimeConfig, createChildManager } from "./child-manager.js";
import { buildServer } from "../api/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, component: "supervisor" });
  const safe = describeConfig(config);
  logger.info("config_loaded", {
    installation_id: String(safe["INSTALLATION_ID"]),
    website_id: String(safe["WEBSITE_ID"]),
    cap: Number(safe["PERIOD_CALL_CAP"]),
    status: String(safe["PROVIDER_MODE"]),
    ready: safe["REPORTING_ENABLED"] === true,
  });

  const db = createDb({ databaseUrl: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 4, logger });
  if (config.RUN_MIGRATIONS_ON_START) await applyMigrations(db.pool, logger);

  const childManager = createChildManager({ config, logger, childRuntimeConfig: buildChildRuntimeConfig(config) });
  const app = await buildServer({ config, logger, childManager, ping: () => db.ping(), reporting: db.reporting });

  const prune = setInterval(() => {
    db.cache
      .pruneExpired(config.CACHE_PRUNE_BATCH)
      .then((rows) => {
        if (rows > 0) logger.info("cache_prune", { rows });
      })
      .catch(() => logger.warn("db_error", { category: "prune" }));
    // Observation retention (0 = keep). Companies and scope stats are never pruned.
    if (config.OBSERVATION_RETENTION_DAYS > 0) {
      const cutoff = new Date(Date.now() - config.OBSERVATION_RETENTION_DAYS * 86_400_000);
      db.activity
        .pruneObservationsBefore(cutoff, config.CACHE_PRUNE_BATCH)
        .then((rows) => {
          if (rows > 0) logger.info("observation_prune", { rows });
        })
        .catch(() => logger.warn("db_error", { category: "observation_prune" }));
    }
  }, config.CACHE_PRUNE_INTERVAL_S * 1000);
  prune.unref();

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
    clearInterval(prune);
    // Keep-alive connections that become idle after close() began would
    // otherwise hold the server open until the client's keep-alive timeout.
    const idleSweep = setInterval(() => app.server.closeIdleConnections(), 100);
    idleSweep.unref();
    try {
      await app.close();
    } catch {
      /* already closed */
    }
    clearInterval(idleSweep);
    await childManager.shutdown(config.SHUTDOWN_GRACE_MS);
    await db.close();
    logger.info("server_stopped", { active_children: childManager.activeCount() });
    await logger.flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info("server_started", { route: `${config.HOST}:${config.PORT}`, cap: childManager.capacity() });
}

main().catch((err: unknown) => {
  // ConfigError messages name variables, never values; anything else is generic.
  const detail = err instanceof ConfigError ? err.message : "startup failed (check configuration and database connectivity)";
  process.stderr.write(`id-resolver: ${detail}\n`);
  process.exit(1);
});
