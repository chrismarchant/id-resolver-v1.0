import type {
  ActivityRepository,
  CacheRepository,
  CompanyRepository,
  ControlsRepository,
  ReportingRepository,
  UsageRepository,
} from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { createActivityRepository } from "./activity-repo.js";
import { createCacheRepository } from "./cache-repo.js";
import { createCompanyRepository } from "./company-repo.js";
import { createControlsRepository } from "./controls-repo.js";
import { createPool, type Pool, type SslMode } from "./pool.js";
import { createReportingRepository } from "./reporting-repo.js";
import { createUsageRepository } from "./usage-repo.js";

const PING_TIMEOUT_MS = 1_000;

export interface Db {
  pool: Pool;
  cache: CacheRepository;
  usage: UsageRepository;
  controls: ControlsRepository;
  companies: CompanyRepository;
  activity: ActivityRepository;
  reporting: ReportingRepository;
  /** SELECT 1 with a 1 s timeout; false on any error. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(opts: { databaseUrl: string; ssl: SslMode; max?: number; logger?: Logger }): Db {
  const pool = createPool({
    databaseUrl: opts.databaseUrl,
    ssl: opts.ssl,
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  });
  const logger = opts.logger;
  return {
    pool,
    cache: createCacheRepository(pool, logger),
    usage: createUsageRepository(pool, logger),
    controls: createControlsRepository(pool, logger),
    companies: createCompanyRepository(pool, logger),
    activity: createActivityRepository(pool, logger),
    reporting: createReportingRepository(pool, logger),
    async ping() {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ping timeout")), PING_TIMEOUT_MS);
        });
        // The losing query keeps running in the background but is bounded by
        // the pool's statement_timeout.
        await Promise.race([pool.query("SELECT 1"), timeout]);
        return true;
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
}

export { applyMigrations } from "./migrate.js";
export { DbError, createPool } from "./pool.js";
export type { Pool, SslMode } from "./pool.js";
